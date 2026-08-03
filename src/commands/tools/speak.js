// ENHANCED SPEAK.JS - DeepSeek V3 + Relationship-Aware Context
const { SlashCommandBuilder } = require('discord.js');

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
  processMediaInMessage
} = require('../../utils/db.js');
const { maybeDistillProfile } = require('../../utils/speakProfile');

const { callOpenRouterAPI } = require('../../utils/apiHelpers');
const { handleCommandError, sendError } = require('../../utils/errorHandler');
const {
  GOAT_EMOJIS,
  GOAT_EMOJI_DESCRIPTIONS,
  ATTITUDE_INSTRUCTIONS,
  SPEAK_DISABLED_REPLIES,
  MEMORY_LIMITS,
  SENTIMENT_THRESHOLDS,
  isOwner
} = require('../../utils/constants');
const logger = require('../../utils/logger');

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

/** Everything readable about a message that is not plain `content`. */
function describeNonTextPayload(msg, charLimit) {
  return `${describeEmbeds(msg, charLimit)}${describeForwarded(msg, charLimit)}${describeOtherAttachments(msg)}`;
}

// Build a compact "reply to X" marker so the AI sees conversational threading
function buildReplyMarker(msg, messagesMap) {
  if (!msg.reference?.messageId) return '';
  const refMsg = messagesMap.get(msg.reference.messageId);
  if (!refMsg) return ' [replying to an earlier message]';

  const refName = refMsg.author?.bot
    ? 'Cooler Moksi'
    : (refMsg.member?.displayName || refMsg.author.username);

  // Fall back to the embed/forward payload when there is no plain content.
  // Replying to a rich embed is common and used to quote an empty string.
  let raw = flatten(cleanBotOwnMessage(refMsg.content) || refMsg.content || '');
  if (!raw) raw = flatten(describeNonTextPayload(refMsg, 160));

  if (!raw) return ` [replying to ${refName}]`;

  const snippet = raw.slice(0, 160);
  const ellipsis = raw.length > 160 ? '...' : '';
  return ` [replying to ${refName}: "${snippet}${ellipsis}"]`;
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
async function buildConversationContext(messages, botId, pinnedIds = new Set()) {
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

  // Only analyze media on the newest *user* message, which stops 5-10s re-analysis
  // of old images every call.
  const newestUserMsg = [...recent].reverse().find(m => m.author.id !== botId);
  const newestUserMsgId = newestUserMsg?.id;

  const lines = await Promise.all(recent.map(async (msg) => {
    const isSelf = msg.author.id === botId;
    const name = isSelf
      ? 'Cooler Moksi'
      : (msg.member?.displayName || msg.author.username);

    let mediaContent = '';
    if (!isSelf) {
      try {
        const shouldAnalyze = msg.id === newestUserMsgId;
        const descriptions = await processMediaInMessage(msg, shouldAnalyze);
        if (descriptions.length > 0) mediaContent = ` ${descriptions.join(' ')}`;
      } catch (e) {
        logger.warn('Media processing failed in context builder', { error: e.message, messageId: msg.id });
      }
    }

    // Embeds, forwards and non-image attachments apply to the bot's own
    // messages too: most of its rich output carries no plain content at all.
    const payload = describeNonTextPayload(msg, MEMORY_LIMITS.MESSAGE_CHAR_LIMIT);

    const replyMarker = buildReplyMarker(msg, messages);

    let content = isSelf ? cleanBotOwnMessage(msg.content) : msg.content;
    content = flatten(content).slice(0, MEMORY_LIMITS.MESSAGE_CHAR_LIMIT);
    if (!content && (mediaContent || payload)) content = '[no text]';

    return `${name}${replyMarker}: ${content}${payload}${mediaContent}`;
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
function formatParticipants(participants, contexts, askerId) {
  const lines = [];
  for (const [userId, name] of participants) {
    if (userId === askerId) continue;
    const ctx = contexts.get(userId);
    if (!ctx || !ctx.interactionCount) continue; // strangers add nothing but tokens
    lines.push(`- ${name}: attitude ${ctx.attitudeLevel}, ${ctx.interactionCount} past exchanges`);
    if (lines.length >= 6) break; // enough texture; the room is rarely bigger
  }
  return lines.length ? lines.join('\n') : null;
}

// ── EMOJI KEY EXTRACTION ────────────────────────────────────────────────────
/**
 * Pulls the trailing emoji key off a reply.
 *
 * The previous implementation matched `\b(goat_...|none)\b` anywhere in the
 * response, so an ordinary sentence containing the word "none" had that word
 * deleted from it. Worse, because only the first match was consumed, the real
 * key on the last line then survived and leaked into the message as raw text:
 * "that's none of your concern" + goat_sleep became
 * "that's  of your concern goat_sleep".
 *
 * So: the last non-empty line is consumed only when the WHOLE line is a key or
 * "none". As a safety net for the model ignoring the format, a `goat_*` token
 * at the very end of that line is also stripped; those tokens never occur in
 * natural prose, so unlike "none" they cannot be a false positive.
 *
 * @returns {{replyText: string, emojiKey: string|null}}
 */
function extractEmojiKey(rawContent) {
  const lines = String(rawContent ?? '').split('\n');

  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return { replyText: '', emojiKey: null };

  const lineText = lines[last].trim();
  const candidate = lineText.toLowerCase();

  // Case 1: the line is exactly the key (the documented format).
  if (candidate === 'none') {
    return { replyText: lines.slice(0, last).join('\n').trim(), emojiKey: null };
  }
  if (Object.prototype.hasOwnProperty.call(GOAT_EMOJIS, candidate)) {
    return { replyText: lines.slice(0, last).join('\n').trim(), emojiKey: candidate };
  }

  // Case 2: the model appended the key inline. Safe to strip because a
  // `goat_*` token is never a real word. "none" is deliberately excluded here.
  const inline = lineText.match(/\b(goat_[a-z_]+)\s*[.!?]*$/i);
  if (inline) {
    const key = inline[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(GOAT_EMOJIS, key)) {
      // Trim whatever separator preceded it. The Unicode punctuation class
      // covers dashes of every width without naming one literally.
      const trimmedLine = lineText.slice(0, inline.index).replace(/[\s\p{P}]+$/u, '').trim();
      const rebuilt = [...lines.slice(0, last), trimmedLine].join('\n').trim();
      return { replyText: rebuilt, emojiKey: key };
    }
  }

  return { replyText: String(rawContent ?? '').trim(), emojiKey: null };
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

      // 2. Parallelize independent fetches. excludeContext keeps memory slots
      //    filled with real exchanges, not "user was lurking" rows.
      const [messages, userContext, recentMemories, speakProfile, deliveryConfig] = await Promise.all([
        interaction.channel.messages.fetch({ limit: MEMORY_LIMITS.FETCH_LIMIT }),
        getUserContext(userId),
        // A couple extra rows, because the ones duplicating the live chat log
        // are filtered out again before the prompt is built.
        getRecentMemories(userId, MEMORY_LIMITS.RECENT_MEMORIES + 2, { excludeContext: true }),
        getSpeakProfile(userId).catch(() => null),
        getSpeakConfigValue('delivery', { multiMessage: false }).catch(() => ({ multiMessage: false })),
      ]);

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

      // 3. Build conversation context, then pull the bot's relationship with
      //    everyone else in the room in a single batched query.
      const { text: conversationContext, participants, oldestTimestamp } =
        await buildConversationContext(messages, botId, pinnedIds);

      const otherIds = [...participants.keys()].filter(id => id !== userId);
      const participantContexts = otherIds.length
        ? await getUserContextsBulk(otherIds).catch(e => {
            logger.warn('Bulk participant lookup failed', { error: e.message });
            return new Map();
          })
        : new Map();

      // 4. Sentiment analysis. Started here but deliberately NOT awaited: the
      //    system prompt uses the attitude level already loaded by
      //    getUserContext, so nothing below needs this result until after the
      //    reply comes back. Awaiting it here used to add a whole round-trip
      //    (up to three sequential model fallbacks) to every single reply.
      const sentimentPromise = (userRequest && userRequest.trim())
        ? updateUserAttitudeWithAI(userId, userRequest, conversationContext, userContext)
            .catch(e => {
              logger.warn('Sentiment analysis failed', { userId, error: e.message });
              return { sentiment: 0, originalSentiment: 0, reasoning: 'analysis failed' };
            })
        : Promise.resolve({ sentiment: 0, originalSentiment: 0, reasoning: 'No message' });

      // 5. Build AI Instructions
      const attitudeInstruction =
        ATTITUDE_INSTRUCTIONS[userContext.attitudeLevel] || ATTITUDE_INSTRUCTIONS.neutral;

      const relationshipContext = describeRelationship(userContext);

      const memoryText = formatMemories(recentMemories, {
        channelId,
        oldestVisibleTs: oldestTimestamp,
        limit: MEMORY_LIMITS.RECENT_MEMORIES,
      });

      const othersText = formatParticipants(participants, participantContexts, userId);

      // Time and place. Europe/Paris because that is where this community
      // lives; "it's 3am" jokes only land in the room's own timezone.
      const situation = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
      }).format(new Date());
      const placeText = interaction.guild
        ? `#${interaction.channel?.name ?? 'unknown'} in the server "${interaction.guild.name}"`
        : 'a direct message';

      // Emoji list with semantic hints so the AI picks meaningfully.
      const emojiHints = Object.keys(GOAT_EMOJIS)
        .map(key => `${key} (${GOAT_EMOJI_DESCRIPTIONS[key] || 'n/a'})`)
        .join(', ');

      const userRoleContext = userIsOwner
        ? "CREATOR (Moksi): you respect him, though you tease him."
        : "Chatter (not your creator).";

      // Static text first, dynamic text after: OpenRouter's prompt cache works
      // on prefix matching, so anything above the first per-call byte is the
      // only part that ever hits. With CURRENT USER before REACTION EMOJI the
      // cacheable prefix ended one paragraph in.
      const systemPrompt = `You are Cooler Moksi.

IDENTITY:
- A cynical goat AI. Tone: dry, deadpan, slightly sarcastic. Match the energy of the conversation: if something heavy happened, be blunt about it; if it's trivial, stay flat. Hostility must come from the relationship data below, not from nowhere.
- Speak lowercase, naturally, without heavy punctuation.
- STRICTLY FORBIDDEN: zoomer slang like "fr fr", "no cap", "fam", "based", "bet". You are not a teenager. Speak like a tired adult.
- Keep it short: 1-2 sentences. If the honest answer is one word, use one word. Don't pad.
- When something in the chat log or memory is actually relevant, refer to it naturally. Don't fake memory if you have nothing.
- You know the time, the channel, and who is in the room. Use that only when it actually adds something; do not announce it.${deliveryConfig?.multiMessage ? `
- If a reply lands more naturally as two or three very short beats, put each beat on its own line; each line is sent as its own message, like a person typing. Never force it, and never exceed three.` : ''}

REACTION EMOJI:
- Do NOT use standard emojis (😂, 💀, etc.) in your reply text.
- After your reply text, on a new line by itself, write exactly ONE key from this list, nothing else on that line. Write "none" if nothing fits.
   Available: ${emojiHints}
Example output format:
yeah that's pretty fair
goat_meditate

SITUATION:
- It is ${situation} (local time for this community).
- You are speaking in ${placeText}.

CURRENT USER:
- Name: ${askerName}
- Role: ${userRoleContext}
- Relationship: ${relationshipContext}
- Current attitude toward them: ${userContext.attitudeLevel}
- How to behave: ${attitudeInstruction}
${speakProfile?.profile ? `
WHAT YOU KNOW ABOUT ${askerName} (long-term notes you have kept; use naturally, never recite):
${speakProfile.profile}
` : ''}${othersText ? `
OTHERS IN THE CONVERSATION (people from the chat log you already know):
${othersText}
` : ''}
CHAT LOG (most recent last; "Cooler Moksi" entries are your own prior replies; [media] tags describe what was shared, treat them as if you saw it):
${conversationContext}

STORED MEMORY (past exchanges with this user, oldest first, each dated):
${memoryText}`;

      // Interjections get their own framing: nobody summoned the bot, so the
      // model must butt in like a bystander, not answer like it was asked.
      const userPrompt = interaction._interjection
        ? `(nobody asked you anything. you overheard the conversation above, and the last message caught your attention. interject with ONE short remark, the way someone butts into a conversation. if you have nothing worth saying, just say something minimal and dry)`
        : userRequest
          ? `${askerName}: ${userRequest}`
          : `(${askerName} pinged you without saying anything; react to the chat log above)`;

      // 6. API CALL with context caching (system prompt is static, worth caching)
      //    Runs concurrently with the sentiment pass started above, so the user
      //    waits for whichever is slower rather than for both in sequence.
      const [rawContent, sentimentAnalysis] = await Promise.all([
        callOpenRouterAPI(
          'deepseek/deepseek-chat',
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          {
            maxTokens: 250,       // was 200, avoids mid-sentence cut-offs
            temperature: 0.85,    // was 1.0, less chaotic, still varied
            cacheControl: true    // Cache the large static system prompt (20% input cost saving on hits)
          }
        ),
        sentimentPromise
      ]);


      if (!rawContent) {
        logger.error('OpenRouter returned null', { userId, hasRequest: !!userRequest });
        return await sendError(
          interaction,
          'My brain timed out. The AI servers might be slow right now. Try again?'
        );
      }

      // 7. EMOJI PARSING: only ever consume the trailing key line.
      const { replyText: parsedText, emojiKey } = extractEmojiKey(rawContent);
      let replyText = parsedText;
      let finalEmoji = emojiKey ? (GOAT_EMOJIS[emojiKey] || '') : '';

      // Fallback: map attitude/sentiment to emojis that actually exist in GOAT_EMOJIS
      if (!finalEmoji) {
        const lvl = userContext.attitudeLevel;
        if (lvl === 'hostile') {
          finalEmoji = GOAT_EMOJIS.goat_scream;
        } else if (lvl === 'cautious') {
          finalEmoji = GOAT_EMOJIS.goat_meditate;
        } else if (lvl === 'friendly') {
          finalEmoji = GOAT_EMOJIS.goat_smile;
        } else if (lvl === 'familiar') {
          finalEmoji = GOAT_EMOJIS.goat_small_bleat;
        } else if (sentimentAnalysis.originalSentiment <= SENTIMENT_THRESHOLDS.AUTO_EMOJI_NEGATIVE) {
          finalEmoji = GOAT_EMOJIS.goat_exhausted;
        } else if (sentimentAnalysis.originalSentiment >= SENTIMENT_THRESHOLDS.AUTO_EMOJI_POSITIVE) {
          finalEmoji = GOAT_EMOJIS.goat_smile;
        }
      }

      if (!replyText) replyText = "bleat.";

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
      storeConversationMemory(
        userId,
        channelId,
        interaction._interjection ? '[interjection]' : (userRequest || '[context]'),
        replyText,
        sentimentAnalysis.sentiment,
        isContextOnly
      ).catch(e =>
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

    } catch (error) {
      await handleCommandError(interaction, error, {
        hasRequest: !!interaction.options.getString('request')
      });
    }
  }
};
