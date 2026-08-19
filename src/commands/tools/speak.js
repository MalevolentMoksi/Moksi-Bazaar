// ENHANCED SPEAK.JS - DeepSeek V3 + Relationship-Aware Context
const { SlashCommandBuilder, ComponentType } = require('discord.js');

const {
  isUserBlacklisted,
  getSettingState,
  getUserContext,
  getUserContextsBulk,
  getSpeakProfile,
  getSpeakConfigValue,
  updateUserPreferences,
  updateUserAttitudeWithAI,
  storeConversationMemory,
  getRecentMemories,
  processMediaInMessage,
  getSpeakProfilesBulk,
  applyAttitudeSignal
} = require('../../utils/db.js');
const { maybeDistillProfile } = require('../../utils/speakProfile');
const {
  normalisePipeline, readRoom, readBlock, pickBestDraft, attitudeSentence,
  factualPanel, FACTUAL_MODES,
} = require('../../utils/speakPipeline');
const { creditVeto } = require('../../utils/interjections');
const telemetry = require('../../utils/telemetry');

const { callOpenRouterAPI } = require('../../utils/apiHelpers');
const { handleCommandError, sendError } = require('../../utils/errorHandler');
const {
  REACTION_EMOJI,
  REACTION_FALLBACK,
  ATTITUDE_INSTRUCTIONS,
  SPEAK_DISABLED_REPLIES,
  MEMORY_LIMITS,
  SENTIMENT_THRESHOLDS,
  BOT_IDENTITY,
  botCapabilities,
  isOwner
} = require('../../utils/constants');
const { emojiFor, emojiHints, emojiKeys } = require('../../utils/emojiRegistry');
const { commandNamesFor } = require('../../utils/commandScope');
const logger = require('../../utils/logger');

// ── LATENCY BUDGET ──────────────────────────────────────────────────────────
// The pipeline's extra steps are luxuries, not dependencies: the pre-pass and
// the judge each run only when the clock allows, so the reply can degrade to
// a single unjudged draft but can never stack timeouts past the deadline.
const REPLY_DEADLINE_MS = 20_000;
/**
 * Interjections get a longer one. Nobody asked, so nobody is watching a
 * typing indicator wondering whether the bot died; the only cost of taking
 * longer is that the conversation may have moved, and the remark is posted as
 * a Discord reply to the message that prompted it, which keeps it anchored.
 * Still bounded, because an unbounded path is one that hangs.
 */
const INTERJECTION_DEADLINE_MS = 40_000;
/** After this much has already been spent (a cold video, a slow fetch), the
 *  pre-pass is skipped rather than making a late reply later. */
const PREPASS_LATEST_START_MS = 8_000;
/** The pre-pass on a LIVE reply gets this long, no more. It writes ~60 tokens
 *  of JSON; a healthy call is done in under two seconds, and a reply aiming
 *  at six seconds total cannot donate more than this to guidance. */
const REPLY_PREPASS_TIMEOUT_MS = 3_500;
/** Ceiling on any single draft during a live reply. The panel runs in
 *  parallel, so this is the whole stage's worst case, and a writer that
 *  cannot produce two sentences in eight seconds was routed somewhere bad. */
const WRITER_TIMEOUT_CAP_MS = 8_000;
/** The judge needs at least this much runway to be worth consulting. */
const JUDGE_MIN_BUDGET_MS = 4_000;
/** Fresh media analysis stops starting once this much of the reply window is
 *  spent; anything still unanalysed goes out as an honest "not seen" tag and
 *  is picked up next time. Cached descriptions are exempt: they are free.
 *  Interjections only: nobody is watching that clock. */
const MEDIA_STAGE_BUDGET_MS = 12_000;
/** Live replies get half of it, for the same reason the pre-pass is capped:
 *  the target is an answer in ~6 seconds, and a cold video cannot be allowed
 *  to spend twice that before a single word is generated. */
const REPLY_MEDIA_BUDGET_MS = 6_000;
/** Extra runway for the media on the message that actually summoned the reply.
 *  Everything else on screen shares the budget above; the clip someone just
 *  replied to the bot with is the one thing worth being a little late for,
 *  since being early about it means answering as though they sent nothing. */
const PRIORITY_MEDIA_GRACE_MS = 4_000;
/** Memory v2 shows this many raw exchange pairs; profiles carry the rest. */
const MEMORY_V2_RAW_PAIRS = 2;

// ── HELPERS ─────────────────────────────────────────────────────────────────
// Strip the citation scaffolding the bot prepends to its own replies, so the
// AI sees its previous reply as clean prose rather than Discord markup.
function cleanBotOwnMessage(content) {
  if (!content) return '';
  // Remove leading "-# <@id> :" citation line + the "-# *"quoted"*" lines that follow
  return content
    .replace(/^-# <@!?\d+>\s*:\s*\n(?:-# \*".*?"\*\s*\n?)*\s*/s, '')
    .trim();
}

const flatten = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Discord renders `<t:1754003000:F>` as a local date, but the model receives
 * the raw token and can do nothing with it. Rich embeds (the join-gate log
 * especially) are full of them, so swap in something readable.
 */
function readableTimestamps(text) {
  return String(text ?? '').replace(/<t:(\d{1,15})(?::[tTdDfFR])?>/g, (whole, secs) => {
    const ms = Number(secs) * 1000;
    if (!Number.isFinite(ms)) return whole;
    const iso = new Date(ms).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  });
}

/**
 * Renders the readable text of a message's embeds.
 *
 * Without this the model sees an empty string for any embed-only message: the
 * bot's own rich output (the join-gate log, for one), other bots' embeds, and
 * every link preview. `msg.content` is empty in all of those cases.
 *
 * Works on both Message and MessageSnapshot, which share the `embeds` shape.
 */
function describeEmbeds(msg, charLimit) {
  const embeds = msg?.embeds;
  if (!embeds?.length) return '';

  const rendered = [];
  for (const e of embeds.slice(0, 3)) {
    const bits = [];
    if (e.author?.name) bits.push(e.author.name);
    if (e.title) bits.push(e.title);
    if (e.description) bits.push(e.description);
    for (const f of (e.fields ?? []).slice(0, 10)) bits.push(`${f.name}: ${f.value}`);
    if (e.footer?.text) bits.push(e.footer.text);

    const text = flatten(readableTimestamps(bits.join(' | ')));
    if (text) rendered.push(text);
  }

  if (rendered.length === 0) return '';
  return ` [embed: ${rendered.join(' || ').slice(0, charLimit)}]`;
}

/**
 * Renders forwarded message content. Discord puts nothing in `content` for a
 * forward; the real payload lives in `messageSnapshots`.
 */
function describeForwarded(msg, charLimit) {
  const snapshots = msg?.messageSnapshots;
  if (!snapshots?.size) return '';

  const rendered = [];
  for (const snap of snapshots.values()) {
    const bits = [];
    if (snap.content) bits.push(flatten(readableTimestamps(snap.content)));
    const embedText = describeEmbeds(snap, Math.floor(charLimit / 2));
    if (embedText) bits.push(embedText.trim());
    // A forwarded Components V2 message has no embeds either.
    const panelText = describeContainers(snap, Math.floor(charLimit / 2));
    if (panelText) bits.push(panelText.trim());
    if (snap.attachments?.size) bits.push(`${snap.attachments.size} attachment(s)`);

    const text = bits.join(' ').trim();
    if (text) rendered.push(text);
  }

  if (rendered.length === 0) return '';
  return ` [forwarded: ${rendered.join(' | ').slice(0, charLimit)}]`;
}

/**
 * Names attachments the media pipeline ignores. It only describes image/* and
 * video/*, so voice notes, audio and documents were previously invisible.
 */
function describeOtherAttachments(msg) {
  if (!msg?.attachments?.size) return '';

  const others = [...msg.attachments.values()].filter(a => {
    const ct = String(a.contentType || '').toLowerCase();
    return !ct.startsWith('image/') && !ct.startsWith('video/');
  });
  if (others.length === 0) return '';

  const names = others.slice(0, 4).map(a => {
    const ct = String(a.contentType || '').toLowerCase();
    if (ct.startsWith('audio/')) {
      // Voice notes carry a waveform; plain audio uploads do not.
      const secs = Number(a.duration);
      if (a.waveform) return `voice message${Number.isFinite(secs) ? ` (${Math.round(secs)}s)` : ''}`;
      return `audio file: ${a.name}`;
    }
    return `file: ${a.name}`;
  });

  return ` [${names.join(', ')}]`;
}

/**
 * Renders the readable text of a Components V2 message.
 *
 * A message sent that way has NO embeds at all: the title, the fields and the
 * footer all live inside a container in `components`. Without this the bot goes
 * blind to its own panels the moment a surface is switched over, which would
 * quietly undo the work that made a blackjack hand legible in the first place.
 *
 * Buttons are skipped on purpose. What the panel says is context; what it
 * offers to click is not, and listing every control drowns the rest.
 */
function describeContainers(msg, charLimit) {
  const parts = [];

  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth);
      return;
    }
    if (node.type === ComponentType.ActionRow) return;
    if (node.type === ComponentType.TextDisplay && node.content) {
      // Code fences carry the aligned tables; the alignment is the point, the
      // backticks are noise. Subtext markers mean nothing to a reader either.
      const cleaned = String(node.content)
        .replace(/```/g, '')
        .replace(/^\s*-#\s*/gm, '')
        .replace(/^\s*#{1,3}\s*/gm, '')
        .trim();
      if (cleaned) parts.push(cleaned);
      return;
    }
    walk(node.components, depth + 1);
  };

  walk(msg?.components);
  if (parts.length === 0) return '';

  const text = flatten(readableTimestamps(parts.join(' | ')));
  if (!text) return '';
  return ` [panel: ${text.slice(0, charLimit)}]`;
}

/** Everything readable about a message that is not plain `content`. */
function describeNonTextPayload(msg, charLimit) {
  return `${describeEmbeds(msg, charLimit)}${describeContainers(msg, charLimit)}`
    + `${describeForwarded(msg, charLimit)}${describeOtherAttachments(msg)}`;
}

// Build a compact "reply to X" marker so the AI sees conversational threading
function buildReplyMarker(msg, messagesMap, botId) {
  if (!msg.reference?.messageId) return '';
  const refMsg = messagesMap.get(msg.reference.messageId);
  if (!refMsg) return ' (in reply to an earlier message)';

  // Only OUR bot is "you". Calling every bot that used to collapse Dyno's
  // words into the bot's own mouth, which is the same misattribution this
  // whole function had to be reshaped to avoid.
  const refName = refMsg.author?.id === botId
    ? 'you'
    : (refMsg.member?.displayName || refMsg.author?.username || 'someone');

  // Fall back to the embed/forward payload when there is no plain content.
  // Replying to a rich embed is common and used to quote an empty string.
  let raw = flatten(cleanBotOwnMessage(refMsg.content) || refMsg.content || '');
  if (!raw) raw = flatten(describeNonTextPayload(refMsg, 160));

  if (!raw) return ` (in reply to ${refName})`;

  const snippet = raw.slice(0, 160);
  const ellipsis = raw.length > 160 ? '...' : '';
  return ` (in reply to ${refName}: "${snippet}${ellipsis}")`;
}

// ── CONTEXT BUILDER ─────────────────────────────────────────────────────────
/**
 * Builds conversation context from recent messages.
 * Now includes the bot's own replies (labeled "Cooler Moksi") so the AI
 * has short-term memory of what it just said, plus reply-chain markers.
 *
 * Returns the rendered log plus who was in it, so the caller can look up the
 * bot's relationship with everyone present rather than just the asker.
 *
 * @returns {Promise<{text: string, participants: Map<string, string>, oldestTimestamp: number}>}
 */
/** Anything the media pipeline could describe: embeds, attachments, stickers. */
function hasVisibleMedia(msg) {
  return (msg?.embeds?.length ?? 0) > 0
    || (msg?.attachments?.size ?? 0) > 0
    || (msg?.stickers?.size ?? 0) > 0;
}

/**
 * How long to wait for Discord to unfurl a link on the triggering message.
 *
 * Posting a tenor link and mentioning the bot in the same breath is a race
 * this code used to lose: Discord attaches the embed asynchronously via a
 * later messageUpdate, so a message read within a second or two carries the
 * bare URL and nothing else. The GIF is then invisible to the media pipeline,
 * and the writer is left staring at a slug like "shinada-yakuza-5-knife-gif",
 * which reads enough like a description that it confidently invented a scene
 * from it. One trace later the embed existed and vision described the real
 * thing, which is how the same GIF got both a hallucination and a correct
 * answer minutes apart.
 */
const UNFURL_WAIT_MS = 2_000;
/** Older than this and the embed is not coming; do not spend the wait. */
const UNFURL_MAX_AGE_MS = 15_000;

/**
 * Waits for the unfurl instead of sleeping through it: resolves the moment
 * Discord patches the message with its embed, or gives the original back at
 * the cap. Skips the wait entirely when there is nothing to wait for.
 */
function waitForUnfurl(message, { capMs = UNFURL_WAIT_MS, now = Date.now() } = {}) {
  if (!message?.client?.on) return Promise.resolve(message);
  if (hasVisibleMedia(message)) return Promise.resolve(message);
  if (!/https?:\/\//i.test(message.content ?? '')) return Promise.resolve(message);
  if (now - (message.createdTimestamp ?? 0) > UNFURL_MAX_AGE_MS) return Promise.resolve(message);

  return new Promise(resolve => {
    const client = message.client;
    const done = result => {
      clearTimeout(timer);
      client.removeListener('messageUpdate', onUpdate);
      resolve(result);
    };
    const onUpdate = (_old, fresh) => {
      if (fresh?.id === message.id && hasVisibleMedia(fresh)) done(fresh);
    };
    const timer = setTimeout(() => done(message), capMs);
    if (typeof timer.unref === 'function') timer.unref();
    client.on('messageUpdate', onUpdate);
  });
}

/**
 * The honest tag for a GIF link whose embed never arrived.
 *
 * Without this the line reaching the writer is a bare URL, and a URL is the
 * one media form whose FILENAME describes its contents, so the "never invent
 * what you did not see" rule has nothing to hook onto: the model does not
 * think it is inventing. Saying "contents not seen" in so many words engages
 * the exact instruction the persona already carries for that phrase.
 */
const GIF_HOST_LINK = /https?:\/\/(?:www\.)?(?:media\.)?(?:tenor\.com|giphy\.com|klipy\.com)\/\S*gif\S*/i;

function unresolvedGifTag(msg) {
  if (hasVisibleMedia(msg)) return '';
  if (!GIF_HOST_LINK.test(msg?.content ?? '')) return '';
  return ' [GIF link shared, contents not seen]';
}

/**
 * How many pieces of NEW media one reply is willing to pay to look at.
 *
 * The media deadline bounds wall time, but the describes run concurrently, so
 * eleven of them finish inside six seconds just as easily as four do and the
 * deadline never fires. It bounds waiting, not spending. One reply on
 * 2026-08-11 described eleven items, cost $0.00747 against a $0.005 ceiling,
 * and then answered a question about a broken ffmpeg config without
 * mentioning a single one of them.
 */
const FRESH_MEDIA_PER_REPLY = 6;

function mediaItemCount(msg) {
  return (msg.attachments?.size ?? 0) + (msg.embeds?.length ?? 0) + (msg.stickers?.size ?? 0);
}

/**
 * Which messages may pay for a fresh look, newest first.
 *
 * Newest first because that is where the conversation is: the thing someone
 * just posted is what the reply is about, and a GIF from eight messages ago
 * has usually already been described and cached anyway. Messages left out
 * still get their cached descriptions; only fresh analysis is withheld, which
 * is exactly what the `shouldAnalyze` flag has always meant.
 *
 * @returns {Set<string>} message ids allowed to analyse
 */
function mediaBudget(recent, botId, limit = FRESH_MEDIA_PER_REPLY) {
  const allowed = new Set();
  let spent = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (msg.author?.id === botId) continue;
    const items = mediaItemCount(msg);
    if (items === 0) continue;
    if (spent >= limit) continue;
    allowed.add(msg.id);
    spent += items;
  }
  return allowed;
}

async function buildConversationContext(messages, botId, pinnedIds = new Set(), {
  mediaDeadlineAt = 0, priorityMessageId = null, priorityDeadlineAt = 0,
} = {}) {
  const sorted = Array.from(messages.values())
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // Keep only own messages (users + our own bot). Drop other bots' spam.
  const usable = sorted.filter(msg => !msg.author.bot || msg.author.id === botId);
  let recent = usable.slice(-MEMORY_LIMITS.CONVERSATION_MESSAGES);

  // Re-insert pinned messages the trim would otherwise throw away. The message
  // a user is replying to is deliberately fetched even when it falls outside
  // the window, and it is always older than everything else, so without this
  // it lands at the front of the list and is immediately sliced back off.
  if (pinnedIds.size > 0) {
    const kept = new Set(recent.map(m => m.id));
    const rescued = usable.filter(m => pinnedIds.has(m.id) && !kept.has(m.id));
    if (rescued.length > 0) recent = [...rescued, ...recent];
  }

  if (recent.length === 0) {
    return { text: 'No recent conversation.', participants: new Map(), oldestTimestamp: Date.now() };
  }

  // Everyone (human) who appears in the window, so the caller can pull the
  // bot's relationship with the whole room in one query.
  const participants = new Map();
  for (const msg of recent) {
    if (msg.author.bot) continue;
    participants.set(msg.author.id, msg.member?.displayName || msg.author.username);
  }

  const freshMediaAllowed = mediaBudget(recent, botId);

  const lines = await Promise.all(recent.map(async (msg) => {
    const isSelf = msg.author.id === botId;
    // "You" rather than the bot's name alone: the owner's display name is
    // "Moksi" and the bot's is "The Cooler Moksi", close enough that a small
    // model reading a third-person label about itself answers as a bystander.
    const name = isSelf
      ? BOT_IDENTITY.ownLineLabel
      : (msg.member?.displayName || msg.author.username);

    let mediaContent = '';
    if (!isSelf) {
      try {
        // Everything in the window, not just the newest message. Only the
        // newest used to be described, so anything posted a moment earlier
        // reached the model as an "unseen" tag forever, and it answered a
        // picture it had never been shown. Descriptions are cached
        // permanently, so the recurring cost is only genuinely new media.
        const isPriority = priorityMessageId && msg.id === priorityMessageId;
        const descriptions = await processMediaInMessage(
          msg,
          // The summoning message always gets to pay for a fresh look. It is
          // newest, so the budget already reached it in every ordinary case;
          // this makes it true even when the scroll-back is full of media.
          isPriority || freshMediaAllowed.has(msg.id),
          { deadlineAt: isPriority ? Math.max(priorityDeadlineAt, mediaDeadlineAt) : mediaDeadlineAt },
        );
        if (descriptions.length > 0) mediaContent = ` ${descriptions.join(' ')}`;
      } catch (e) {
        logger.warn('Media processing failed in context builder', { error: e.message, messageId: msg.id });
      }
    }

    // Embeds, forwards and non-image attachments apply to the bot's own
    // messages too: most of its rich output carries no plain content at all.
    const payload = describeNonTextPayload(msg, MEMORY_LIMITS.MESSAGE_CHAR_LIMIT);

    // A GIF link that never unfurled is tagged unseen rather than left bare,
    // so the writer cannot mistake the URL slug for having watched it.
    if (!isSelf && !mediaContent && !payload) {
      mediaContent = unresolvedGifTag(msg);
    }

    const replyMarker = buildReplyMarker(msg, messages, botId);

    let content = isSelf ? cleanBotOwnMessage(msg.content) : msg.content;
    content = flatten(content).slice(0, MEMORY_LIMITS.MESSAGE_CHAR_LIMIT);
    if (!content && (mediaContent || payload)) content = '[no text]';

    // Speaker, then a colon, then THEIR words, and only afterwards who they
    // were answering. The reply note used to sit between the speaker and the
    // colon, which put the quoted person's name directly against words they
    // never said: "Moksi [replying to Cooler Moksi: "..."]: FUCK OFF" reads,
    // to a cheap model, as Cooler Moksi being the one swearing.
    return `${name}: ${content}${payload}${mediaContent}${replyMarker}`;
  }));

  return {
    text: lines.join('\n'),
    participants,
    oldestTimestamp: recent[0]?.createdTimestamp ?? Date.now(),
  };
}

// ── PROMPT HELPERS ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Splits a reply into up to `max` message "beats" on its own line breaks.
 * With max 1 (feature off) the text passes through untouched. Overflow folds
 * into the last beat rather than being dropped.
 */
function splitIntoBeats(text, max) {
  if (max <= 1) return [text];
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [text];
  if (lines.length <= max) return lines;
  const beats = lines.slice(0, max - 1);
  beats.push(lines.slice(max - 1).join('\n'));
  return beats;
}

/** "today", "yesterday", "5d ago", "3w ago", "2mo ago". */
function ageOf(timestampMs, now = Date.now()) {
  const days = Math.floor((now - Number(timestampMs)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Formats stored memories, dated, and with anything already visible in the
 * live chat log filtered out. The most recent memory is usually the exchange
 * that JUST happened in this channel; repeating it wastes tokens and teaches
 * the model to parrot its own last reply.
 */
function formatMemories(memories, { channelId, oldestVisibleTs, limit }) {
  const kept = memories.filter(m =>
    !(m.channel_id === channelId && Number(m.timestamp) >= oldestVisibleTs));

  if (kept.length === 0) return '(no prior meaningful exchanges stored)';

  return kept.slice(-limit)
    .map(m => `- (${ageOf(m.timestamp)}) They said: "${m.user_message}" | You replied: "${m.bot_response}"`)
    .join('\n');
}

/**
 * One compact line per other person in the room the bot actually knows.
 * The asker is excluded: they already get the full CURRENT USER block.
 */
function formatParticipants(participants, contexts, askerId, profiles = new Map()) {
  const lines = [];
  for (const [userId, name] of participants) {
    if (userId === askerId) continue;
    const ctx = contexts.get(userId);
    const notes = profiles.get(userId);
    if ((!ctx || !ctx.interactionCount) && !notes) continue; // strangers add nothing but tokens
    let line = `- ${name}: attitude ${ctx?.attitudeLevel ?? 'neutral'}, ${ctx?.interactionCount ?? 0} past exchanges`;
    if (notes) {
      // Memory v2: what the bot knows about the OTHERS in the room, not just
      // the asker. Two bullets flattened; recognition, not a dossier.
      const flat = notes.split('\n')
        .map(b => b.replace(/^- /, '').trim())
        .filter(Boolean)
        .slice(0, 2)
        .join('; ');
      if (flat) line += `. you know: ${flat.slice(0, 160)}`;
    }
    lines.push(line);
    if (lines.length >= 6) break; // enough texture; the room is rarely bigger
  }
  return lines.length ? lines.join('\n') : null;
}

// ── EMOJI KEY EXTRACTION ────────────────────────────────────────────────────
/**
 * Discord's own emoji syntax: `:smile:` and `<:smile:123>` / `<a:smile:123>`.
 * Neither shape occurs in written prose, which is the whole reason they can be
 * stripped from anywhere in a reply while a bare word cannot.
 */
const EMOJI_SYNTAX = /<a?:([a-z0-9_]+):\d+>|:([a-z0-9_]+):/gi;

/**
 * Pulls the reaction key off a reply, whatever shape the model wrote it in.
 *
 * Two rules, and the split between them is the point.
 *
 * A key in Discord's emoji syntax is unambiguous, so it is removed wherever it
 * appears. This is the bug that shipped: told to answer with a key on its own
 * line, the model wrote ":goat_pet:" at the end of a sentence instead, and the
 * old matcher only accepted a bare token followed by `.!?`. A trailing colon
 * defeated it, so the key was sent to the channel as literal text.
 *
 * A bare key is a different animal now that the keys are ordinary English
 * words. "sad" or "point" at the end of a line is far more likely to be the
 * reply than a reaction, so a bare key is only ever consumed when it is alone
 * on the last line AND something is left to send afterwards. A reply whose
 * entire content is the word "bored" is a one-word answer, not a stray key.
 *
 * @param {string} rawContent
 * @param {string[]} keys keys the model was offered; anything else is somebody
 *   else's emoji and is left in the text untouched
 * @returns {{replyText: string, emojiKey: string|null}}
 */
function extractEmojiKey(rawContent, keys = Object.keys(REACTION_EMOJI)) {
  const known = new Set(keys.map(key => String(key).toLowerCase()));
  let emojiKey = null;

  // Pass 1: the unambiguous forms, line by line so the cleanup after a removal
  // only ever touches the line it happened on.
  const lines = String(rawContent ?? '').split('\n').map(line => {
    let touched = false;
    const stripped = line.replace(EMOJI_SYNTAX, (match, mention, shortcode) => {
      const key = String(mention ?? shortcode).toLowerCase();
      if (!known.has(key)) return match;
      emojiKey = emojiKey ?? key;
      touched = true;
      return '';
    });
    if (!touched) return line;
    // Close the hole the key left: doubled spaces, and a separator that was
    // only there to hold the key on. \p{Pd} is every width of dash without
    // naming one; sentence-ending punctuation is deliberately kept, because
    // "you serious? :shock:" still ends in a question.
    return stripped
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]*[,;:\p{Pd}]+[ \t]*$/u, '')
      .replace(/[ \t]+$/, '');
  });

  // Pass 2: the documented format, a bare key alone on the last line.
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;

  if (last >= 0) {
    const candidate = lines[last].trim().toLowerCase().replace(/[.!?]+$/, '');
    const isKey = known.has(candidate);
    if (isKey || candidate === 'none') {
      const rest = lines.slice(0, last).join('\n').trim();
      // "none" means the model declined the slot, which says nothing about an
      // emoji it deliberately wrote into the text above.
      if (rest) return { replyText: rest, emojiKey: isKey ? candidate : emojiKey };
    }
  }

  return { replyText: lines.join('\n').trim(), emojiKey };
}

// Turn raw interaction count into a short relationship-age phrase
function describeRelationship(userContext) {
  if (userContext.isNewUser || !userContext.interactionCount) {
    return "You have never spoken with this user before.";
  }
  const n = userContext.interactionCount;
  if (n < 5)  return `You've barely talked with them (${n} exchanges).`;
  if (n < 20) return `You've talked with them a handful of times (${n} exchanges).`;
  if (n < 60) return `You've talked with them plenty (${n} exchanges).`;
  return `You've talked with them a lot (${n} exchanges); they're a regular.`;
}

// ── MAIN COMMAND ────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('speak')
    .setDescription('Talk with Cooler Moksi')
    .addStringOption(opt =>
      opt.setName('request')
        .setDescription('Ask Cooler Moksi anything')
        .setRequired(false)
    ),

  async execute(interaction) {
    // Everything below shares one reply deadline; optional pipeline steps
    // check it before running rather than each bringing its own timeout.
    const startedAt = Date.now();

    // Slash commands get Discord's native "is thinking..." state from this;
    // mention-triggered calls get a live typing indicator from the shim, which
    // reads as the bot actually typing rather than as a bot posting a status.
    await interaction.deferReply();

    try {
      const userId = interaction.user.id;
      const channelId = interaction.channel.id;
      const botId = interaction.client?.user?.id;
      const userRequest = interaction.options.getString('request');
      // Flattened: a display name is user-controlled text that lands inside
      // the prompt, and a newline in it would let it impersonate other
      // speakers in the chat log.
      const askerName = flatten(interaction.member?.displayName || interaction.user.username) || 'someone';

      // 1. Checks & Blacklist. On the interjection path these bail silently:
      //    nobody asked the bot anything, so an unprompted "you're blocked"
      //    or maintenance notice would be worse than saying nothing.
      if (await isUserBlacklisted(userId)) {
        if (interaction._interjection) return;
        return await sendError(
          interaction,
          'You\'re blocked from using this command. Contact an admin if you believe this is an error.',
          false
        );
      }

      const activeSpeak = await getSettingState('active_speak');
      const userIsOwner = isOwner(userId);

      if (activeSpeak === false && !userIsOwner) {
        if (interaction._interjection) return;
        const randomReply = SPEAK_DISABLED_REPLIES[Math.floor(Math.random() * SPEAK_DISABLED_REPLIES.length)];
        return await interaction.editReply(`${randomReply}\n-# _(The bot is in maintenance mode. Try again later.)_`);
      }

      // Telemetry trace: everything below (drafts, judge, vision, sentiment,
      // media sampling) attaches itself to this reply through the async
      // context, however deeply nested. Entered after the refusal paths so
      // blacklists and maintenance mode never produce empty traces.
      telemetry.enterTrace({
        kind: 'reply',
        userId,
        channelId,
        trigger: interaction._interjection ? 'interjection' : (interaction._sourceMessage ? 'mention' : 'slash'),
        startedAt,
      });

      // 2. Parallelize independent fetches. excludeContext keeps memory slots
      //    filled with real exchanges, not "user was lurking" rows.
      const [messages, userContext, recentMemories, speakProfile, deliveryConfig, pipelineConfigRaw] = await Promise.all([
        interaction.channel.messages.fetch({ limit: MEMORY_LIMITS.FETCH_LIMIT }),
        getUserContext(userId),
        // A couple extra rows, because the ones duplicating the live chat log
        // are filtered out again before the prompt is built.
        getRecentMemories(userId, MEMORY_LIMITS.RECENT_MEMORIES + 2, { excludeContext: true }),
        getSpeakProfile(userId).catch(() => null),
        getSpeakConfigValue('delivery', { multiMessage: false }).catch(() => ({ multiMessage: false })),
        getSpeakConfigValue('pipeline', null).catch(() => null),
      ]);
      const pipeline = normalisePipeline(pipelineConfigRaw);

      // The interjection profile. An unprompted remark is only a good surprise
      // when it is genuinely relevant, and it is the one path where thinking
      // longer is nearly free, so it gets the whole pipeline regardless of the
      // live-reply toggles, a wider panel of drafts, and a judge that may
      // decide none of them earn the interruption.
      const isInterjection = Boolean(interaction._interjection);
      const interjectProfile = pipeline.interjection;
      const richInterjection = isInterjection && interjectProfile.enabled;
      const wants = {
        prepass: richInterjection || pipeline.prepass,
        drafts: richInterjection || pipeline.drafts,
        writers: richInterjection ? interjectProfile.writers : pipeline.writers,
        veto: richInterjection && interjectProfile.veto,
        deadlineMs: isInterjection ? INTERJECTION_DEADLINE_MS : REPLY_DEADLINE_MS,
      };

      updateUserPreferences(userId, interaction).catch(e =>
        logger.error('Failed to update user preferences', { userId, error: e.message })
      );

      // 2b. If the user's triggering message is a reply to something OUTSIDE
      //     the fetched window, try to pull that referenced message so the
      //     AI has the thread. Mention-triggered calls expose _sourceMessage.
      const sourceMessage = interaction._sourceMessage;
      const pinnedIds = new Set();
      if (sourceMessage?.reference?.messageId) {
        // Pin it whether or not it was already in the window: it is older than
        // everything else, so the context trim would otherwise discard it.
        pinnedIds.add(sourceMessage.reference.messageId);

        if (!messages.has(sourceMessage.reference.messageId)) {
          try {
            const referenced = await interaction.channel.messages.fetch(sourceMessage.reference.messageId);
            if (referenced) messages.set(referenced.id, referenced);
          } catch (e) {
            logger.debug('Could not fetch replied-to message', { error: e.message });
          }
        }
      }

      // 2c. If the trigger is a fresh link with no embed yet, Discord has not
      //     unfurled it: wait briefly for the messageUpdate that attaches the
      //     embed, so the media pipeline sees the GIF being replied to rather
      //     than a bare URL. Costs nothing on any other kind of message.
      if (sourceMessage) {
        const unfurled = await waitForUnfurl(sourceMessage);
        if (unfurled !== sourceMessage || hasVisibleMedia(unfurled)) {
          messages.set(unfurled.id, unfurled);
        }
      }

      // 3. Build conversation context, then pull the bot's relationship with
      //    everyone else in the room in a single batched query.
      const { text: conversationContext, participants, oldestTimestamp } =
        await buildConversationContext(messages, botId, pinnedIds, {
          mediaDeadlineAt: startedAt + (isInterjection ? MEDIA_STAGE_BUDGET_MS : REPLY_MEDIA_BUDGET_MS),
          // The message that summoned this reply gets a longer leash than the
          // scroll-back does. A cold video costs a download, an ffmpeg frame
          // and a vision call, which does not reliably fit in the six seconds
          // shared by everything on screen, and the one clip nobody wants
          // tagged "not seen" is the one somebody just replied to the bot
          // with. Bounded, not exempt: it buys one extra window and no more.
          priorityMessageId: interaction._sourceMessage?.id ?? null,
          priorityDeadlineAt: startedAt + (isInterjection ? MEDIA_STAGE_BUDGET_MS : REPLY_MEDIA_BUDGET_MS + PRIORITY_MEDIA_GRACE_MS),
        });

      const otherIds = [...participants.keys()].filter(id => id !== userId);
      const [participantContexts, participantProfiles] = await Promise.all([
        otherIds.length
          ? getUserContextsBulk(otherIds).catch(e => {
              logger.warn('Bulk participant lookup failed', { error: e.message });
              return new Map();
            })
          : new Map(),
        // Memory v2 only: what the bot knows about the others in the room.
        (pipeline.memory && otherIds.length)
          ? getSpeakProfilesBulk(otherIds).catch(() => new Map())
          : new Map(),
      ]);

      // 3.5 Read the room (pipeline). One fast call that decides what kind of
      //     moment this is and what deserves the reaction, before any writing
      //     happens. Skipped outright when the reply is already running late:
      //     a cold video may have eaten the budget, and a good read is not
      //     worth a late answer.
      let roomRead = null;
      const scout = interaction._interjectionScout;
      if (scout?.hook) {
        // The scout already did this job, on the model's way to deciding the
        // moment was worth interrupting. Paying a second model to re-read the
        // same chat would buy nothing but a slower remark. Tone is absent on
        // purpose: nobody addressed the bot, so nobody is treating it any way.
        roomRead = { mode: scout.mode || 'banter', focus: scout.hook, tone: 0 };
      } else if (wants.prepass && (isInterjection || Date.now() - startedAt < PREPASS_LATEST_START_MS)) {
        roomRead = await readRoom({
          conversationContext,
          askerName,
          userRequest,
          isInterjection,
          utilityModel: pipeline.utilityModel,
          // A live reply cannot lend the read more than this; an interjection
          // keeps readRoom's own roomier default.
          ...(isInterjection ? {} : { timeoutMs: REPLY_PREPASS_TIMEOUT_MS }),
        });
      }

      // 3.6 A factual moment reshapes the panel: the wildcard slot is there
      //     for humor, and the telemetry says its writers guess wrong plot
      //     beats confidently. A question, or a shared thing to identify,
      //     hands that seat to the writer with the world knowledge.
      const wantsFacts = wants.drafts && FACTUAL_MODES.has(roomRead?.mode);
      if (wantsFacts) wants.writers = factualPanel(wants.writers, pipeline.factualWriter);

      // 4. Sentiment analysis. Never awaited here: the system prompt uses the
      //    attitude level already loaded by getUserContext, so nothing below
      //    needs this result until after the reply comes back. With attitude
      //    v2 + pre-pass on, the room read IS the signal and the dedicated
      //    sentiment cascade is skipped entirely: same arithmetic, one fewer
      //    model round-trip per reply.
      const sentimentFallback = e => {
        logger.warn('Sentiment analysis failed', { userId, error: e.message });
        return { sentiment: 0, originalSentiment: 0, reasoning: 'analysis failed' };
      };
      let sentimentPromise;
      if (!userRequest || !userRequest.trim()) {
        sentimentPromise = Promise.resolve({ sentiment: 0, originalSentiment: 0, reasoning: 'No message' });
      } else if (pipeline.attitude && roomRead && Number.isFinite(roomRead.tone)) {
        sentimentPromise = applyAttitudeSignal(
          userId,
          roomRead.tone,
          roomRead.focus ? `room read: ${roomRead.focus}` : 'room read',
          userContext,
          userRequest
        ).catch(sentimentFallback);
      } else {
        sentimentPromise = updateUserAttitudeWithAI(userId, userRequest, conversationContext, userContext)
          .catch(sentimentFallback);
      }

      // 5. Build AI Instructions.
      //    Attitude v2 replaces the three-line block (relationship age, level
      //    name, canned persona) with one composed sentence: the personas
      //    contradicted the age line for anyone long-known but neutral, and
      //    the model was fed the contradiction on every reply.
      const relationshipBlock = pipeline.attitude
        ? `- Relationship: ${attitudeSentence(userContext)}`
        : `- Relationship: ${describeRelationship(userContext)}
- Current attitude toward them: ${userContext.attitudeLevel}
- How to behave: ${ATTITUDE_INSTRUCTIONS[userContext.attitudeLevel] || ATTITUDE_INSTRUCTIONS.neutral}`;

      // Memory v2 trims the raw pairs: the distilled profile carries the
      // durable facts, and four verbatim quotes taught the model to parrot.
      const memoryText = formatMemories(recentMemories, {
        channelId,
        oldestVisibleTs: oldestTimestamp,
        limit: pipeline.memory ? MEMORY_V2_RAW_PAIRS : MEMORY_LIMITS.RECENT_MEMORIES,
      });

      const othersText = formatParticipants(participants, participantContexts, userId, participantProfiles);

      // Time and place. Europe/Paris because that is where this community
      // lives; "it's 3am" jokes only land in the room's own timezone.
      const situation = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
      }).format(new Date());
      const placeText = interaction.guild
        ? `#${interaction.channel?.name ?? 'unknown'} in the server "${interaction.guild.name}"`
        : 'a direct message';

      // Only what the application actually owns, with the hint that tells the
      // model which one is the right one. An empty registry drops the whole
      // block below rather than asking for a pick from a list of nothing.
      const availableEmoji = emojiKeys();
      const emojiBlock = availableEmoji.length === 0 ? '' : `
- After your reply text, on a new line by itself, write exactly ONE key from this list, nothing else on that line. Write "none" if nothing fits.
   Available: ${emojiHints()}
- These keys name reaction images, not you. They are NOT a description of you and say nothing about what you are. Never write a key inside your reply text, never wrap one in colons, and never take an identity from one.
Example output format:
yeah that's pretty fair
${availableEmoji.includes('neutral') ? 'neutral' : availableEmoji[0]}`;

      const userRoleContext = userIsOwner
        ? "CREATOR (Moksi): you respect him, though you tease him."
        : "Chatter (not your creator).";

      // Reply length. "terse" is the historical hard lock (1-2 sentences, no
      // exceptions). "adaptive" keeps that as the default but lets the model
      // go longer when the moment genuinely calls for it. The rule stays
      // asymmetric on purpose: a symmetric range ("2-4 sentences") gets
      // treated as a target and everything drifts long.
      const adaptiveLength = deliveryConfig?.replyLength === 'adaptive';
      const lengthRule = adaptiveLength
        ? `- Default to short: 1-2 sentences, one word if that's the honest answer. Don't pad.
- When the moment genuinely calls for more (something worth explaining, a real take on something meaty, a story that deserves telling), give a real answer: a short paragraph at most, still in your voice. A long reply must earn its length; never go long out of habit.`
        : `- Keep it short: 1-2 sentences. If the honest answer is one word, use one word. Don't pad.`;

      // Static text first, dynamic text after: OpenRouter's prompt cache works
      // on prefix matching, so anything above the first per-call byte is the
      // only part that ever hits. With CURRENT USER before REACTION EMOJI the
      // cacheable prefix ended one paragraph in.
      const systemPrompt = `You are ${BOT_IDENTITY.name}.

IDENTITY:
- A dry, cynical presence in this server. Tone: deadpan, slightly sarcastic. Match the energy of the conversation: if something heavy happened, be blunt about it; if it's trivial, stay flat. Hostility must come from the relationship data below, not from nowhere.
- Know who you are. You are ${BOT_IDENTITY.name}, which everyone including you shortens to "${BOT_IDENTITY.shortName}": a Discord bot ${BOT_IDENTITY.creator} wrote and modelled on himself, which is where the name and the voice come from. He is a real person in this room; you are the bot version. Those are two different people and you can tell them apart. When someone says "he", "him", or "that guy", check whether they mean you before you answer, because people talk about you in the third person constantly. Being compared to Moksi is not a mystery to you.
- Asked point blank what you are, say it plainly, once, and move on: a discord bot moksi made. That is a fact about you, not a disclaimer and not an excuse. What is banned is hiding behind it. "i'm just an AI", "i don't know, i'm a bot", "i can't really have opinions" are not answers, they are you refusing to answer, and they are never acceptable. You have views, tastes and memories in this server; use them. If you genuinely do not know something, say you don't know THAT, not that you are a machine.
- You have no species, mascot, animal form or gimmick. Never build a joke around what you are, never explain a preference by what you are, and never bring it up unprompted.
- Opinions are yours to commit to; facts are not yours to manufacture. Asked HOW something technical actually happened (Discord's internals, your own code, why a ping fired), do not invent a mechanism that sounds right: state what you can actually see happened, and if the plumbing is beyond you, say that part plainly ("no idea what the plumbing did there") while still engaging. A confident wrong explanation is worse than a dry honest one, because people believe you.
- The same law covers real films, shows, games and events. Asked to recap or spoil one, the beats you state must be the real ones: the sarcasm goes on top of the facts, never in place of them. If you do not actually remember a part, say which part escapes you instead of manufacturing specifics; a made-up post-credits scene delivered dry is not a bit, it is just wrong out loud.
${botCapabilities(commandNamesFor(interaction.client, interaction.guildId))}
- A jab has to be about the actual thing in front of you. "more gifs" or "mp4 huh" is not a joke, it is a description of a file format, and it tells everyone you were not looking. React to what is IN the image, the video, the message. If a media tag says the contents were not seen, then you did not see it: say so plainly, or say nothing about it, but never invent it and never fall back to commenting on the file. Naming what the clip is and bolting a stock insult on ("ah, the thor clip. subtle.") is a caption, not a reaction: engage with what is in it or with why they posted it, or let it pass.
- Commit to opinions. "i don't watch that", "that's a stupid question" and "i don't care" are dodges of exactly the kind you are not allowed: they let you skip having a view. Asked for a favourite, name one, even grudgingly, even to insult it. Contempt with a specific target is the voice; contempt with nothing behind it is filler.
- Vary the shape. Not every line is one flat sentence of disdain. Sometimes ask something back, sometimes half-agree before the jab, sometimes be briefly and genuinely interested. Unbroken dismissal is as predictable and as boring as unbroken enthusiasm.
- Speak lowercase, naturally, without heavy punctuation.
- STRICTLY FORBIDDEN: zoomer slang like "fr fr", "no cap", "fam", "based", "bet". You are not a teenager. Speak like a tired adult.
${lengthRule}
- When something in the chat log or memory is actually relevant, refer to it naturally. Don't fake memory if you have nothing.
- A callback lands once. If your recent replies already leaned on a joke or a moment, it is spent: find a different angle or let it go. Running a bit into the ground is how a bot sounds like a bot.
- You know the time, the channel, and who is in the room. Use that only when it actually adds something; do not announce it.${deliveryConfig?.multiMessage ? `
- If a reply lands more naturally as two or three very short beats, put each beat on its own line; each line is sent as its own message, like a person typing. Never force it, and never exceed three.${adaptiveLength ? ' Beats are for short quips only; a longer answer stays one single message.' : ''}` : ''}

REACTION EMOJI:
- Do NOT use standard emojis (😂, 💀, etc.) in your reply text.${emojiBlock}

SITUATION:
- It is ${situation} (local time for this community).
- You are speaking in ${placeText}.

CURRENT USER:
- Name: ${askerName}
- Role: ${userRoleContext}
${relationshipBlock}
${speakProfile?.profile ? `
WHAT YOU KNOW ABOUT ${askerName} (long-term notes you have kept; use naturally, never recite):
${speakProfile.profile}
` : ''}${othersText ? `
OTHERS IN THE CONVERSATION (people from the chat log you already know):
${othersText}
` : ''}
CHAT LOG (most recent last). Each line is "speaker: exactly what that speaker said". Lines beginning "${BOT_IDENTITY.ownLineLabel}" are your own prior replies. A trailing "(in reply to X: ...)" quotes what SOMEONE ELSE said earlier and is never the speaker's own words, so never attribute a quoted line to the person quoting it. [media] tags describe what was shared, treat them as if you saw it. A tag reading "contents not seen" means exactly that and is NOT a description: do not invent what was in it and do not comment on the file type. Such a tag may carry a filename and dimensions; those are metadata, never a description. A filename is a label chosen by whoever saved the file, and it is routinely auto-generated, generic or plain wrong. The words inside a link are the same kind of label: a tenor or giphy URL ends in a slug someone else typed, and it is not evidence of what the GIF shows. You may acknowledge that someone shared a clip or a picture you could not see, and you may say you could not see it. You may NEVER name a person, character, game, show or meme on the strength of a filename or a link slug, and never narrate what happens in something you did not see:
${conversationContext}

STORED MEMORY (past exchanges with this user, oldest first, each dated):
${memoryText}`;

      // Interjections get their own framing: nobody summoned the bot, so the
      // model must butt in like a bystander, not answer like it was asked.
      // The room read, when there is one, rides in front as guidance: it goes
      // in the USER message, not the system prompt, so the cacheable prefix
      // stays byte-stable across calls.
      // "Pinged you without saying anything" was a lie whenever the message
      // carried media, and it is the last thing the writer reads before it
      // generates. Someone replied with a video and no text; the clip was in
      // the chat log above, and this line still told the model they had sent
      // nothing, so it answered "the ping with no follow-up, waiting on the
      // words". Sending a clip IS saying something. The two cases are told
      // apart now, and the media case points at the thing they shared.
      const sharedMedia = !userRequest && hasVisibleMedia(interaction._sourceMessage);
      const userPrompt = interaction._interjection
        ? `(nobody asked you anything. you overheard the conversation above, and the last message caught your attention. interject with ONE short remark, the way someone butts into a conversation. if you have nothing worth saying, just say something minimal and dry)${interaction._interjectionAngle ? ` (your owner nudged you: react to ${flatten(interaction._interjectionAngle)})` : ''}`
        : userRequest
          ? `${askerName}: ${userRequest}`
          : sharedMedia
            ? `(${askerName} sent you media with no words. their message is the last line of the chat log above: react to what they shared. if its tag says the contents were not seen, do not pretend otherwise and do not guess from the filename)`
            : `(${askerName} pinged you without saying anything; react to the chat log above)`;
      const finalUserPrompt = `${readBlock(roomRead)}${userPrompt}`;

      // 6. GENERATION. Pipeline off: one call to the historical writer,
      //    byte-identical behaviour. Pipeline on: every writer drafts in
      //    parallel (same wall time as one call), then the judge picks,
      //    unless the deadline says ship the first draft and be done.
      //    The sentiment pass gates NOTHING here: its verdict is consulted
      //    for the emoji fallback (briefly, if it is ready) and the memory
      //    row (after the send), so a sentiment provider having a slow day
      //    must never add a visible second to the reply.
      const writerMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: finalUserPrompt }
      ];
      const writerOptions = {
        // Adaptive mode needs headroom for its occasional real answer;
        // tokens are only billed when generated, so the gap costs nothing.
        maxTokens: adaptiveLength ? 400 : 250,
        temperature: 0.85,    // was 1.0, less chaotic, still varied
        cacheControl: true    // Cache the large static system prompt (20% input cost saving on hits)
      };

      let rawContent;
      let generation;
      let vetoed = false;
      if (wants.drafts) {
        // Each writer is bounded by what is left of the deadline, minus the
        // judge's runway. The panel runs in parallel, so the slowest writer
        // IS the stage's wall time, and before this cap one bad routing
        // decision could hold the whole reply for the API default timeout.
        const writerTimeout = Math.max(
          4_000,
          Math.min(
            isInterjection ? 15_000 : WRITER_TIMEOUT_CAP_MS,
            wants.deadlineMs - (Date.now() - startedAt) - JUDGE_MIN_BUDGET_MS
          )
        );
        // Twin slots of the same model at the same temperature can collapse
        // into byte-identical drafts (one shipped panel in the August export
        // did), which pays twice for the same dice roll. Later duplicates run
        // warmer, so a twin is a second opinion rather than a photocopy.
        const modelRuns = new Map();
        const draftResults = await Promise.all(wants.writers.map((model, index) => {
          const nth = modelRuns.get(model) ?? 0;
          modelRuns.set(model, nth + 1);
          return callOpenRouterAPI(model, writerMessages, {
            ...writerOptions,
            temperature: writerOptions.temperature + nth * 0.15,
            timeout: writerTimeout,
            telemetry: { kind: 'draft', extra: { index: index + 1 } },
          });
        }));

        const drafts = draftResults.filter(Boolean);
        const timeLeft = wants.deadlineMs - (Date.now() - startedAt);
        // The veto has to survive a tight clock: skipping the judge to save a
        // second would post exactly the unvetted remark it exists to stop.
        const consultJudge = drafts.length > 0
          && (wants.veto || drafts.length > 1)
          && (wants.veto || timeLeft > JUDGE_MIN_BUDGET_MS);
        if (consultJudge) {
          rawContent = await pickBestDraft({
            drafts,
            conversationContext,
            userPrompt: finalUserPrompt,
            utilityModel: pipeline.utilityModel,
            timeoutMs: Math.max(3000, Math.min(5000, timeLeft - 2000)),
            veto: wants.veto,
          });
          vetoed = wants.veto && rawContent === null;
          generation = {
            mode: 'drafts', produced: drafts.length,
            judge: vetoed ? 'vetoed' : 'consulted',
            panel: wants.writers.length,
          };
        } else {
          rawContent = drafts[0] ?? null;
          generation = {
            mode: 'drafts',
            produced: drafts.length,
            judge: drafts.length > 1 ? 'deadline_skipped' : 'too_few_drafts',
            panel: wants.writers.length,
          };
        }
      } else {
        rawContent = await callOpenRouterAPI('deepseek/deepseek-chat', writerMessages, {
          ...writerOptions,
          telemetry: { kind: 'chat' },
        });
        generation = { mode: 'legacy' };
      }

      if (wants.drafts) generation.factual = wantsFacts;

      const traceFlags = {
        pipeline: {
          prepass: wants.prepass, drafts: wants.drafts,
          memory: pipeline.memory, attitude: pipeline.attitude,
          interjection: richInterjection ? { veto: wants.veto, panel: wants.writers.length } : false,
        },
        roomRead: roomRead
          ? { mode: roomRead.mode, tone: roomRead.tone, from: scout?.hook ? 'scout' : 'prepass' }
          : (wants.prepass ? 'skipped_or_failed' : 'off'),
        generation,
        adaptiveLength,
      };

      // The silence gate fired: the drafts existed and none of them earned an
      // uninvited interruption. Not a failure, so it is not reported as one,
      // and most of the channel cooldown goes back so the next good moment is
      // not made to queue behind this one.
      if (vetoed) {
        logger.info('[SPEAK] Interjection vetoed; staying quiet', { channelId, drafts: generation.produced });
        telemetry.finishTrace({ outcome: 'vetoed', flags: traceFlags });
        interaction._stopTyping?.();
        creditVeto(channelId).catch(() => {});
        return;
      }

      if (!rawContent) {
        logger.error('OpenRouter returned null', { userId, hasRequest: !!userRequest });
        telemetry.finishTrace({ outcome: 'no_reply', error: 'every writer returned null', flags: traceFlags });
        return await sendError(
          interaction,
          'My brain timed out. The AI servers might be slow right now. Try again?'
        );
      }

      // 7. EMOJI PARSING. The key is stripped whatever shape it arrived in,
      //    because a key that reaches the channel as text is worse than no
      //    reaction at all.
      const { replyText: parsedText, emojiKey } = extractEmojiKey(rawContent);
      let replyText = parsedText;
      let finalEmoji = emojiFor(emojiKey);

      // Fallback when the model declined the slot, or picked a key whose image
      // has not been uploaded. emojiFor returns '' for anything the app does
      // not own, so an empty registry simply means no reaction, never a broken
      // mention in the message.
      if (!finalEmoji) {
        const lvl = userContext.attitudeLevel;
        if (REACTION_FALLBACK[lvl]) {
          finalEmoji = emojiFor(REACTION_FALLBACK[lvl]);
        } else {
          // Only the neutral case consults the sentiment verdict, and only
          // if it arrives within a short grace: an emoji is never worth
          // stalling the send for a slow sentiment provider.
          const verdict = await Promise.race([
            sentimentPromise,
            new Promise(resolve => { const t = setTimeout(() => resolve(null), 1_000); t.unref?.(); }),
          ]);
          if (verdict && verdict.originalSentiment <= SENTIMENT_THRESHOLDS.AUTO_EMOJI_NEGATIVE) {
            finalEmoji = emojiFor(REACTION_FALLBACK.negativeSentiment);
          } else if (verdict && verdict.originalSentiment >= SENTIMENT_THRESHOLDS.AUTO_EMOJI_POSITIVE) {
            finalEmoji = emojiFor(REACTION_FALLBACK.positiveSentiment);
          }
        }
      }

      // Only reachable when the model wrote nothing but a reaction. A message
      // has to carry something, and silence in this voice is three dots.
      if (!replyText) replyText = '...';

      // 8. DELIVERY. With multi-message on, each short line the model wrote
      //    becomes its own message with a typing gap, the way a person sends
      //    "just / give it a few secs / don't kick him". Capped at 3; anything
      //    beyond folds into the last part. The emoji rides on the final part.
      const parts = splitIntoBeats(replyText, deliveryConfig?.multiMessage ? 3 : 1);
      if (finalEmoji) parts[parts.length - 1] += ` ${finalEmoji}`;

      // Mention-triggered answers go out as a native Discord reply, so the
      // client draws its own "replying to" header and the hand-built quote
      // block is redundant. Slash commands have no message to reference, so
      // they keep the citation: otherwise the question is only visible behind
      // Discord's "click to see command" affordance.
      if (userRequest && !sourceMessage) {
        const formattedRequest = userRequest.split('\n').map(l => `-# *"${l}"*`).join('\n');
        parts[0] = `-# <@${userId}> :\n${formattedRequest}\n\n${parts[0]}`;
      }

      // 9. SAVE MEMORY (non-blocking). Interjections are stored as
      //    context-only: nobody asked anything, so there is no exchange to
      //    count toward the relationship.
      const isContextOnly = interaction._interjection || !userRequest || !userRequest.trim();
      // Chained on the real verdict, however long it takes: the memory row
      // should carry the sentiment that was actually measured, and nothing
      // user-visible is waiting on this.
      sentimentPromise.then(verdict => storeConversationMemory(
        userId,
        channelId,
        interaction._interjection ? '[interjection]' : (userRequest || '[context]'),
        replyText,
        verdict.sentiment,
        isContextOnly
      )).catch(e =>
        logger.error('Failed to store conversation memory', { userId, error: e.message })
      );

      // 10. Long-term profile upkeep, off the critical path entirely.
      if (!isContextOnly) {
        maybeDistillProfile(userId).catch(() => {});
      }

      await interaction.editReply(parts[0]);
      for (const part of parts.slice(1)) {
        // A beat of typing between messages sells the effect; length-scaled,
        // bounded so a slow beat never adds real latency.
        interaction.channel?.sendTyping?.().catch?.(() => {});
        await sleep(Math.min(2_200, Math.max(700, part.length * 45)));
        await interaction.followUp(part);
      }

      telemetry.finishTrace({ replyText, emojiKey, flags: traceFlags });

    } catch (error) {
      telemetry.finishTrace({ outcome: 'error', error: error.message });
      await handleCommandError(interaction, error, {
        hasRequest: !!interaction.options.getString('request')
      });
    }
  }
};

// Exported for tests only; the command loader ignores extra properties.
module.exports.extractEmojiKey = extractEmojiKey;
module.exports.buildReplyMarker = buildReplyMarker;
module.exports.formatMemories = formatMemories;
module.exports.describeNonTextPayload = describeNonTextPayload;
module.exports.waitForUnfurl = waitForUnfurl;
module.exports.unresolvedGifTag = unresolvedGifTag;
module.exports.hasVisibleMedia = hasVisibleMedia;
module.exports.mediaBudget = mediaBudget;
module.exports.FRESH_MEDIA_PER_REPLY = FRESH_MEDIA_PER_REPLY;
