// src/events/client/messageCreate.js
const logger = require('../../utils/logger');
const { handleWatchedMessage } = require('../../utils/joinGate/enforcement');

/** Discord's typing indicator lasts ~10s; refresh just inside that. */
const TYPING_REFRESH_MS = 8_000;
/** Never leave the indicator running longer than this, whatever happens. */
const TYPING_MAX_MS = 90_000;

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
    if (!botId || !message.mentions.users.has(botId)) return;

    // Extract the rest of the message after the mention as the "request"
    const mentionRegex = new RegExp(`<@!?${botId}>\\s*`, 'gi');
    const requestText = message.content.replace(mentionRegex, '').trim();

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
      async reply(resp) {
        this._stopTyping();
        this.replied = true;
        const msg = await message.channel.send(resp);
        this._lastReply = msg;
        return msg;
      },
      async editReply(resp) {
        this._stopTyping();
        if (this._lastReply) {
          return this._lastReply.edit(resp);
        }
        this.replied = true;
        const msg = await message.channel.send(resp);
        this._lastReply = msg;
        return msg;
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
