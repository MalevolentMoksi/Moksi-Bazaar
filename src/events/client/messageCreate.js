// src/events/client/messageCreate.js
module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    if (message.author.bot) return;
    const content = message.content.trim();
    if (!content.startsWith('.')) return;

    const parts = content.slice(1).split(/\s+/);
    const rawCmd = parts[0].toLowerCase();

    // alias map from earlier
    const aliasMap = { r: 'roulette', bj: 'bj' };
    const cmdName = aliasMap[rawCmd] ?? rawCmd;
    const rawSub = parts[1]?.toLowerCase() || 'start';
    const sub = (cmdName === 'bj' && rawSub === 'play') ? 'start' : rawSub;

    const cmd = client.commands.get(cmdName);
    if (!cmd) return;

    const interaction = {
      user: message.author,
      options: {
        getSubcommand: () => sub,

        // ◀ UPDATED ▶  
        getInteger: name => {
          if (name === 'bet') {
            // blackjack still uses parts[2]
            const n = parseInt(parts[2], 10);
            return Number.isNaN(n) ? null : n;
          }
          if (name === 'amount') {
            // try parts[3], then [2], then [1]
            for (let idx = 3; idx >= 1; idx--) {
              const v = parts[idx];
              const n = parseInt(v, 10);
              if (!Number.isNaN(n)) return n;
            }
            return null;
          }
          return null;
        },

        getString: name => {
          if (name === 'numbers' || name === 'color') {
            return parts[2] || null;
          }
          return null;
        }
      },
      reply: resp => message.channel.send(resp)
    };

    try {
      await cmd.execute(interaction);
    } catch (err) {
      console.error('Prefix-command error:', err);
      message.channel.send(`⚠️ Something went wrong: ${err.message}`);
    }
  }
};
