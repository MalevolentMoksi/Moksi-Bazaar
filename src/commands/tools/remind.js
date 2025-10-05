// src/commands/tools/remind.js
// FIXED: Handles long-duration reminders beyond setTimeout's 24.8 day limit

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool } = require('../../utils/db');
const { randomUUID } = require('crypto');

let schedulerTimer = null;
let schedulerScheduling = false; // prevents overlapping scheduleNext calls
let clientRef = null;

// Maximum safe setTimeout delay (24 days to be safe, actual limit is ~24.8 days)
const MAX_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000; // 24 days in milliseconds

// ---------- DB bootstrap ----------
async function ensureTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            due_at_utc_ms BIGINT NOT NULL,
            reason TEXT,
            created_at_utc_ms BIGINT NOT NULL
        );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (due_at_utc_ms)`);
}

// ---------- DB helpers ----------
async function fetchNextReminder() {
    const { rows } = await pool.query(`
        SELECT id, user_id, channel_id, due_at_utc_ms, reason
        FROM reminders
        ORDER BY due_at_utc_ms ASC
        LIMIT 1
    `);
    return rows[0] || null;
}

async function refetchReminderById(id) {
    const { rows } = await pool.query(
        `SELECT id, user_id, channel_id, due_at_utc_ms, reason
         FROM reminders
         WHERE id = $1
         LIMIT 1`,
        [id]
    );
    return rows[0] || null; // FIXED: return single row object
}

async function deleteReminder(id) {
    await pool.query(`DELETE FROM reminders WHERE id = $1`, [id]);
}

// NEW: Get user's reminders
async function getUserReminders(userId) {
    const { rows } = await pool.query(`
        SELECT id, channel_id, due_at_utc_ms, reason, created_at_utc_ms
        FROM reminders
        WHERE user_id = $1
        ORDER BY due_at_utc_ms ASC
    `, [userId]);
    return rows;
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

// ---------- messaging ----------
async function sendReminderMessage(client, reminder) {
    const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
    if (!channel) return;

    const userMention = `<@${reminder.user_id}>`;
    const suffix = reminder.reason ? ` ${reminder.reason}` : '';
    const epoch = Math.floor(Number(reminder.due_at_utc_ms) / 1000);

    await channel.send(`${userMention}, the Goat apprises you.${suffix} (scheduled for <t:${epoch}:F>)`);
}

// ---------- scheduler (single timer with safe timeout handling) ----------
async function scheduleNext(client) {
    if (schedulerScheduling) return;
    schedulerScheduling = true;

    try {
        const next = await fetchNextReminder();

        // No work -> clear any existing timer
        if (!next) {
            if (schedulerTimer) {
                clearTimeout(schedulerTimer);
                schedulerTimer = null;
            }
            schedulerScheduling = false;
            return;
        }

        // Always reset to a single timer
        if (schedulerTimer) {
            clearTimeout(schedulerTimer);
            schedulerTimer = null;
        }

        const delay = Math.max(0, Number(next.due_at_utc_ms) - Date.now());

        // FIXED: Cap the delay to MAX_TIMEOUT_MS to avoid setTimeout overflow
        // If delay exceeds max, schedule an intermediate check
        const actualDelay = Math.min(delay, MAX_TIMEOUT_MS);

        console.log(`[REMINDER] Scheduling next check in ${(actualDelay / 1000 / 60 / 60).toFixed(2)} hours (total delay: ${(delay / 1000 / 60 / 60).toFixed(2)} hours)`);

        schedulerTimer = setTimeout(async () => {
            try {
                // Double-fire guard: re-check row is still there and due
                const again = await refetchReminderById(next.id);

                if (!again) {
                    // Reminder was deleted, schedule next
                    schedulerScheduling = false;
                    scheduleNext(client).catch(e => console.error('scheduleNext follow-up error:', e));
                    return;
                }

                // Check if reminder is actually due now
                if (Number(again.due_at_utc_ms) <= Date.now()) {
                    // It's due! Send the reminder
                    await sendReminderMessage(client, again);
                    await deleteReminder(again.id);
                } else {
                    // Not due yet (was scheduled for intermediate check), re-schedule
                    console.log('[REMINDER] Intermediate check - reminder not yet due, re-scheduling');
                }
            } catch (err) {
                console.error('Error during reminder dispatch:', err);
            } finally {
                schedulerScheduling = false;
                // Immediately schedule the next one (or re-check the same one)
                scheduleNext(client).catch(e => console.error('scheduleNext follow-up error:', e));
            }
        }, actualDelay);

        schedulerScheduling = false;
    } catch (e) {
        console.error('scheduleNext failed:', e);
        schedulerScheduling = false;
        // Retry later
        setTimeout(() => scheduleNext(client).catch(() => {}), 10_000);
    }
}

async function initScheduler(client) {
    if (clientRef) return;
    clientRef = client;
    await ensureTable();
    await scheduleNext(clientRef);
}

// ---------- UI helpers ----------
async function createRemindersEmbed(userId, client) {
    const reminders = await getUserReminders(userId);

    if (reminders.length === 0) {
        return {
            embed: new EmbedBuilder()
                .setTitle('📅 Your Reminders')
                .setDescription('You have no active reminders.')
                .setColor(0x888888)
                .setTimestamp(),
            components: []
        };
    }

    const embed = new EmbedBuilder()
        .setTitle('📅 Your Reminders')
        .setColor(0x5865F2)
        .setTimestamp()
        .setFooter({ text: 'Click a button to delete a reminder' });

    const fields = [];
    const buttons = [];

    for (let i = 0; i < Math.min(reminders.length, 10); i++) { // Limit to 10 for button limits
        const reminder = reminders[i];
        const epoch = Math.floor(Number(reminder.due_at_utc_ms) / 1000);
        const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
        const channelName = channel ? `#${channel.name}` : 'Unknown Channel';
        const reasonText = reminder.reason ? ` - "${reminder.reason}"` : '';

        const fieldValue = `**Due:** <t:${epoch}:F> (<t:${epoch}:R>)\n**Channel:** ${channelName}${reasonText}`;

        fields.push({
            name: `Reminder ${i + 1}`,
            value: fieldValue,
            inline: false
        });

        buttons.push(
            new ButtonBuilder()
                .setCustomId(`delete_reminder_${reminder.id}`)
                .setLabel(`Delete #${i + 1}`)
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
        );
    }

    embed.addFields(fields);

    // Split buttons into rows of 5 (Discord limit)
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    return {
        embed,
        components: rows
    };
}

// ---------- parsing ----------
function parseRelative(spec) {
    if (typeof spec !== 'string') return null;

    const cleaned = spec.toLowerCase().replace(/\s+/g, '');

    // Tokenize numbers with optional unit
    const re = /(\d+)([dhms]?)/g;
    const tokens = [];
    let match;

    while ((match = re.exec(cleaned)) !== null) {
        tokens.push({ value: parseInt(match[1], 10), unit: match[2] || '' });
    }

    if (tokens.length === 0) return null;

    const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
    let total = 0;
    let prevUnit = null;

    for (let i = 0; i < tokens.length; i++) {
        let { value, unit } = tokens[i];

        if (!unit) {
            // infer missing unit from previous explicit unit
            if (prevUnit === 'd') unit = 'h';
            else if (prevUnit === 'h') unit = 'm';
            else if (prevUnit === 'm') unit = 's';
            else return null; // first token w/o unit is ambiguous
        }

        if (!unitMs[unit]) return null;
        total += value * unitMs[unit];
        prevUnit = unit;
    }

    return total > 0 ? total : null;
}

function parseAbsoluteToUTCms(dateStr, timeStr, tz) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    if (!/^\d{2}:\d{2}$/.test(timeStr)) return null;

    try {
        const [Y, M, D] = dateStr.split('-').map(Number);
        const [HH, MM] = timeStr.split(':').map(Number);
        const desired = { Y, M, D, HH, MM };

        function localParts(epoch) {
            const fmt = new Intl.DateTimeFormat('en-GB', {
                timeZone: tz, hour12: false,
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

        // Start with naive UTC guess and adjust a few iterations
        let guess = Date.UTC(Y, M - 1, D, HH, MM, 0, 0);
        for (let i = 0; i < 6; i++) {
            const cur = localParts(guess);
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

// ---------- command ----------
module.exports = {
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Set a reminder that survives restarts')
        .addSubcommand(sub =>
            sub
                .setName('in')
                .setDescription('Remind after a relative duration (e.g., 10m, 2h, 1d, 1h30 or 1h30m)')
                .addStringOption(opt =>
                    opt.setName('duration')
                        .setDescription('Duration like 10m, 2h, 1d, 1h30 or 1h30m')
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
        )
        .addSubcommand(sub =>
            sub
                .setName('list')
                .setDescription('View and manage your active reminders')
        ),

    async execute(interaction) {
        await initScheduler(interaction.client);
        await interaction.deferReply();

        try {
            const sub = interaction.options.getSubcommand();

            if (sub === 'in') {
                const spec = interaction.options.getString('duration', true);
                const reason = interaction.options.getString('reason') || '';

                const deltaMs = parseRelative(spec);
                if (!deltaMs) {
                    return interaction.editReply(
                        'Invalid duration. Use tokens with units like `10m`, `2h`, `1d`, or combos like `1h30m`.\n' +
                        'You can also write `1h30` (auto-interpreted as 1h 30m), `2d4` (2d 4h), or `5m20` (5m 20s).'
                    );
                }

                const dueAt = Date.now() + deltaMs;
                if (dueAt - Date.now() < 5000) {
                    return interaction.editReply('Please specify a time at least 5 seconds in the future.');
                }

                await insertReminder(interaction.user.id, interaction.channel.id, dueAt, reason);
                // re-schedule safely (single timer policy)
                await scheduleNext(interaction.client);

                const epoch = Math.floor(dueAt / 1000);
                return interaction.editReply(
                    `Understood. The Goat will forewarn you\n-# At <t:${epoch}:F> • <t:${epoch}:R>`
                );
            }

            if (sub === 'at') {
                const dateStr = interaction.options.getString('date', true);
                const timeStr = interaction.options.getString('time', true);
                const tz = interaction.options.getString('timezone', true);
                const reason = interaction.options.getString('reason') || '';

                // Validate timezone early
                try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
                catch {
                    return interaction.editReply('Invalid timezone. Use a valid IANA name like Europe/Paris or America/New_York.');
                }

                const dueAt = parseAbsoluteToUTCms(dateStr, timeStr, tz);
                if (!dueAt) {
                    return interaction.editReply('Could not parse the date/time. Use date as YYYY-MM-DD and time as HH:MM (24h).');
                }

                if (dueAt - Date.now() < 5000) {
                    return interaction.editReply('The specified time is too soon or in the past. Choose a future time at least 5 seconds from now.');
                }

                await insertReminder(interaction.user.id, interaction.channel.id, dueAt, reason);
                await scheduleNext(interaction.client);

                const epoch = Math.floor(dueAt / 1000);
                return interaction.editReply(
                    `Understood. The Goat will forewarn you\n-# At <t:${epoch}:F> • <t:${epoch}:R>`
                );
            }

            if (sub === 'list') {
                const { embed, components } = await createRemindersEmbed(interaction.user.id, interaction.client);
                const reply = await interaction.editReply({
                    embeds: [embed],
                    components: components
                });

                if (components.length > 0) {
                    // Create collector for button interactions
                    const collector = reply.createMessageComponentCollector({
                        filter: i => i.user.id === interaction.user.id,
                        time: 300_000 // 5 minutes
                    });

                    collector.on('collect', async buttonInteraction => {
                        if (buttonInteraction.customId.startsWith('delete_reminder_')) {
                            const reminderId = buttonInteraction.customId.replace('delete_reminder_', '');

                            try {
                                await deleteReminder(reminderId);
                                await scheduleNext(interaction.client); // Reschedule after deletion

                                // Update the embed
                                const { embed: newEmbed, components: newComponents } = await createRemindersEmbed(interaction.user.id, interaction.client);
                                await buttonInteraction.update({
                                    embeds: [newEmbed],
                                    components: newComponents
                                });
                            } catch (error) {
                                console.error('Error deleting reminder:', error);
                                await buttonInteraction.reply({
                                    content: 'Failed to delete reminder. It may have already been removed.',
                                    ephemeral: true
                                });
                            }
                        }
                    });

                    collector.on('end', async () => {
                        // Disable all buttons when collector expires
                        const disabledComponents = components.map(row => {
                            const newRow = new ActionRowBuilder();
                            row.components.forEach(button => {
                                newRow.addComponents(
                                    ButtonBuilder.from(button).setDisabled(true)
                                );
                            });
                            return newRow;
                        });

                        try {
                            await interaction.editReply({
                                embeds: [embed],
                                components: disabledComponents
                            });
                        } catch (error) {
                            // Interaction might be deleted, ignore error
                        }
                    });
                }

                return;
            }

            // Unknown subcommand (should never hit if the command is registered correctly)
            return interaction.editReply('Unknown subcommand.');
        } catch (err) {
            console.error('remind command error:', err);
            try { return interaction.editReply('There was an error processing your reminder command.'); }
            catch {}
        }
    },

    // Export scheduler starter for bot ready event
    startReminderScheduler: initScheduler
};
