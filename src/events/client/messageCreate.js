// src/events/client/messageCreate.js
module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    // Ignore bots
    if (message.author.bot) return;

    const content = message.content.trim();
    // Only handle messages starting with "."
    if (!content.startsWith('.')) return;

    // Split into [cmdName, subcommand, arg1, arg2, ...]
    // e.g. ".roulette number 1,2,3 50" → ["roulette","number","1,2,3","50"]
    const parts = content.slice(1).split(/\s+/);
    
    // First token after "." (e.g. ".r" → "r")
    const rawCmd = parts[0].toLowerCase();

    // ---- simple alias map --------------------------------------------------
    // keys: what the user types   values: the real slash-command name
    const aliasMap = {
      r: 'roulette',   // ".r"  -> ".roulette"
      bj: 'bj'         // keep ".bj" as is (already used below)
      // add more aliases here as needed
    };

    const cmdName = aliasMap[rawCmd] ?? rawCmd;
    const rawSub = parts[1]?.toLowerCase() || 'start';

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
          // Blackjack uses 'bet'
          if (name === 'bet') {
            const n = parseInt(parts[2], 10);
            return Number.isNaN(n) ? null : n;
          }
          // Roulette uses 'amount' in the 4th position
          if (name === 'amount') {
            const n = parseInt(parts[3], 10);
            return Number.isNaN(n) ? null : n;
          }
          return null;
        },
        getString: name => {
          // Roulette 'number' subcommand passes a comma list
          if (name === 'numbers') {
            return parts[2] || null;
          }
          // Roulette 'color' subcommand passes the color
          if (name === 'color') {
            return parts[2] || null;
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
