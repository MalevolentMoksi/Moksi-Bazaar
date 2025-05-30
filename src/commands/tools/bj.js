const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

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
      embed.setColor('#800080');        // Purple for Blackjack
    } else if (result.includes('2.5×')) {
      embed.setColor('#800080');        // Purple for 2.5× payout (blackjack)
    } else if (result.toLowerCase().includes('win')) {
      embed.setColor('#00FF00');        // Green for a standard win
    } else if (result.includes('Bust')) {
      embed.setColor('#FFCC00');        // Softer yellow for a Bust
    } else if (result.toLowerCase().includes('lose')) {
      embed.setColor('#FF0000');        // Red for a loss
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

    // Fetch and deduct initial bet
    const origBalance = await getBalance(userId);
    if (origBalance < bet) {
      return interaction.reply({ content: `💰 You only have ${origBalance}, you cannot bet ${bet}.`, ephemeral: true });
    }
    let balance = origBalance - bet;
    await updateBalance(userId, balance);

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
          return btnInt.reply({ content: 'This isn’t your game!', ephemeral: true });
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
            return btnInt.followUp({ content: 'Insufficient balance to double down.', ephemeral: true });
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
          if (dealerTotal > 21 || playerTotal > dealerTotal) {
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
            new ButtonBuilder().setCustomId('play_again').setLabel('Play Again').setStyle(ButtonStyle.Primary)
          );
          await message.edit({ embeds: [finalEmbed], components: [playRow] });
          return handlePlayAgain(message);
        }
      });
    };

    // Initial defer to allow editReply
    await interaction.deferReply();
    await runRound();

    // Handle "Play Again" button with 3min lifespan
    function handlePlayAgain(msg) {
      const playCollector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 3 * 60 * 1000 });
      playCollector.on('collect', async btnInt => {
        if (btnInt.user.id !== userId) return btnInt.reply({ content: 'Not your game!', ephemeral: true });
        const balNow = await getBalance(userId);
        if (balNow < originalBet) {
          return btnInt.reply({ content: 'Insufficient balance to play again.', ephemeral: true });
        }
        // Deduct original bet and reset
        await updateBalance(userId, balNow - originalBet);
        balance = balNow - originalBet;
        bet = originalBet;
        await btnInt.deferUpdate();
        await runRound();
        playCollector.stop();
      });
    }
  }
};
