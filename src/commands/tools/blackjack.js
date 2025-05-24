// src/commands/tools/blackjack.js
const { SlashCommandBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

const games = new Map(); // in‐memory active games

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play a game of blackjack or beg for cash')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('Start a new blackjack game')
        .addIntegerOption(opt =>
          opt
            .setName('bet')
            .setDescription('Amount to bet')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub
        .setName('hit')
        .setDescription('Draw another card'))
    .addSubcommand(sub =>
      sub
        .setName('stand')
        .setDescription('End your turn and let the dealer play'))
    .addSubcommand(sub =>
      sub
        .setName('beg')
        .setDescription('Get $100 if you are broke')),
      
  async execute(interaction) {
    const userId   = interaction.user.id;
    const mention  = interaction.user.toString();
    const sub      = interaction.options.getSubcommand();
    const drawCard = () => Math.floor(Math.random() * 11) + 1;

    // — Beg for cash if broke —
    if (sub === 'beg') {
      let bal = await getBalance(userId);
      if (bal > 0) {
        return interaction.reply({
          content: `${mention}, you still have $${bal}. You can only beg if you have $0.`,
          ephemeral: true
        });
      }
      bal = 100;
      await updateBalance(userId, bal);
      return interaction.reply(`${mention}, you have been given $100. Your new balance is $${bal}.`);
    }

    // — Start a new game —
    if (sub === 'start') {
      if (games.has(userId)) {
        return interaction.reply({
          content: `${mention}, you already have an active game! Use /blackjack hit or stand.`,
          ephemeral: true
        });
      }

      const bet = interaction.options.getInteger('bet');
      let bal   = await getBalance(userId);

      if (bet <= 0) {
        return interaction.reply({ content: `${mention}, your bet must be greater than 0.`, ephemeral: true });
      }
      if (bet > bal) {
        return interaction.reply({ content: `${mention}, you only have $${bal} to bet.`, ephemeral: true });
      }

      // Deduct bet up front
      bal -= bet;
      await updateBalance(userId, bal);

      // Deal initial hands
      const playerCards = [drawCard(), drawCard()];
      const dealerCards = [drawCard(), drawCard()];

      // Store game state
      games.set(userId, { bet, bal, playerCards, dealerCards });

      const playerSum = playerCards.reduce((a,b) => a + b, 0);
      return interaction.reply(
        `${mention}, game started with a $${bet} bet!\n` +
        `Your hand: [${playerCards.join(', ')}] (total ${playerSum}).\n` +
        `Dealer shows: [${dealerCards[0]}, ?]\n` +
        `Use /blackjack hit or /blackjack stand.`
      );
    }

    // From here on, must have an active game
    if (!games.has(userId)) {
      return interaction.reply({
        content: `${mention}, you have no active game. Use /blackjack start first.`,
        ephemeral: true
      });
    }

    // Pull and update the in‐memory game
    const game = games.get(userId);
    let { bet, bal, playerCards, dealerCards } = game;

    // — Hit: draw a card for player —
    if (sub === 'hit') {
      const card     = drawCard();
      playerCards.push(card);
      const playerSum = playerCards.reduce((a,b) => a + b, 0);

      if (playerSum > 21) {
        // Player busts → game over
        games.delete(userId);
        return interaction.reply(
          `${mention}, you drew a ${card} for [${playerCards.join(', ')}] (total ${playerSum}) and busted!\n` +
          `You lose your bet of $${bet}. Your balance remains $${bal}.`
        );
      }

      // Still alive
      return interaction.reply(
        `${mention}, you drew a ${card}. Your hand: [${playerCards.join(', ')}] (total ${playerSum}).\n` +
        `Use /blackjack hit or /blackjack stand.`
      );
    }

    // — Stand: dealer plays out, resolve —
    if (sub === 'stand') {
      let dealerSum = dealerCards.reduce((a,b) => a + b, 0);

      // Dealer hits until 17+
      while (dealerSum < 17) {
        const card = drawCard();
        dealerCards.push(card);
        dealerSum += card;
      }

      const playerSum = playerCards.reduce((a,b) => a + b, 0);
      let resultMsg, payout;

      // Check for player's blackjack on initial deal
      if (playerCards.length === 2 && playerSum === 21) {
        payout    = Math.floor(bet * 2.5);
        resultMsg = `Blackjack! You win $${payout}.`;
      }
      // Standard win/lose/push
      else if (playerSum > 21) {
        resultMsg = `Bust—dealer wins. You lose $${bet}.`;
      } else if (dealerSum > 21 || playerSum > dealerSum) {
        payout    = bet * 2;
        resultMsg = `You win $${payout}!`;
      } else if (playerSum === dealerSum) {
        payout    = bet;
        resultMsg = `Push—your $${bet} is returned.`;
      } else {
        resultMsg = `Dealer wins. You lose $${bet}.`;
      }

      // Apply payout if any
      if (payout) {
        bal += payout;
      }
      await updateBalance(userId, bal);
      games.delete(userId);

      return interaction.reply(
        `${mention}, final hands:\n` +
        `• You: [${playerCards.join(', ')}] (total ${playerSum})\n` +
        `• Dealer: [${dealerCards.join(', ')}] (total ${dealerSum})\n` +
        `${resultMsg} Your new balance is $${bal}.`
      );
    }
  }
};
