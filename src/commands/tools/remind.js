// src/commands/tools/remind.js
const { SlashCommandBuilder } = require('discord.js');
const { pool } = require('../../utils/db');
const { randomUUID } = require('crypto');

let schedulerTimer = null;
let schedulerBusy = false; // prevents overlapping schedules
let clientRef = null;

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

// Fetch earliest pending reminder
async function fetchNextReminder() {
  const { rows } = await pool.query(`
    SELECT id, user_id, channel_id, due_at_utc_ms, reason
    FROM reminders
    ORDER BY due_at_utc_ms ASC
    LIMIT 1
  `);
  return rows[0] || null;
}

// Double-fire guard: re-fetch row right before sending, ensure still due and present
async function refetchReminderById(id) {
  const { rows } = await pool.query(
    `SELECT id, user_id, channel_id, due_at_utc_ms, reason
     FROM reminders WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows || null;
}

async function deleteReminder(id) {
  await pool.query(`DELETE FROM reminders WHERE id = $1`, [id]);
}

async function sendReminderMessage(client, reminder) {
  const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
  if (!channel) return;
  const userMention = `<@${reminder.user_id}>`;
  const prefix = `${userMention}, the Goat apprises you.`; // your custom phrasing
  const suffix = reminder.reason ? ` ${reminder.reason}` : '';
  await channel.send(`${prefix}${suffix}`);
}

// Always schedule the next single reminder only
async function scheduleNext(client) {
  if (schedulerBusy) return;
  schedulerBusy = true;

  try {
    const next = await fetchNextReminder();
    if (!next) {
      // nothing to schedule; clear existing timer if any
      if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
      }
      schedulerBusy = false;
      return;
    }

    // Clear and reschedule the one timer
    if (schedulerTimer) {
      clearTimeout(schedulerTimer);
      schedulerTimer = null;
    }

    const now = Date.now();
    const delay = Math.max(0, Number(next.due_at_utc_ms) - now);

    schedulerTimer = setTimeout(async () => {
      // Before sending, re-check the DB to ensure we still have this reminder and it's due
      try {
        const again = await refetchReminderById(next.id);
        if (again && Number(again.due_at_utc_ms) <= Date.now()) {
          await sendReminderMessage(client, again);
          await deleteReminder(again.id);
        }
      } catch (e) {
        console.error('Error during reminder dispatch:', e);
      } finally {
        schedulerBusy = false;
        scheduleNext(client).catch(err => console.error('scheduleNext follow-up error:', err));
      }
    }, delay);
  } catch (e) {
    console.error('scheduleNext failed:', e);
    schedulerBusy = false;
    // Retry later
    setTimeout(() => scheduleNext(client).catch(() => {}), 10000);
  }
}

// Initialize scheduler once per process
async function initScheduler(client) {
  if (clientRef) return;
  clientRef = client;
  await ensureTable();
  await scheduleNext(clientRef);
}

// Helpers
function parseRelative(spec) {
  // supports "1h30m", "2h 10m", "45m", "90s", "2d"
  const re = /(\d+)\s*(d|h|m|s)/gi;
  let totalMs = 0;
  let match;
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

// Parse absolute wall time in tz -> UTC ms
function parseAbsoluteToUTCms(dateStr, timeStr, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return null;
  try {
    const [Y, M, D] = dateStr.split('-').map(Number);
    const [HH, MM] = timeStr.split(':').map(Number);

    // We’ll iteratively adjust an epoch guess so that, when shown in tz, it matches Y-M-D HH:MM
    const desired = { Y, M, D, HH, MM };
    function localParts(epoch, tzName) {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tzName, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
      const parts = fmt.formatToParts(new Date(epoch));
      const pick = t => parts.find(p => p.type === t)?.value;
      return {
        Y: +pick('year'),
        M: +pick('month'),
        D: +pick('day'),
        HH: +pick('hour'),
        MM: +pick('minute'),
      };
    }
    let guess = Date.UTC(Y, M - 1, D, HH, MM, 0, 0);
    for (let i = 0; i < 6; i++) {
      const cur = localParts(guess, tz);
      const deltaMin =
        ((desired.Y - cur.Y) * 525600) +
        ((desired.M - cur.M) * 43200) +
        ((desired.D - cur.D) * 1440) +
        ((desired.HH - cur.HH) * 60) +
        (desired.MM - cur.MM);
      if (deltaMin === 0) break;
      guess += deltaMin * 60 * 1000;
    }
    return guess;
  } catch {
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
        .setDescription('Remind after a relative duration (e.g., 10m, 2h, 1d, 1h30m)')
        .addStringOption(opt =>
          opt.setName('duration')
            .setDescription('Duration like 10m, 2h, 1d, or combos like 1h30m')
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
            .setDescription('YYYY-MM-DD in the specified timezone')
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

  async execute(interaction) {
    await initScheduler(interaction.client);
    await interaction.deferReply({});

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

        // Re-schedule safely (single timer)
        schedulerBusy = false;
        await scheduleNext(interaction.client);

        const utcStr = new Date(dueAt).toUTCString();
        // Two-line confirmation: line 1 plain, line 2 subtle/smaller via spoiler-ish style
        await interaction.editReply(`Understood. The Goat will forewarn you\n-# At ${utcStr}`);
        return;
      }

      if (sub === 'at') {
        const dateStr = interaction.options.getString('date', true);
        const timeStr = interaction.options.getString('time', true);
        const tz = interaction.options.getString('timezone', true);
        const reason = interaction.options.getString('reason') || '';

        // Validate tz
        try {
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

        schedulerBusy = false;
        await scheduleNext(interaction.client);

        const utcStr = new Date(dueAt).toUTCString();
        await interaction.editReply(`Understood. The Goat will forewarn you\n-# ${utcStr}`);
        return;
      }

      await interaction.editReply('Unknown subcommand.');
    } catch (err) {
      console.error('remind command error:', err);
      try {
        await interaction.editReply('There was an error setting your reminder.');
      } catch {}
    }
  },
};
