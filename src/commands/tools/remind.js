// src/commands/tools/remind.js
const { SlashCommandBuilder, time: discordTime, TimestampStyles } = require('discord.js');
const { pool } = require('../../utils/db'); // reuse your existing pg pool
const { randomUUID } = require('crypto');

/**
 * TABLE:
 * CREATE TABLE IF NOT EXISTS reminders (
 *   id TEXT PRIMARY KEY,
 *   user_id TEXT NOT NULL,
 *   channel_id TEXT NOT NULL,
 *   due_at_utc_ms BIGINT NOT NULL,
 *   reason TEXT,
 *   created_at_utc_ms BIGINT NOT NULL
 * );
 *
 * Index for efficient scheduling:
 * CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (due_at_utc_ms);
 */

let schedulerTimer = null;
let schedulerRunning = false;

// Ensure table exists
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      due_at_utc_ms BIGINT NOT NULL,
      reason TEXT,
      created_at_utc_ms BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (due_at_utc_ms)`);
}

// Fetch the next due reminder (earliest)
async function fetchNextReminder() {
  const { rows } = await pool.query(
    `SELECT id, user_id, channel_id, due_at_utc_ms, reason
     FROM reminders
     ORDER BY due_at_utc_ms ASC
     LIMIT 1`
  );
  return rows[0] || null;
}

// Send and delete a reminder by id
async function sendAndDeleteReminder(client, reminder) {
  try {
    const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
    if (channel) {
      const userMention = `<@${reminder.user_id}>`;
      const reasonText = reminder.reason ? ` • Reason: ${reminder.reason}` : '';
      await channel.send(`${userMention} Reminder time!${reasonText}`);
    }
  } catch (e) {
    // swallow send errors to avoid blocking scheduling
    console.error('Failed to send reminder:', e);
  } finally {
    // delete from DB
    await pool.query(`DELETE FROM reminders WHERE id = $1`, [reminder.id]).catch(() => {});
  }
}

// Core scheduler loop: always schedule the next reminder
async function scheduleNext(client) {
  if (schedulerRunning) return;
  schedulerRunning = true;

  try {
    const next = await fetchNextReminder();
    if (!next) {
      // nothing to schedule
      schedulerRunning = false;
      return;
    }

    const now = Date.now();
    const delay = Math.max(0, Number(next.due_at_utc_ms) - now);

    schedulerTimer = setTimeout(async () => {
      // Set running false to allow immediate scheduling of the next one after execution
      schedulerRunning = false;
      await sendAndDeleteReminder(client, next);
      // After sending, schedule next
      scheduleNext(client).catch(e => console.error('scheduleNext error:', e));
    }, delay);
  } catch (e) {
    console.error('scheduleNext failed:', e);
    schedulerRunning = false;
    // retry in 10 seconds if failed to fetch
    setTimeout(() => scheduleNext(client).catch(() => {}), 10000);
  }
}

// Kickoff scheduler on module load, once client is ready (requires client injection)
let clientRef = null;
async function initScheduler(client) {
  if (clientRef) return;
  clientRef = client;
  await ensureTable();
  await scheduleNext(clientRef);
}

// Helpers: parse relative time like "10m", "2h", "1d", "30s"
function parseRelative(spec) {
  // allow composite like "1h30m", "2h 10m", "90m"
  const re = /(\d+)\s*(d|h|m|s)/gi;
  let match;
  let totalMs = 0;
  while ((match = re.exec(spec)) !== null) {
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 'd') totalMs += val * 24 * 60 * 60 * 1000;
    else if (unit === 'h') totalMs += val * 60 * 60 * 1000;
    else if (unit === 'm') totalMs += val * 60 * 1000;
    else if (unit === 's') totalMs += val * 1000;
  }
  return totalMs > 0 ? totalMs : null;
}

/**
 * Parse absolute time with timezone.
 * Inputs:
 * - date: "YYYY-MM-DD"
 * - time: "HH:mm" (24h)
 * - tz: IANA timezone string (e.g., "Europe/Paris", "America/New_York")
 *
 * We convert the provided local time in tz to a UTC timestamp (ms).
 */
function parseAbsoluteToUTCms(dateStr, timeStr, tz) {
  // Basic validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return null;
  try {
    // Use Intl to compute the offset by formatting that local time in tz and comparing to UTC.
    // Create a Date from components, assumed in target TZ. We can derive UTC by finding the TZ offset at that time.
    const [Y, M, D] = dateStr.split('-').map(n => parseInt(n, 10));
    const [HH, MM] = timeStr.split(':').map(n => parseInt(n, 10));

    // Build a Date in UTC first (same wall time treated as UTC)
    const assumedUTC = Date.UTC(Y, M - 1, D, HH, MM, 0, 0);

    // Figure out the TZ offset at that local wall time.
    // Format that wall time in the given tz, then in UTC, compare epoch ms by shifting with guessed offset.
    // We'll binary search offset within plausible bounds (-14:00 to +14:00)
    function tzOffsetMinutes(epochMs, tzName) {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
      const parts = fmt.formatToParts(new Date(epochMs));
      const get = t => parts.find(p => p.type === t)?.value;
      // returns the local Y-M-D HH:MM that this epochMs shows in tz
      return { year: +get('year'), month: +get('month'), day: +get('day'), hour: +get('hour'), minute: +get('minute') };
    }

    // Find the epoch that, when viewed in tz, shows Y-M-D HH:MM
    // Start with a guess: the UTC date constructed above; refine by offset iterations.
    let guess = assumedUTC;
    for (let i = 0; i < 5; i++) {
      const local = tzOffsetMinutes(guess, tz);
      const deltaMinutes = ((Y - local.year) * 525600) +
                           ((M - local.month) * 43200) +
                           ((D - local.day) * 1440) +
                           ((HH - local.hour) * 60) +
                           (MM - local.minute);
      if (deltaMinutes === 0) break;
      guess += deltaMinutes * 60 * 1000;
    }
    return guess; // UTC ms for that local time in tz
  } catch (e) {
    return null;
  }
}

async function insertReminder(userId, channelId, dueAtMs, reason) {
  const id = randomUUID();
  const created = Date.now();
  await pool.query(
    `INSERT INTO reminders (id, user_id, channel_id, due_at_utc_ms, reason, created_at_utc_ms)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, userId, channelId, String(dueAtMs), reason || null, String(created)]
  );
  return id;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a reminder that survives restarts')
    .addSubcommand(sub =>
      sub
        .setName('in')
        .setDescription('Remind after a relative duration (e.g., 10m, 2h, 1d, or combos like 1h30m)')
        .addStringOption(opt =>
          opt.setName('duration')
             .setDescription('Duration like 10m, 2h, 1d, or combined like 1h30m')
             .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('reason')
             .setDescription('Optional reason to include in the reminder')
             .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('at')
        .setDescription('Remind at an exact time with timezone')
        .addStringOption(opt =>
          opt.setName('date')
             .setDescription('YYYY-MM-DD (your local date in the specified timezone)')
             .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('time')
             .setDescription('HH:MM (24h) in the specified timezone')
             .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('timezone')
             .setDescription('IANA timezone, e.g., Europe/Paris, America/New_York')
             .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('reason')
             .setDescription('Optional reason to include in the reminder')
             .setRequired(false)
        )
    ),

  // This command module needs the client instance to schedule reminders reliably.
  // The client is available on interaction.client.
  async execute(interaction) {
    // initialize scheduler (once per process)
    await initScheduler(interaction.client);

    await interaction.deferReply({ ephemeral: true });

    try {
      const sub = interaction.options.getSubcommand();

      if (sub === 'in') {
        const durationSpec = interaction.options.getString('duration', true);
        const reason = interaction.options.getString('reason') || '';
        const deltaMs = parseRelative(durationSpec);
        if (!deltaMs || deltaMs < 5000) {
          await interaction.editReply('Please provide a valid duration of at least 5 seconds (e.g., 10m, 2h, 1d, 1h30m).');
          return;
        }
        const dueAt = Date.now() + deltaMs;
        await insertReminder(interaction.user.id, interaction.channel.id, dueAt, reason);
        // Reschedule if this is earlier than current
        schedulerRunning = false;
        scheduleNext(interaction.client).catch(() => {});
        const eta = new Date(dueAt);
        await interaction.editReply(`Reminder set for ${eta.toUTCString()} (UTC). I’ll ping you here when it’s time.`);
        return;
      }

      if (sub === 'at') {
        const dateStr = interaction.options.getString('date', true);
        const timeStr = interaction.options.getString('time', true);
        const tz = interaction.options.getString('timezone', true);
        const reason = interaction.options.getString('reason') || '';

        // Quick validate timezone by trying a format
        try {
          // Throws for invalid IANA names in some runtimes
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
        } catch {
          await interaction.editReply('Invalid timezone. Please provide a valid IANA timezone like Europe/Paris or America/New_York.');
          return;
        }

        const dueAt = parseAbsoluteToUTCms(dateStr, timeStr, tz);
        if (!dueAt) {
          await interaction.editReply('Could not parse the date/time. Use date as YYYY-MM-DD and time as HH:MM (24h).');
          return;
        }
        if (dueAt - Date.now() < 5000) {
          await interaction.editReply('The specified time is too soon or in the past. Please choose a future time at least 5 seconds from now.');
          return;
        }

        await insertReminder(interaction.user.id, interaction.channel.id, dueAt, reason);
        schedulerRunning = false;
        scheduleNext(interaction.client).catch(() => {});
        const eta = new Date(dueAt);
        await interaction.editReply(`Reminder set for ${eta.toUTCString()} (UTC). I’ll ping you here when it’s time.`);
        return;
      }

      await interaction.editReply('Unknown subcommand.');
    } catch (err) {
      console.error('remind command error:', err);
      try {
        await interaction.editReply('There was an error setting your reminder.');
      } catch (_) {}
    }
  },
};
