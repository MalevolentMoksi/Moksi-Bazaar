// src/events/client/messageCreate.js
module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    // Ignore bots
    if (message.author.bot) return;

    const content = message.content.trim();
    // Only handle messages starting with "."
    if (!content.startsWith('.')) return;

    // Split into [cmdName, subcommand, arg, ...]
    // e.g. ".bj play 50" → ["bj","play","50"]
    const parts = content.slice(1).split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const rawSub = parts[1]?.toLowerCase() || 'start';
    const arg    = parts[2];

    // Try to find a matching command
    const cmd = client.commands.get(cmdName);
    if (!cmd) return;

    // Map old ".bj play" → sub "start"
    const sub = (cmdName === 'bj' && rawSub === 'play') ? 'start' : rawSub;

    // Build a pseudo-interaction for your slash‐style handlers
    const interaction = {
      user: message.author,
      options: {
        getSubcommand: () => sub,
        getInteger: name => {
          if (name === 'bet') {
            const n = parseInt(arg, 10);
            return Number.isNaN(n) ? null : n;
          }
          return null;
        }
      },
      // Reply publicly
      reply: resp => message.channel.send(resp)
    };

    // Dispatch
    try {
      await cmd.execute(interaction);
    } catch (err) {
      console.error('Prefix-command error:', err);
      message.channel.send(`⚠️ Something went wrong: ${err.message}`);
    }
  }
};
