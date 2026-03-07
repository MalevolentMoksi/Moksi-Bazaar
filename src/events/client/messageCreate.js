// src/events/client/messageCreate.js
const logger = require('../../utils/logger');

module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    if (message.author.bot) return;
    if (!message.guild) return; // Ignore DMs

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
      deferred: false,
      replied: false,
      _lastReply: null,
      async deferReply() {
        this.deferred = true;
        // Show typing indicator as visual feedback
        await message.channel.sendTyping().catch(() => {});
      },
      async reply(resp) {
        this.replied = true;
        const msg = await message.channel.send(resp);
        this._lastReply = msg;
        return msg;
      },
      async editReply(resp) {
        if (this._lastReply) {
          return this._lastReply.edit(resp);
        }
        this.replied = true;
        const msg = await message.channel.send(resp);
        this._lastReply = msg;
        return msg;
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
