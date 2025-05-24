const { SlashCommandBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play a game of blackjack or get free money')
    .addSubcommand(sub =>
      sub.setName('play')
         .setDescription('Place a bet and play blackjack')
         .addIntegerOption(opt =>
           opt.setName('bet')
              .setDescription('Amount to bet')
              .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('beg')
         .setDescription('Get 100 currency if you have no money')),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.toString();

    // Beg for money if broke
    if (interaction.options.getSubcommand() === 'beg') {
      let balance = await getBalance(userId);
      if (balance > 0) {
        return interaction.reply({ content: `${username}, you still have $${balance}. You can only beg if you are broke.`, ephemeral: true });
      }
      balance = 100;
      await updateBalance(userId, balance);
      return interaction.reply(`${username}, you have been given $100. Your new balance is $${balance}.`);
    }

    // Play blackjack
    const bet = interaction.options.getInteger('bet');
    let balance = await getBalance(userId);

    if (bet <= 0) {
      return interaction.reply({ content: `${username}, your bet must be greater than 0.`, ephemeral: true });
    }
    if (bet > balance) {
      return interaction.reply({ content: `${username}, you only have $${balance} to bet.`, ephemeral: true });
    }

    // Deduct bet upfront
    balance -= bet;
    await updateBalance(userId, balance);

    // Helper to draw a random card (1-11)
    const drawCard = () => Math.floor(Math.random() * 11) + 1;

    // Player hand
    const playerCards = [drawCard(), drawCard()];
    const playerSum = playerCards.reduce((a, b) => a + b, 0);

    // Dealer hand
    const dealerCards = [drawCard(), drawCard()];
    let dealerSum = dealerCards[0] + dealerCards[1];

    // Check for blackjack
    if (playerSum === 21) {
      const payout = Math.floor(bet * 2.5);
      balance += payout;
      await updateBalance(userId, balance);
      return interaction.reply(
        `${username}, you drew [${playerCards.join(', ')}] for a total of ${playerSum} (Blackjack!).\n` +
        `Dealer had [${dealerCards.join(', ')}].\n` +
        `You win $${payout}! Your new balance is $${balance}.`
      );
    }

    // Dealer draws until 17+
    while (dealerSum < 17) {
      const card = drawCard();
      dealerCards.push(card);
      dealerSum += card;
    }

    // Determine outcome
    let resultMessage;
    if (playerSum > 21) {
      resultMessage = `Bust! You lose your bet of $${bet}.`;
    } else if (dealerSum > 21 || playerSum > dealerSum) {
      const payout = bet * 2;
      balance += payout;
      await updateBalance(userId, balance);
      resultMessage = `You win! You receive $${payout}.`;
    } else if (playerSum === dealerSum) {
      // Push: return bet
      balance += bet;
      await updateBalance(userId, balance);
      resultMessage = `Push! Your bet of $${bet} is returned.`;
    } else {
      resultMessage = `Dealer wins! You lose your bet of $${bet}.`;
    }

    return interaction.reply(
      `${username}, you drew [${playerCards.join(', ')}] (total ${playerSum}).\n` +
      `Dealer's cards: [${dealerCards.join(', ')}] (total ${dealerSum}).\n` +
      `${resultMessage} Your new balance is $${balance}.`
    );
  },
};
