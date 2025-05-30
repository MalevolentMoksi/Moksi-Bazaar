// src/events/client/messageCreate.js
module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    if (message.author.bot) return;
    const content = message.content.trim();
    if (!content.startsWith('.')) return;

    const parts = content.slice(1).split(/\s+/);
    const rawCmd = parts[0].toLowerCase();

    // Alias map for prefix commands
    const aliasMap = { r: 'roulette', bj: 'bj' };
    const cmdName = aliasMap[rawCmd] ?? rawCmd;
    const cmd = client.commands.get(cmdName);
    if (!cmd) return;

    // --- Enhanced prefix handling and validation for roulette ---
    if (cmdName === 'roulette') {
      const rawSub = parts[1]?.toLowerCase();
      const validSubs = ['color', 'number'];
      if (!rawSub || !validSubs.includes(rawSub)) {
        return message.channel.send(
          '❌ Invalid subcommand for roulette.\n' +
          'Usage:\n' +
          '• .roulette color <red|black|green> <amount>\n' +
          '• .roulette number <n1,n2,..,nN> <amount>'
        );
      }

      let opts = {};
      if (rawSub === 'color') {
        // Expect exactly: .roulette color <color> <amount>
        if (parts.length !== 4) {
          return message.channel.send(
            '❌ Invalid format.\n' +
            'Usage: .roulette color <red|black|green> <amount>'
          );
        }
        const colorValue = parts[2].toLowerCase();
        const validColors = ['red', 'black', 'green'];
        if (!validColors.includes(colorValue)) {
          return message.channel.send('❌ Invalid color. Choose: red, black, or green.');
        }
        const amount = parseInt(parts[3], 10);
        if (isNaN(amount) || amount < 1) {
          return message.channel.send('❌ Invalid bet amount. Must be a positive integer.');
        }
        opts = { sub: 'color', color: colorValue, amount };

      } else {
        // rawSub === 'number'
        // Expect: .roulette number <n1,n2,...> <amount>
        if (parts.length < 4) {
          return message.channel.send(
            '❌ Invalid format.\n' +
            'Usage: .roulette number <n1,n2,..,nN> <amount>'
          );
        }
        const amount = parseInt(parts[parts.length - 1], 10);
        if (isNaN(amount) || amount < 1) {
          return message.channel.send('❌ Invalid bet amount. Must be a positive integer.');
        }
        // Reconstruct numbers string by joining parts[2] through parts[-2]
        const numbersString = parts.slice(2, -1).join('');
        if (!numbersString) {
          return message.channel.send(
            '❌ Invalid numbers. Provide comma-separated numbers between 0 and 36.'
          );
        }
        opts = { sub: 'number', numbers: numbersString, amount };
      }

      // Build a pseudo-interaction for roulette with validated options
      const interaction = {
        user: message.author,
        guild: message.guild,
        channel: message.channel, // ← (optional) if any commands use interaction.channel
        options: {
          getSubcommand: () => opts.sub,
          getString: name => {
            if (name === 'color') return opts.color;
            if (name === 'numbers') return opts.numbers;
            return null;
          },
          getInteger: name => (name === 'amount' ? opts.amount : null)
        },
        replied: false,
        deferred: false,
        lastReply: null,
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

      try {
        await cmd.execute(interaction);
      } catch (err) {
        console.error('Prefix-command error:', err);
        message.channel.send(`⚠️ Something went wrong: ${err.message}`);
      }
      return;
    }

    // --- Fallback for other prefix commands (e.g., blackjack, currency) ---
    const rawSub = parts[1]?.toLowerCase() || 'start';
    const sub = (cmdName === 'bj' && rawSub === 'play') ? 'start' : rawSub;

    const interaction = {
      user: message.author,
      guild: message.guild,        // ← inject the real Guild
      channel: message.channel,    // ← (optional) if any cmd uses channel directly
      options: {
        getSubcommand: () => sub,
        getInteger: name => {
          if (name === 'bet') {
            const n = parseInt(parts[2], 10);
            return Number.isNaN(n) ? null : n;
          }
          if (name === 'amount') {
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
      replied: false,
      deferred: false,
      lastReply: null,
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

    try {
      console.log('🧪 stub.interaction.guild is', interaction.guild);
      await cmd.execute(interaction);
    } catch (err) {
      console.error('Prefix-command error:', err);
      message.channel.send(`⚠️ Something went wrong: ${err.message}`);
    }
  }
};
