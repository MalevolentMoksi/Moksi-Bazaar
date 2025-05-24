const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

// In-memory active games keyed by userId
const games = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play blackjack with interactive buttons, beg for cash, or check your balance')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('Start a new blackjack game')
        .addIntegerOption(opt =>
          opt
            .setName('bet')
            .setDescription('Amount to wager')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('beg')
        .setDescription('Get $100 if you have $0 (else you get roasted)')
    )
    .addSubcommand(sub =>
      sub
        .setName('balance')
        .setDescription('Check your current balance')
    ),

  async execute(interaction) {
    const userId  = interaction.user.id;
    const mention = interaction.user.toString();
    const sub     = interaction.options.getSubcommand();
    const drawCard = () => Math.floor(Math.random() * 11) + 1;

    try {
      // — Beg for cash —
      if (sub === 'beg') {
        const bal = await getBalance(userId);
        if (bal > 0) {
          return interaction.reply(
            `${mention}, nice try—but you still have $${bal}! You can only beg when you’re flat broke.`
          );
        }
        await updateBalance(userId, 100);
        return interaction.reply(
          `${mention}, a benevolent stranger dropped $100 in your lap. Your new balance is $100.`
        );
      }

      // — Balance check —
      if (sub === 'balance') {
        const bal = await getBalance(userId);
        return interaction.reply(
          `${mention}, your current balance is $${bal}.`
        );
      }

      // — Start a new game with interactive buttons —
      if (sub === 'start') {
        if (games.has(userId)) {
          return interaction.reply(
            `${mention}, you already have an active game! Use the buttons on your ongoing game.`
          );
        }

        const bet = interaction.options.getInteger('bet');
        let bal   = await getBalance(userId);

        if (bet <= 0) {
          return interaction.reply(`${mention}, your bet must be greater than 0.`);
        }
        if (bet > bal) {
          return interaction.reply(`${mention}, you only have $${bal} to bet.`);
        }

        // Deduct bet immediately
        bal -= bet;
        await updateBalance(userId, bal);

        // Deal initial cards
        const playerCards = [drawCard(), drawCard()];
        const dealerCards = [drawCard(), drawCard()];
        games.set(userId, { bet, bal, playerCards, dealerCards, doubled: false });

        const playerSum = playerCards.reduce((a, b) => a + b, 0);

        // Determine if double down is allowed
        const canDouble = bal >= bet;

        // Build Hit, Stand & Double Down buttons
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`hit_${userId}`)
            .setLabel('Hit')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`stand_${userId}`)
            .setLabel('Stand')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`double_${userId}`)
            .setLabel(`Double Down ($${bet})`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!canDouble)
        );

        const content =
          `${mention}, you’ve wagered $${bet}.
` +
          `**Your hand:** [${playerCards.join(', ')}] (total **${playerSum}**)
` +
          `**Dealer shows:** [${dealerCards[0]}, ?]`;

        // Send initial game message with buttons
        const gameMessage = await interaction.reply({ content, components: [row], fetchReply: true });

        // Create a button collector for this game
        const collector = gameMessage.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 120000,
          filter: i => i.user.id === userId
        });

        collector.on('collect', async i => {
          await i.deferUpdate();
          const game = games.get(userId);
          if (!game) {
            return i.followUp({
              content: `${mention}, no active game found. Start a new one with /blackjack start.`,
              ephemeral: true
            });
          }

          let { bet, bal, playerCards, dealerCards, doubled } = game;

          // — Handle Double Down —
          if (i.customId === `double_${userId}` && !doubled) {
            if (bal < bet) {
              return i.followUp({ content: `${mention}, you don’t have enough to double down.`, ephemeral: true });
            }
            // Deduct additional bet
            bal -= bet;
            await updateBalance(userId, bal);
            bet *= 2;
            doubled = true;

            // Draw one card and then stand
            const card = drawCard();
            playerCards.push(card);
            const playerSum = playerCards.reduce((a, b) => a + b, 0);

            // Prepare to resolve game
            let dealerSum = dealerCards.reduce((a,b) => a + b, 0);
            while (dealerSum < 17) {
              const c = drawCard(); dealerCards.push(c); dealerSum += c;
            }

            // Determine result
            let payout = 0;
            let resultMsg = '';
            if (playerSum > 21) {
              resultMsg = `Bust—dealer wins. You lose $${bet}.`;
            } else if (dealerSum > 21 || playerSum > dealerSum) {
              payout = bet * 2;
              resultMsg = `You win $${payout}!`;
            } else if (playerSum === dealerSum) {
              payout = bet;
              resultMsg = `Push—your $${bet} is returned.`;
            } else {
              resultMsg = `Dealer wins. You lose $${bet}.`;
            }

            bal += payout;
            await updateBalance(userId, bal);
            games.delete(userId);

            // disable all buttons
            row.components.forEach(b => b.setDisabled(true));

            return i.editReply({
              content:
                `${mention}, **Final Hands**
` +
                `• You:   [${playerCards.join(', ')}] (total **${playerSum}**)
` +
                `• Dealer:[${dealerCards.join(', ')}] (total **${dealerSum}**)
` +
                `${resultMsg} Your new balance is $${bal}.`,
              components: [row]
            });
          }

          // — Handle Hit —
          if (i.customId === `hit_${userId}`) {
            if (doubled) return; // no hitting after doubled
            const card = drawCard();
            playerCards.push(card);
            const playerSum = playerCards.reduce((a, b) => a + b, 0);

            if (playerSum > 21) {
              games.delete(userId);
              row.components.forEach(b => b.setDisabled(true));
              return i.editReply({
                content:
                  `${mention}, you drew a ${card}.
` +
                  `**Your hand:** [${playerCards.join(', ')}] (total **${playerSum}**) and **busted**!
` +
                  `You lose $${bet}. Balance: $${bal}.`,
                components: [row]
              });
            }

            games.set(userId, { bet, bal, playerCards, dealerCards, doubled });
            return i.editReply({
              content:
                `${mention}, you drew a ${card}.
` +
                `**Your hand:** [${playerCards.join(', ')}] (total **${playerSum}**)
` +
                `Use the buttons to continue.`,
              components: [row]
            });
          }

          // — Handle Stand —
          if (i.customId === `stand_${userId}`) {
            let dealerSum = dealerCards.reduce((a, b) => a + b, 0);
            while (dealerSum < 17) {
              const c = drawCard(); dealerCards.push(c); dealerSum += c;
            }

            const playerSum = playerCards.reduce((a, b) => a + b, 0);
            let payout = 0;
            let resultMsg = '';

            if (playerSum > 21) {
              resultMsg = `Bust—dealer wins. You lose $${bet}.`;
            } else if (dealerSum > 21 || playerSum > dealerSum) {
              payout = bet * 2;
              resultMsg = `You win $${payout}!`;
            } else if (playerSum === dealerSum) {
              payout = bet;
              resultMsg = `Push—your $${bet} is returned.`;
            } else {
              resultMsg = `Dealer wins. You lose $${bet}.`;
            }

            bal += payout;
            await updateBalance(userId, bal);
            games.delete(userId);
            row.components.forEach(b => b.setDisabled(true));

            return i.editReply({
              content:
                `${mention}, **Final Hands**
` +
                `• You:   [${playerCards.join(', ')}] (total **${playerSum}**)
` +
                `• Dealer:[${dealerCards.join(', ')}] (total **${dealerSum}**)
` +
                `${resultMsg} Your new balance is $${bal}.`,
              components: [row]
            });
          }
        });

        return;
      }

    } catch (err) {
      console.error('Blackjack error:', err);
      return interaction.reply({ content: `${mention}, something went wrong. Please try again later.`, ephemeral: false });
    }
  }
};
