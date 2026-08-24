// src/commands/tools/sleepy.js
//
// The sleepytime leaderboard: an in-joke that only ever made sense in one
// server. It was retired wholesale rather than trimmed, which took it away
// from the server where it still meant something.
//
// It is back scoped instead, which is what it should have been from the start.
// `guilds` keeps it out of every other server's command picker and out of the
// persona's capability list there (utils/commandScope.js); the guild check in
// execute() stays, because a registration outlives the deploy that made it and
// Discord keeps offering whatever it was last given.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../utils/db.js');
const { SLEEPY_GUILDS, isOwner, OWNER_REJECTION_JOKES } = require('../../utils/constants');
const { ui } = require('../../utils/ui/panel');

/**
 * The largest tally the set command will store.
 *
 * Not a rule about the in-joke, a guard on the one command that can write an
 * arbitrary number. Discord enforces it on the option itself, so a typo of
 * the kind that produced a leaderboard of identical scores is refused by the
 * client before it ever reaches the database.
 */
const MAX_TALLY = 10_000;

module.exports = {
  guilds: SLEEPY_GUILDS,
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
        .setName('set')
        .setDescription('Set a user’s tally to an exact number (owner only)')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('Whose tally to set')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
          opt
            .setName('count')
            .setDescription('The exact tally to store (0 removes them from the board)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(MAX_TALLY)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('leaderboard')
        .setDescription('Show the sleepytime leaderboard')
    ),

  async execute(interaction) {
    const guildId = interaction.guildId;
    if (!SLEEPY_GUILDS.includes(guildId)) {
      return interaction.reply({
      content: '🚫 This command only works in the sleepytime server.', flags: MessageFlags.Ephemeral
      });
    }

    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'add' || sub === 'remove') {
        const user = interaction.options.getUser('user');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
          return interaction.editReply(`✅ Added sleepy for <@${user.id}>, new total: **${newCount}**`);
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
          return interaction.editReply(`✅ Removed sleepy for <@${user.id}>, new total: **${newCount}**`);
        }
      }

      // Owner only, while add and remove stay open to everybody: nudging a
      // tally by one is the in-joke working as intended, and writing an
      // arbitrary number is a different power. This subcommand exists because
      // its absence is what sent somebody into the database with raw SQL, and
      // an UPDATE without a WHERE set every row in the table to the same
      // value at once.
      if (sub === 'set') {
        if (!isOwner(interaction.user.id)) {
          const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
          return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        const user = interaction.options.getUser('user');
        const count = interaction.options.getInteger('count');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member || member.user.bot) {
          return interaction.editReply('🤖 Bots or unknown users can’t earn sleepy tallies!');
        }

        const before = await pool.query(
          'SELECT count FROM sleepy_counts WHERE guild_id = $1 AND user_id = $2',
          [guildId, user.id]
        );
        const previous = before.rows[0]?.count ?? 0;

        // Scoped to one row by primary key, and only ever one row: the whole
        // reason this command exists rather than a hand-written statement.
        await pool.query(
          `INSERT INTO sleepy_counts (guild_id, user_id, count)
           VALUES ($1, $2, $3)
           ON CONFLICT (guild_id, user_id)
           DO UPDATE SET count = EXCLUDED.count`,
          [guildId, user.id, count]
        );

        // Both numbers, always. A set that silently reports only its result
        // hides the mistake it just made; seeing what it replaced is what
        // makes a wrong one obvious straight away.
        return interaction.editReply(
          `✅ Set sleepy for <@${user.id}>: **${previous}** → **${count}**`
          + (count === 0 ? '\n-# Zero keeps the row but drops them off the leaderboard.' : '')
        );
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
              .map((r, i) => `**${i + 1}.** <@${r.user_id}>: **${r.count}**`)
              .join('\n')
          );
        }

        return interaction.editReply(ui(embed, [], { scope: 'misc' }));
      }
    } catch (err) {
      console.error('Sleepy command error:', err);
      return interaction.reply({
        content: '⚠️ Something went wrong handling your sleepy command.', flags: MessageFlags.Ephemeral
      });
    }
  },
};
