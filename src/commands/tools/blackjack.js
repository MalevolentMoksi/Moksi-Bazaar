// src/commands/tools/blackjack.js
const { SlashCommandBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

const games = new Map(); // active games keyed by userId

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play blackjack, beg for cash, or check your balance')
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
        .setName('hit')
        .setDescription('Draw another card')
    )
    .addSubcommand(sub =>
      sub
        .setName('stand')
        .setDescription('Finish your turn and let the dealer play')
    )
    .addSubcommand(sub =>
      sub
        .setName('beg')
        .setDescription('If you have $0, get $100 to play again')
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
      // — Beg for cash if broke —
      if (sub === 'beg') {
        const bal = await getBalance(userId);
        if (bal > 0) {
          return interaction.reply({
            content: `${mention}, you still have $${bal}. You can only beg if your balance is $0.`,
            ephemeral: true
          });
        }
        await updateBalance(userId, 100);
        return interaction.reply(`${mention}, you have been given $100. Your new balance is $100.`);
      }

      // — Check balance anytime —
      if (sub === 'balance') {
        const bal = await getBalance(userId);
        return interaction.reply({ content: `${mention}, your current balance is $${bal}.`, ephemeral: true });
      }

      // — Start a new game —
      if (sub === 'start') {
        if (games.has(userId)) {
          return interaction.reply({
            content: `${mention}, you already have an active game! Use /blackjack hit or /blackjack stand.`,
            ephemeral: true
          });
        }

        const bet = interaction.options.getInteger('bet');
        let bal   = await getBalance(userId);

        if (bet <= 0) {
          return interaction.reply({ content: `${mention}, your bet must be > 0.`, ephemeral: true });
        }
        if (bet > bal) {
          return interaction.reply({ content: `${mention}, you only have $${bal} to bet.`, ephemeral: true });
        }

        // Deduct bet immediately
        bal -= bet;
        await updateBalance(userId, bal);

        // Deal initial cards
        const playerCards = [drawCard(), drawCard()];
        const dealerCards = [drawCard(), drawCard()];
        games.set(userId, { bet, bal, playerCards, dealerCards });

        const playerSum = playerCards.reduce((a,b) => a + b, 0);
        return interaction.reply(
          `${mention}, you’ve bet $${bet}.\n` +
          `Your hand: [${playerCards.join(', ')}] (total ${playerSum}).\n` +
          `Dealer shows: [${dealerCards[0]}, ?]\n` +
          `Use /blackjack hit or /blackjack stand.`
        );
      }

      // For hit/stand, ensure an active game exists
      if (!games.has(userId)) {
        return interaction.reply({
          content: `${mention}, you have no active game. Start one with /blackjack start <bet>.`,
          ephemeral: true
        });
      }

      // Pull game state
      const game = games.get(userId);
      let { bet, bal, playerCards, dealerCards } = game;

      // — Hit: draw one for the player —
      if (sub === 'hit') {
        const card = drawCard();
        playerCards.push(card);
        const playerSum = playerCards.reduce((a,b) => a + b, 0);

        if (playerSum > 21) {
          games.delete(userId);
          return interaction.reply(
            `${mention}, you drew a ${card}. Your hand: [${playerCards.join(', ')}] (total ${playerSum}) and busted!\n` +
            `You lose your bet of $${bet}. Your balance remains $${bal}.`
          );
        }

        return interaction.reply(
          `${mention}, you drew a ${card}. Your hand: [${playerCards.join(', ')}] (total ${playerSum}).\n` +
          `Use /blackjack hit or /blackjack stand.`
        );
      }

      // — Stand: resolve the hand —
      if (sub === 'stand') {
        let dealerSum = dealerCards.reduce((a,b) => a + b, 0);
        // Dealer hits to 17+
        while (dealerSum < 17) {
          const c = drawCard();
          dealerCards.push(c);
          dealerSum += c;
        }

        const playerSum = playerCards.reduce((a,b) => a + b, 0);
        let payout = 0, resultMsg;

        // Blackjack on initial deal
        if (playerCards.length === 2 && playerSum === 21) {
          payout    = Math.floor(bet * 2.5);
          resultMsg = `Blackjack! You win $${payout}.`;
        }
        // Bust
        else if (playerSum > 21) {
          resultMsg = `Bust—dealer wins. You lose $${bet}.`;
        }
        // Player wins
        else if (dealerSum > 21 || playerSum > dealerSum) {
          payout    = bet * 2;
          resultMsg = `You win $${payout}!`;
        }
        // Push
        else if (playerSum === dealerSum) {
          payout    = bet;
          resultMsg = `Push—your $${bet} is returned.`;
        }
        // Dealer wins
        else {
          resultMsg = `Dealer wins. You lose $${bet}.`;
        }

        // Update balance
        bal += payout;
        await updateBalance(userId, bal);
        games.delete(userId);

        return interaction.reply(
          `${mention}, final hands:\n` +
          `• You:   [${playerCards.join(', ')}] (total ${playerSum})\n` +
          `• Dealer:[${dealerCards.join(', ')}] (total ${dealerSum})\n` +
          `${resultMsg} Your new balance is $${bal}.`
        );
      }

    } catch (err) {
      console.error('Blackjack command error:', err);
      return interaction.reply({
        content: `${mention}, something went wrong. Please try again later.`,
        ephemeral: true
      });
    }
  }
};
