// src/commands/tools/sleepy.js

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { pool } = require('../../utils/db.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sleepy')
    .setDescription('Manage the sleepytime leaderboard')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add a sleepy tally to a user')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('The user to credit sleepytime to')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove a sleepy tally from a user')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('The user to remove sleepytime from')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('leaderboard')
        .setDescription('Show the sleepytime leaderboard')
    ),

  async execute(interaction) {
    const guildId = interaction.guildId;
    if (guildId !== '1217066705537204325') {
      return interaction.reply({
        content: '🚫 This command only works in the sleepytime server.',
        ephemeral: true,
      });
    }

    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'add' || sub === 'remove') {
        const user = interaction.options.getUser('user');
        await interaction.deferReply({ ephemeral: true });

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member || member.user.bot) {
          return interaction.editReply('🤖 Bots or unknown users can’t earn sleepy tallies!');
        }

        if (sub === 'add') {
          const result = await pool.query(
            `INSERT INTO sleepy_counts (guild_id, user_id, count)
             VALUES ($1, $2, 1)
             ON CONFLICT (guild_id, user_id)
             DO UPDATE SET count = sleepy_counts.count + 1
             RETURNING count`,
            [guildId, user.id]
          );
          const newCount = result.rows[0].count;
          return interaction.editReply(`✅ Added sleepy for <@${user.id}> — new total: **${newCount}**`);
        } else {
          const sel = await pool.query(
            'SELECT count FROM sleepy_counts WHERE guild_id = $1 AND user_id = $2',
            [guildId, user.id]
          );
          if (sel.rowCount === 0 || sel.rows[0].count <= 0) {
            return interaction.editReply(`🚫 <@${user.id}> has no sleepy tallies to remove.`);
          }
          const upd = await pool.query(
            `UPDATE sleepy_counts
             SET count = count - 1
             WHERE guild_id = $1 AND user_id = $2
             RETURNING count`,
            [guildId, user.id]
          );
          const newCount = upd.rows[0].count;
          return interaction.editReply(`✅ Removed sleepy for <@${user.id}> — new total: **${newCount}**`);
        }
      }

      if (sub === 'leaderboard') {
        await interaction.deferReply();
        const result = await pool.query(
          `SELECT user_id, count
           FROM sleepy_counts
           WHERE guild_id = $1 AND count > 0
           ORDER BY count DESC
           LIMIT 5`,
          [guildId]
        );
        const rows = result.rows;

        const embed = new EmbedBuilder()
          .setTitle('😴 Sleepytime Leaderboard')
          .setFooter({ text: 'Use /sleepy add or /sleepy remove to update tallies' });

        if (rows.length === 0) {
          embed.setDescription('No sleepy tallies yet!');
        } else {
          embed.setDescription(
            rows
              .map((r, i) => `**${i + 1}.** <@${r.user_id}> — **${r.count}**`)
              .join('\n')
          );
        }

        return interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('Sleepy command error:', err);
      return interaction.reply({
        content: '⚠️ Something went wrong handling your sleepy command.',
        ephemeral: true,
      });
    }
  },
};
