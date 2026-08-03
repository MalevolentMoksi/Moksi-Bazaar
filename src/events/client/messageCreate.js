// src/events/client/messageCreate.js
const logger = require('../../utils/logger');
const { handleWatchedMessage } = require('../../utils/joinGate/enforcement');
const { getSpeakConfigValue } = require('../../utils/db');

/** Discord's typing indicator lasts ~10s; refresh just inside that. */
const TYPING_REFRESH_MS = 8_000;
/** Never leave the indicator running longer than this, whatever happens. */
const TYPING_MAX_MS = 90_000;

// ── Interjections ───────────────────────────────────────────────────────────
// channelId -> last interjection timestamp. In-memory on purpose: a restart
// resetting a cooldown is harmless, and this check runs per guild message.
const lastInterjection = new Map();

/**
 * Decides whether the bot should butt into a conversation it was not part of.
 * Ordered cheapest-first; the config read is cached in db.js.
 */
async function shouldInterject(message) {
    const config = await getSpeakConfigValue('interjections', null);
    if (!config?.enabled) return false;

    // Channel allowlist is mandatory: "everywhere" is not a mode this ships with.
    if (!Array.isArray(config.channels) || !config.channels.includes(message.channelId)) return false;

    // Keyword filter, when set, is a hard requirement (e.g. only when "moksi"
    // comes up in the staff channel). Without keywords, any message may roll.
    const keywords = Array.isArray(config.keywords) ? config.keywords.filter(Boolean) : [];
    if (keywords.length > 0) {
        const content = message.content?.toLowerCase() ?? '';
        if (!keywords.some(kw => content.includes(String(kw).toLowerCase()))) return false;
    }

    // Cooldown before the dice roll, so a hot channel cannot brute-force it.
    const cooldownMs = Math.max(1, Number(config.cooldownMinutes) || 10) * 60_000;
    const last = lastInterjection.get(message.channelId) ?? 0;
    if (Date.now() - last < cooldownMs) return false;

    const chance = Math.min(100, Math.max(0, Number(config.chance) || 0));
    if (Math.random() * 100 >= chance) return false;

    lastInterjection.set(message.channelId, Date.now());
    return true;
}

module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    if (message.author.bot) return;
    if (!message.guild) return; // Ignore DMs

    // Join-gate behaviour window. Runs before the mention check because it
    // applies to every message from a recently joined member, not just ones
    // aimed at the bot. It short-circuits on an in-memory lookup when nobody
    // is being watched, so the common case costs almost nothing.
    handleWatchedMessage(message).catch(error =>
      logger.error('Join gate watch handler failed', { error: error.message })
    );

    const botId = client.user?.id;
    if (!botId) return;

    // Two triggers: a direct @mention, or using Discord's reply function on
    // one of the bot's own messages. The reply path matters because replying
    // with the ping toggled off adds nothing to `mentions`, so people who
    // continued a conversation the natural way used to get silence.
    let triggered = message.mentions.users.has(botId);
    if (!triggered && message.reference?.messageId) {
      const referenced = message.channel.messages.cache.get(message.reference.messageId)
        ?? await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      triggered = referenced?.author?.id === botId;
    }

    // Third trigger: unprompted interjection, if this message clears the
    // owner-configured channel/keyword/chance/cooldown gauntlet.
    let interjecting = false;
    if (!triggered) {
      interjecting = await shouldInterject(message).catch(() => false);
      if (!interjecting) return;
    }

    // Extract the rest of the message after the mention as the "request".
    // Interjections carry no request at all: nobody addressed the bot, and
    // the message it is reacting to is already in the chat log it reads.
    const mentionRegex = new RegExp(`<@!?${botId}>\\s*`, 'gi');
    const requestText = interjecting ? '' : message.content.replace(mentionRegex, '').trim();

    // Build a compatibility interaction object for speak.js
    const interaction = {
      user: message.author,
      member: message.member,
      guild: message.guild,
      guildId: message.guild.id,
      channel: message.channel,
      channelId: message.channel.id,
      client: client,
      commandName: 'speak',
      options: {
        getString: (name) => (name === 'request' ? (requestText || null) : null),
      },
      // Expose the original message so speak.js can detect reply-chain context
      // (Discord slash commands have no native reply reference; mentions do).
      _sourceMessage: message,
      _interjection: interjecting,
      deferred: false,
      replied: false,
      _lastReply: null,
      _typingTimer: null,

      // Discord clears the typing indicator after ~10s, but a reply can take
      // considerably longer than that. Refreshing it keeps the bot looking
      // like someone actually typing rather than like it died.
      _startTyping() {
        this._stopTyping();
        message.channel.sendTyping().catch(() => {});
        this._typingTimer = setInterval(() => {
          message.channel.sendTyping().catch(() => {});
        }, TYPING_REFRESH_MS);
        this._typingTimer.unref?.();
        // Hard stop, so a path that never replies cannot leave it running.
        this._typingDeadline = setTimeout(() => this._stopTyping(), TYPING_MAX_MS);
        this._typingDeadline.unref?.();
      },
      _stopTyping() {
        if (this._typingTimer) { clearInterval(this._typingTimer); this._typingTimer = null; }
        if (this._typingDeadline) { clearTimeout(this._typingDeadline); this._typingDeadline = null; }
      },

      async deferReply() {
        this.deferred = true;
        this._startTyping();
      },
      /**
       * Sends as a native Discord reply to the triggering message, so the
       * client renders its own "replying to" header instead of the bot
       * hand-building a quote block.
       *
       * failIfNotExists keeps this safe when the original was deleted between
       * the mention and the answer: Discord downgrades it to a normal message
       * rather than rejecting the send.
       */
      async _send(resp) {
        const payload = typeof resp === 'string' ? { content: resp } : { ...resp };
        payload.failIfNotExists = false;
        // An interjection is the bot butting in uninvited; replying is useful
        // for context, but pinging someone who never asked would be obnoxious.
        if (interjecting) payload.allowedMentions = { repliedUser: false, parse: [] };
        const msg = await message.reply(payload);
        this._lastReply = msg;
        return msg;
      },

      async reply(resp) {
        this._stopTyping();
        this.replied = true;
        return this._send(resp);
      },
      async editReply(resp) {
        this._stopTyping();
        if (this._lastReply) {
          return this._lastReply.edit(resp);
        }
        this.replied = true;
        return this._send(resp);
      },
      // speak.js never calls this any more, but a missing method here used to
      // throw straight into a silent catch. Keep the shim API-complete.
      async followUp(resp) {
        this._stopTyping();
        return message.channel.send(resp);
      },
      async fetchReply() {
        return this._lastReply;
      }
    };

    const speakCmd = client.commands.get('speak');
    if (speakCmd && speakCmd.execute) {
      try {
        await speakCmd.execute(interaction, client);
      } catch (err) {
        logger.error('Speak via mention failed', { error: err.message, userId: message.author.id });
        message.reply('⚠️ Could not run /speak for this mention.').catch(() => {});
      }
    }
  }
};
