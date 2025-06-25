// src/commands/tools/highlow.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function createShuffledDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ rank: r, suit: s });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(card) {
  return RANKS.indexOf(card.rank) + 2;
}

function format(card) {
  return `${card.rank}${card.suit}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('highlow')
    .setDescription('Guess if the next card is higher or lower')
    .addIntegerOption(o =>
      o.setName('bet')
        .setDescription('Amount to wager')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    let bet = interaction.options.getInteger('bet');
    const originalBet = bet;

    let balance = await getBalance(userId);
    if (bet > balance) {
      return interaction.reply({ content: `❌ You only have $${balance}.`, ephemeral: true });
    }

    balance -= bet;
    await updateBalance(userId, balance);

    await interaction.deferReply();
    await runRound();

    async function runRound() {
      const deck = createShuffledDeck();
      const current = deck.pop();

      const promptEmbed = new EmbedBuilder()
        .setTitle('🔼 High or Low?')
        .setDescription(`Current card: **${format(current)}**\nWill the next card be higher or lower?`)
        .addFields(
          { name: 'Bet', value: `$${bet}`, inline: true },
          { name: 'Balance', value: `$${balance}`, inline: true }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('higher').setLabel('Higher').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('lower').setLabel('Lower').setStyle(ButtonStyle.Danger)
      );

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [promptEmbed], components: [row] });
      } else {
        await interaction.reply({ embeds: [promptEmbed], components: [row] });
      }

      const message = await interaction.fetchReply();
      const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button });

      collector.on('collect', async btnInt => {
        if (btnInt.user.id !== userId) {
          return btnInt.reply({ content: 'Not your game!', ephemeral: true });
        }
        await btnInt.deferUpdate();
        collector.stop();

        const next = deck.pop();
        const diff = cardValue(next) - cardValue(current);
        const guessHigh = btnInt.customId === 'higher';

        let resultText;
        let payout = 0;
        if (diff === 0) {
          resultText = `It's a tie with **${format(next)}**. Bet returned.`;
          payout = bet;
        } else if ((diff > 0 && guessHigh) || (diff < 0 && !guessHigh)) {
          resultText = `Correct! Next card was **${format(next)}**.`;
          payout = bet * 2;
        } else {
          resultText = `Wrong! Next card was **${format(next)}**.`;
        }

        balance += payout;
        await updateBalance(userId, balance);

        const resultEmbed = new EmbedBuilder()
          .setTitle('🃏 High-Low Results')
          .setColor(payout > bet ? 0x2ecc71 : payout === 0 ? 0xe74c3c : 0xf1c40f)
          .setDescription(resultText)
          .addFields(
            { name: 'Bet', value: `$${bet}`, inline: true },
            { name: 'Balance', value: `$${balance}`, inline: true }
          );

        const againRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('play_again').setLabel('Play Again').setStyle(ButtonStyle.Primary)
        );

        await interaction.editReply({ embeds: [resultEmbed], components: [againRow] });

        const againCollector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
        againCollector.on('collect', async b => {
          if (b.user.id !== userId) return b.reply({ content: 'Not your game!', ephemeral: true });
          await b.deferUpdate();
          if (b.customId !== 'play_again') return;
          const balNow = await getBalance(userId);
          if (balNow < originalBet) {
            return b.followUp({ content: `❌ You need $${originalBet} to play again.`, ephemeral: true });
          }
          balance = balNow - originalBet;
          bet = originalBet;
          await updateBalance(userId, balance);
          againCollector.stop();
          await runRound();
        });
      });
    }
  }
};
