// src/commands/tools/blackjack.js
const { SlashCommandBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

const games = new Map(); // in‐memory active games

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
      sub.setName('hit').setDescription('Draw another card')
    )
    .addSubcommand(sub =>
      sub.setName('stand').setDescription('Finish your turn and let the dealer play')
    )
    .addSubcommand(sub =>
      sub.setName('beg').setDescription('Get $100 if you have $0 (else you get roasted)')
    )
    .addSubcommand(sub =>
      sub.setName('balance').setDescription('Check your current balance')
    ),

  async execute(interaction) {
    const userId  = interaction.user.id;
    const mention = interaction.user.toString();
    const sub     = interaction.options.getSubcommand();
    const drawCard = () => Math.floor(Math.random() * 11) + 1;

    try {
      // — Beg for cash (always present) —
      if (sub === 'beg') {
        const bal = await getBalance(userId);
        if (bal > 0) {
          // cheeky public refusal
          return interaction.reply(
            `${mention}, nice try—but you still have $${bal}! You can only beg when you’re flat broke.`
          );
        }
        await updateBalance(userId, 100);
        return interaction.reply(
          `${mention}, a benevolent stranger dropped $100 in your lap. Your new balance is $100.`
        );
      }

      // — Balance check (always present) —
      if (sub === 'balance') {
        const bal = await getBalance(userId);
        return interaction.reply(`${mention}, your current balance is $${bal}.`);
      }

      // — Start a new game —
      if (sub === 'start') {
        if (games.has(userId)) {
          return interaction.reply(
            `${mention}, you already have an active game! Use /blackjack hit or /blackjack stand.`
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
        games.set(userId, { bet, bal, playerCards, dealerCards });

        const playerSum = playerCards.reduce((a,b) => a + b, 0);
        return interaction.reply(
          `${mention}, you’ve wagered $${bet}.\n` +
          `**Your hand:** [${playerCards.join(', ')}] (total **${playerSum}**)\n` +
          `**Dealer shows:** [${dealerCards[0]}, ?]\n` +
          `Type /blackjack hit or /blackjack stand.`
        );
      }

      // — For hit/stand, must have an active game —
      if (!games.has(userId)) {
        return interaction.reply(
          `${mention}, you have no active game. Start one with /blackjack start <bet>.`
        );
      }

      // pull game
      const game = games.get(userId);
      let { bet, bal, playerCards, dealerCards } = game;

      // — Hit —
      if (sub === 'hit') {
        const card     = drawCard();
        playerCards.push(card);
        const playerSum = playerCards.reduce((a,b) => a + b, 0);

        if (playerSum > 21) {
          games.delete(userId);
          return interaction.reply(
            `${mention}, you drew a ${card} → [${playerCards.join(', ')}] (total **${playerSum}**) and **busted**!\n` +
            `You lose your $${bet}. Balance remains $${bal}.`
          );
        }

        return interaction.reply(
          `${mention}, you drew a ${card}. Your hand: [${playerCards.join(', ')}] (total **${playerSum}**).\n` +
          `Use /blackjack hit or /blackjack stand.`
        );
      }

      // — Stand →
      if (sub === 'stand') {
        let dealerSum = dealerCards.reduce((a,b) => a + b, 0);
        while (dealerSum < 17) {
          const c = drawCard();
          dealerCards.push(c);
          dealerSum += c;
        }

        const playerSum = playerCards.reduce((a,b) => a + b, 0);
        let payout = 0, resultMsg;

        // check for initial blackjack
        if (playerCards.length === 2 && playerSum === 21) {
          payout    = Math.floor(bet * 2.5);
          resultMsg = `Blackjack! You win $${payout}.`;
        }
        else if (playerSum > 21) {
          resultMsg = `Bust—dealer wins. You lose $${bet}.`;
        }
        else if (dealerSum > 21 || playerSum > dealerSum) {
          payout    = bet * 2;
          resultMsg = `You win $${payout}!`;
        }
        else if (playerSum === dealerSum) {
          payout    = bet;
          resultMsg = `Push—your $${bet} is returned.`;
        }
        else {
          resultMsg = `Dealer wins. You lose $${bet}.`;
        }

        bal += payout;
        await updateBalance(userId, bal);
        games.delete(userId);

        return interaction.reply(
          `${mention}, **Final Hands**\n` +
          `• You:   [${playerCards.join(', ')}] (total **${playerSum}**)\n` +
          `• Dealer:[${dealerCards.join(', ')}] (total **${dealerSum}**)\n` +
          `${resultMsg} Your new balance is $${bal}.`
        );
      }

    } catch (err) {
      console.error('Blackjack error:', err);
      return interaction.reply(
        `${mention}, something went wrong while processing your command. Please try again later.`
      );
    }
  }
};
