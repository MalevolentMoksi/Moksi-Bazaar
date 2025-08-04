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

    // const content = message.content.trim();
    // if (!content.startsWith('.')) return;

    // const parts = content.slice(1).split(/\s+/);
    // const rawCmd = parts[0].toLowerCase();

    // // Alias map for prefix commands
    // const aliasMap = { r: 'roulette', bj: 'bj', hl: 'highlow' };
    // const cmdName = aliasMap[rawCmd] ?? rawCmd;
    // const cmd = client.commands.get(cmdName);
    // if (!cmd) return;

    // // --- Enhanced prefix handling and validation for roulette ---
    // if (cmdName === 'roulette') {
    //   const rawSub = parts[1]?.toLowerCase();
    //   const validSubs = ['color', 'number'];
    //   if (!rawSub || !validSubs.includes(rawSub)) {
    //     return message.channel.send(
    //       '❌ Invalid subcommand for roulette.\n' +
    //       'Usage:\n' +
    //       '• .roulette color <red|black|green> <amount>\n' +
    //       '• .roulette number <n1,n2,..,nN> <amount>'
    //     );
    //   }

    //   let opts = {};
    //   if (rawSub === 'color') {
    //     // Expect exactly: .roulette color <color> <amount>
    //     if (parts.length !== 4) {
    //       return message.channel.send(
    //         '❌ Invalid format.\n' +
    //         'Usage: .roulette color <red|black|green> <amount>'
    //       );
    //     }
    //     const colorValue = parts[2].toLowerCase();
    //     const validColors = ['red', 'black', 'green'];
    //     if (!validColors.includes(colorValue)) {
    //       return message.channel.send('❌ Invalid color. Choose: red, black, or green.');
    //     }
    //     const amount = parseInt(parts[3], 10);
    //     if (isNaN(amount) || amount < 1) {
    //       return message.channel.send('❌ Invalid bet amount. Must be a positive integer.');
    //     }
    //     opts = { sub: 'color', color: colorValue, amount };

    //   } else {
    //     // rawSub === 'number'
    //     // Expect: .roulette number <n1,n2,...> <amount>
    //     if (parts.length < 4) {
    //       return message.channel.send(
    //         '❌ Invalid format.\n' +
    //         'Usage: .roulette number <n1,n2,..,nN> <amount>'
    //       );
    //     }
    //     const amount = parseInt(parts[parts.length - 1], 10);
    //     if (isNaN(amount) || amount < 1) {
    //       return message.channel.send('❌ Invalid bet amount. Must be a positive integer.');
    //     }
    //     // Reconstruct numbers string by joining parts[2] through parts[-2]
    //     const numbersString = parts.slice(2, -1).join('');
    //     if (!numbersString) {
    //       return message.channel.send(
    //         '❌ Invalid numbers. Provide comma-separated numbers between 0 and 36.'
    //       );
    //     }
    //     opts = { sub: 'number', numbers: numbersString, amount };
    //   }

    //   // Build a pseudo-interaction for roulette with validated options
    //   const interaction = {
    //     user: message.author,
    //     guild: message.guild,
    //     channel: message.channel, // ← (optional) if any commands use interaction.channel
    //     options: {
    //       getSubcommand: () => opts.sub,
    //       getString: name => {
    //         if (name === 'color') return opts.color;
    //         if (name === 'numbers') return opts.numbers;
    //         return null;
    //       },
    //       getInteger: name => (name === 'amount' ? opts.amount : null)
    //     },
    //     replied: false,
    //     deferred: false,
    //     lastReply: null,
    //     async deferReply() { this.deferred = true; },
    //     async reply(resp) {
    //       this.replied = true;
    //       const msg = await message.channel.send(resp);
    //       this.lastReply = msg;
    //       return msg;
    //     },
    //     async editReply(resp) {
    //       if (this.lastReply) {
    //         return this.lastReply.edit(resp);
    //       } else {
    //         this.replied = true;
    //         const msg = await message.channel.send(resp);
    //         this.lastReply = msg;
    //         return msg;
    //       }
    //     },
    //     async fetchReply() {
    //       return this.lastReply;
    //     }
    //   };

    //   try {
    //     await cmd.execute(interaction);
    //   } catch (err) {
    //     console.error('Prefix-command error:', err);
    //     message.channel.send(`⚠️ Something went wrong: ${err.message}`);
    //   }
    //   return;
    // }

  //   // --- Fallback for other prefix commands (e.g., blackjack, currency, duel) ---
  //   const firstArg = parts[1];
  //   const isNumeric = firstArg && !isNaN(parseInt(firstArg, 10));
  //   const sub = isNumeric ? 'start' : (firstArg ? firstArg.toLowerCase() : 'start');
  //   const betIndex = isNumeric ? 1 : 2;
  //   // For duel: sub should be 'challenge', 'accept' or 'decline'

  //   const interaction = {
  //     user: message.author,
  //     guild: message.guild,
  //     channel: message.channel,
  //     options: {
  //       getSubcommand: () => sub,
  //       getUser: name => {
  //         if (name === 'user') {
  //           const mention = parts[2];
  //           const m = mention?.match(/^<@!?(\d+)>$/);
  //           return m ? { id: m[1] } : null;
  //         }
  //         return null;
  //       },
  //       getInteger: name => {
  //         if (name === 'amount') {
  //           // look for a number in parts
  //           for (let i = parts.length - 1; i >= 0; i--) {
  //             const n = parseInt(parts[i], 10);
  //             if (!isNaN(n)) return n;
  //           }
  //           return null;
  //         }
  //         if (name === 'bet') {
  //           const n = parseInt(parts[betIndex], 10);
  //           return Number.isNaN(n) ? null : n;
  //         }
  //         return null;
  //       },
  //       getString: name => {
  //         if (name === 'numbers' || name === 'color') {
  //           return parts[2] || null;
  //         }
  //         return null;
  //       }
  //     },
  //     replied: false,
  //     deferred: false,
  //     lastReply: null,
  //     async deferReply() { this.deferred = true; },
  //     async reply(resp) {
  //       this.replied = true;
  //       const msg = await message.channel.send(resp);
  //       this.lastReply = msg;
  //       return msg;
  //     },
  //     async editReply(resp) {
  //       if (this.lastReply) {
  //         return this.lastReply.edit(resp);
  //       } else {
  //         this.replied = true;
  //         const msg = await message.channel.send(resp);
  //         this.lastReply = msg;
  //         return msg;
  //       }
  //     },
  //     async fetchReply() {
  //       return this.lastReply;
  //     }
  //   };

  //   try {
  //     console.log('🧪 stub.interaction.guild is', interaction.guild);
  //     await cmd.execute(interaction);
  //   } catch (err) {
  //     console.error('Prefix-command error:', err);
  //     message.channel.send(`⚠️ Something went wrong: ${err.message}`);
  //   }
   }
};
