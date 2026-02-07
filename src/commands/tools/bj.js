const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');
const { deductBet, createPlayAgainCollector } = require('../../utils/gameHelpers');
const logger = require('../../utils/logger');
const { GAME_CONFIG } = require('../../utils/constants');

// Helper: build and shuffle a deck of cards
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function createShuffledDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function drawCard(deck) {
  return deck.shift();
}
// Calculate best total for hand, counting Aces as 1 or 11
function calculateTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const { rank } of cards) {
    if (rank === 'A') { aces++; total += 11; }
    else if (['J','Q','K'].includes(rank)) total += 10;
    else total += Number(rank);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}
function formatCards(cards) {
  return cards.map(c => `${c.rank}${c.suit}`).join(' ');
}
// Build embed showing hands, totals, bet, balance, and optional result
function buildEmbed(playerCards, dealerCards, balance, bet, result, payout) {
  const playerTotal = calculateTotal(playerCards);

  // Decide whether to show both dealer cards, or only the first one
  const inProgress = !result;  
  const dealerDisplay = inProgress
    ? `${dealerCards[0].rank}${dealerCards[0].suit} ??`
    : formatCards(dealerCards);
  const dealerTotal = inProgress
    ? calculateTotal([dealerCards[0]])
    : calculateTotal(dealerCards);

  const embed = new EmbedBuilder()
    .setTitle('🎲 Blackjack')
    .addFields(
      { name: `Your Hand (Total: ${playerTotal})`, value: formatCards(playerCards), inline: false },
      { name: `Dealer Hand (Total: ${dealerTotal})`, value: dealerDisplay, inline: false },
      {
        name: 'Bet',
        value: payout !== undefined
          ? `${bet} (Won: ${payout})`
          : `${bet}`,
        inline: true
      },
      { name: 'Balance', value: String(balance), inline: true }
    );

  if (result) {
    if (result.startsWith('🃏')) {
      embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_BLACKJACK);
    } else if (result.includes('2.5×')) {
      embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_BLACKJACK);
    } else if (result.toLowerCase().includes('win')) {
      embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_WIN);
    } else if (result.includes('Bust')) {
      embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_LOSS);
    } else if (result.toLowerCase().includes('lose')) {
      embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_LOSS);
    }
    embed.setDescription(`**${result}**`);
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bj')
    .setDescription('Play a round of Blackjack')
    .addSubcommand(sub => sub
      .setName('start')
      .setDescription('Start a new game')
      .addIntegerOption(opt => opt
        .setName('bet')
        .setDescription('Amount to bet')
        .setRequired(true)
      )
    ),

  async execute(interaction) {
    if (interaction.options.getSubcommand() !== 'start') return;
    const userId = interaction.user.id;
    let bet = interaction.options.getInteger('bet');
    const originalBet = bet;

    // Deduct initial bet
    const deductResult = await deductBet(userId, bet);
    if (!deductResult.success) {
      return interaction.reply({
        content: `💰 ${deductResult.error}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let balance = deductResult.newBalance;

    // Function to run a full round, recursively called on "Play Again"
    const runRound = async () => {
      const deck = createShuffledDeck();
      let playerCards = [drawCard(deck), drawCard(deck)];
      let dealerCards = [drawCard(deck), drawCard(deck)];
      let firstMove = true;

      // Immediate Blackjack check
      if (calculateTotal(playerCards) === 21) {
        const payout = Math.floor(bet * 2.5);
        balance += payout;
        await updateBalance(userId, balance);
        const embed = buildEmbed(
          playerCards, dealerCards,
          balance, bet,
          '🃏 Blackjack! You win 2.5× your bet!',
          payout
        );
        const playRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('play_again')
            .setLabel('Play Again')
            .setStyle(ButtonStyle.Primary)
        );
        const msg = await interaction.editReply({ embeds: [embed], components: [playRow] });
        return handlePlayAgain(msg);
      }

      // Initial game embed with buttons
      const embed = buildEmbed(playerCards, dealerCards, balance, bet);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('hit').setLabel('Hit').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('stand').setLabel('Stand').setStyle(ButtonStyle.Danger)
      );
      if (balance >= bet) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId('double')
            .setLabel(`Double Down (${bet * 2})`)
            .setStyle(ButtonStyle.Primary)
        );
      }

      // Send or update reply
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed], components: [row] });
      } else {
        await interaction.reply({ embeds: [embed], components: [row] });
      }

      // Fetch sent message and create collector
      const message = await interaction.fetchReply();
      const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button });

      collector.on('collect', async btnInt => {
        if (btnInt.user.id !== userId) {
          return btnInt.reply({ content: 'This isn’t your game!', flags: MessageFlags.Ephemeral});
        }

        await btnInt.deferUpdate();
        const action = btnInt.customId;

        // HIT
        if (action === 'hit') {
          firstMove = false;
          playerCards.push(drawCard(deck));
          const total = calculateTotal(playerCards);
          if (total > 21) {
            // Bust
            collector.stop();
            const endEmbed = buildEmbed(playerCards, dealerCards, balance, bet, '💥 Bust! You lose.');
            const playRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('play_again').setLabel('Play Again').setStyle(ButtonStyle.Primary)
            );
            await message.edit({ embeds: [endEmbed], components: [playRow] });
            return handlePlayAgain(message);
          }
          // Update embed after hit
          const newEmbed = buildEmbed(playerCards, dealerCards, balance, bet);
          const newRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('hit').setLabel('Hit').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('stand').setLabel('Stand').setStyle(ButtonStyle.Danger)
          );
          if (firstMove && balance >= bet) {
            newRow.addComponents(
              new ButtonBuilder()
                .setCustomId('double')
                .setLabel(`Double Down (${bet * 2})`)
                .setStyle(ButtonStyle.Primary)
            );
          }
          return message.edit({ embeds: [newEmbed], components: [newRow] });
        }

        // DOUBLE DOWN
        if (action === 'double' && firstMove) {
          if (balance < bet) {
            return btnInt.followUp({ content: 'Insufficient balance to double down.', flags: MessageFlags.Ephemeral});
          }
          // Deduct second bet
          balance -= bet;
          bet *= 2;
          await updateBalance(userId, balance);
          firstMove = false;
          playerCards.push(drawCard(deck));
          // then stand automatically
        }

        // STAND or after DOUBLE
        if (action === 'stand' || action === 'double') {
          collector.stop();
          // Dealer plays until 17+
          while (calculateTotal(dealerCards) < 17) {
            dealerCards.push(drawCard(deck));
          }
          const playerTotal = calculateTotal(playerCards);
          const dealerTotal = calculateTotal(dealerCards);
          let resultText;
          let payout = 0;
          if (playerTotal > 21) {
            resultText = '💥 Bust! You lose.';
            payout = 0;
          } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
            resultText = '🎉 You win!';
            payout = bet * 2;
          } else if (playerTotal === dealerTotal) {
            resultText = '🤝 Push. Bet returned.';
            payout = bet;
          } else {
            resultText = '💔 You lose.';
            payout = 0;
          }
          balance += payout;
          await updateBalance(userId, balance);

          const finalEmbed = buildEmbed(
            playerCards, dealerCards,
            balance, bet,
            resultText,
            payout
          );
          const playRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('bj_play_again').setLabel('Play Again').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('bj_exit').setLabel('Exit Game').setStyle(ButtonStyle.Danger)
          );
          await message.edit({ embeds: [finalEmbed], components: [playRow] });
          return handlePlayAgain(message);
        }
      });
    };

    // Initial defer to allow editReply
    await interaction.deferReply();
    await runRound();

    // Handle "Play Again" button
    function handlePlayAgain(msg) {
      const playCollector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: GAME_CONFIG.BLACKJACK.COLLECTOR_TIMEOUT,
      });

      playCollector.on('collect', async (btnInt) => {
        if (btnInt.user.id !== userId) {
          return btnInt.reply({
            content: 'This is not your game!',
            flags: MessageFlags.Ephemeral,
          });
        }

        await btnInt.deferUpdate();

        if (btnInt.customId === 'bj_play_again') {
          const balNow = await getBalance(userId);
          if (balNow < originalBet) {
            return await btnInt.followUp({
              content: 'Insufficient balance to play again.',
              flags: MessageFlags.Ephemeral,
            });
          }
          // Deduct original bet and reset
          const deductAgain = await deductBet(userId, originalBet);
          if (!deductAgain.success) {
            return await btnInt.followUp({
              content: `Could not deduct bet: ${deductAgain.error}`,
              flags: MessageFlags.Ephemeral,
            });
          }
          balance = deductAgain.newBalance;
          bet = originalBet;
          logger.info('Blackjack: Player starting new round', { userId, bet });
          await runRound();
        } else if (btnInt.customId === 'bj_exit') {
          logger.info('Blackjack: Player exited game', { userId, finalBalance: balance });
          playCollector.stop();
        }
      });

      playCollector.on('end', () => {
        logger.debug('Blackjack collector ended', { userId });
      });
    }
  }
};
