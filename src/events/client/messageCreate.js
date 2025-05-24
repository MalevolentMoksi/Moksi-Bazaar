// src/events/client/messageCreate.js
module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    // 1) ignore bots & non‐.blackjack messages
    if (message.author.bot) return;
    const prefix = '.blackjack';
    const content = message.content.trim();
    if (!content.toLowerCase().startsWith(prefix)) return;

    // 2) split into [subcommand, arg]
    //    e.g. ".blackjack play 50" → ["play","50"]
    const parts = content.slice(prefix.length).trim().split(/\s+/);
    const rawSub = parts[0]?.toLowerCase() || 'start';
    const arg    = parts[1];

    // 3) map old "play" → new "start"
    const sub = rawSub === 'play' ? 'start' : rawSub;

    // 4) build a pseudo-interaction that matches your slash handler
    const interaction = {
      user: message.author,
      options: {
        getSubcommand: () => sub,
        getInteger: (name) => {
          // only "bet" is used
          if (name === 'bet') {
            const n = parseInt(arg, 10);
            return isNaN(n) ? null : n;
          }
          return null;
        }
      },
      // reply exactly like slash would, but publicly
      reply: (resp) => message.channel.send(resp)
    };

    // 5) dispatch to your existing /blackjack command
    const cmd = client.commands.get('blackjack');
    if (!cmd) return;
    try {
      await cmd.execute(interaction, client);
    } catch (err) {
      console.error('Prefix‐command error:', err);
      message.channel.send(`⚠️ Something went wrong: ${err.message}`);
    }
  }
};
