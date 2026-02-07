// src/events/client/messageCreate.js
module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    if (message.author.bot) return;

    // ----- Add this block: If bot is mentioned, run /speak -----
    const botId = message.client.user.id || (message.client.user && message.client.user.id);
    if (message.mentions.users.has(botId)) {
      // Optionally: Extract the rest of the message after the mention as the "request"
      const mentionRegex = new RegExp(`<@!?${botId}>\\s*`, 'i');
      const requestText = message.content.replace(mentionRegex, '').trim();

      // Build a fake interaction object for compatibility
      const interaction = {
        user: message.author,
        guild: message.guild,
        channel: message.channel,
        member: message.member,
        options: {
          getString: (name) => (name === 'request' ? (requestText || null) : null),
          // You may add any getSubcommand/getUser/etc if speak.js ever needs them
        },
        deferred: false, replied: false, lastReply: null,
        async deferReply() { this.deferred = true; },
        async reply(resp) {
          this.replied = true;
          const msg = await message.channel.send(resp);
          this.lastReply = msg;
          return msg;
        },
        async editReply(resp) {
          if (this.lastReply) {
            return this.lastReply.edit(resp);
          } else {
            this.replied = true;
            const msg = await message.channel.send(resp);
            this.lastReply = msg;
            return msg;
          }
        },
        async fetchReply() {
          return this.lastReply;
        }
      };

      // Make sure your client.commands collection is sorted/populated already:
      const speakCmd = message.client.commands.get('speak');
      if (speakCmd && speakCmd.execute) {
        try {
          await speakCmd.execute(interaction);
        } catch (err) {
          console.error('/speak as mention failed:', err);
          message.reply('⚠️ Could not run /speak for this mention.');
        }
      }

      // (Optional) return early to prevent dot-command parsing for ping messages
      return;
    }
  }
};
