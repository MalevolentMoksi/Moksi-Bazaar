// src/events/client/messageCreate.js
module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    // 1) Ignore bots & wrong prefix
    if (message.author.bot) return;
    const prefix = '.blackjack';
    if (!message.content.toLowerCase().startsWith(prefix)) return;

    // 2) Parse subcommand + arg
    const [ , sub = '' , arg = '' ] = message.content
      .trim()
      .slice(prefix.length)
      .trim()
      .split(/\s+/);

    const subcommand = sub.toLowerCase() || 'start';

    // 3) Build a “pseudo‐interaction”
    const interaction = {
      user: message.author,
      // toString on a User mention works same as interaction.user.toString()
      options: {
        getSubcommand: () => subcommand,
        getInteger: (name) => {
          const n = parseInt(arg, 10);
          return isNaN(n) ? null : n;
        }
      },
      reply: (content) => message.channel.send(content)
    };

    // 4) Lookup the slash‐command handler and call it
    const cmd = client.commands.get('blackjack');
    if (!cmd) return;
    try {
      await cmd.execute(interaction, client);
    } catch (err) {
      console.error('Prefix‐cmd error:', err);
      message.channel.send(`⚠️ Something went wrong: ${err.message}`);
    }
  }
};
