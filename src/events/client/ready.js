// src/events/client/ready.js

const { EmbedBuilder } = require('discord.js');
const { init } = require('../../utils/db');
const { initPresence } = require('../../utils/presence');
const { startReminderScheduler } = require('../../commands/tools/remind.js');
const { initWarnReminderScheduler } = require('../../utils/warnReminderScheduler');
const { initJoinGate } = require('../../utils/joinGate');
const { startJanitor } = require('../../utils/janitor');
const { startBackupScheduler } = require('../../utils/backup');
const { startTweetMirror } = require('../../utils/tweetMirror');
const { reportCapabilities } = require('../../utils/media/capabilities');
const { loadModes } = require('../../utils/ui/mode');
const { ui } = require('../../utils/ui/panel');
const { EMBED_COLORS } = require('../../utils/constants');
const logger = require('../../utils/logger');

/**
 * Boot subsystems one at a time, recording what worked.
 *
 * Each of these already swallowed its own errors and printed a red X to a
 * console nobody reads at deploy time. The failures are collected instead, so
 * the one person who can act on them gets told directly.
 */
async function runBootStep(results, label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, error: error?.message || String(error) });
    logger.error('Boot step failed', { step: label, error: error?.message, stack: error?.stack });
    console.error(`❌ ${label} failed:`, error?.message || error);
  }
}

/**
 * Sends the owner a summary, but only when something is actually broken.
 * A boot report that arrives after every successful deploy is a notification
 * you learn to swipe away, which is exactly when you miss the one that matters.
 */
async function reportBootFailures(client, results) {
  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) return;

  const ownerId = process.env.OWNER_ID;
  if (!ownerId) return;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS?.ERROR ?? 0xED4245)
    .setTitle('Boot report: something did not start')
    .setDescription(
      `${failed.length} of ${results.length} subsystems failed to start. `
      + 'The bot is running; these features are not.'
    )
    .addFields(
      failed.map(f => ({
        name: f.label,
        value: `\`\`\`${String(f.error).slice(0, 300)}\`\`\``,
      }))
    )
    .setFooter({ text: `${client.user.tag} • ${results.filter(r => r.ok).length} started normally` })
    .setTimestamp();

  try {
    const owner = await client.users.fetch(ownerId);
    await owner.send(ui(embed, [], { scope: 'misc' }));
  } catch (error) {
    // Closed DMs are the owner's choice; the log line above already has it all.
    logger.warn('Could not DM boot report to owner', { error: error.message });
  }
}

module.exports = {
  name: 'clientReady',
  once: true, // This event should only fire once
  async execute(client) {
    // The database is the one hard dependency: nothing below works without it,
    // so this stays a hard exit rather than a boot-report line.
    try {
      await init();
      console.log('✅ Database initialized, balances table is ready.');
    } catch (error) {
      console.error('❌ Database initialization failed:', error.message);
      process.exit(1);
    }

    console.log(`Logged in as ${client.user.tag}`);

    const results = [];

    // Before anything can render a panel, so the very first message of the
    // session already agrees with the toggle.
    await runBootStep(results, 'Embed mode', () => loadModes());
    await runBootStep(results, 'Presence', () => initPresence(client));
    await runBootStep(results, 'Reminder scheduler', () => startReminderScheduler(client));
    await runBootStep(results, 'Warn reminder scheduler', () => initWarnReminderScheduler(client));
    // initJoinGate swallows its own errors: a broken gate must not take the
    // bot down, and a pending unban must still be lifted on time.
    await runBootStep(results, 'Join gate', () => initJoinGate(client));
    await runBootStep(results, 'Janitor', () => startJanitor());
    await runBootStep(results, 'Backup scheduler', () => startBackupScheduler(client));
    // Costs money per request, so it stays inert until a channel is set and
    // goes quiet again the moment the monthly cap is reached.
    await runBootStep(results, 'Tweet mirror', () => startTweetMirror(client));

    // Diagnostic rather than a subsystem: it starts nothing, and its failure
    // costs nothing. It is here because the container's media tools are not
    // ours to guarantee, and a builder took them away once without telling
    // anybody. This is the line that makes the next time visible on the next
    // deploy instead of days later, through a user hitting a broken command.
    await reportCapabilities();

    const ok = results.filter(r => r.ok).length;
    console.log(`✅ Boot complete: ${ok}/${results.length} subsystems started`);
    logger.info('Boot complete', {
      started: ok,
      total: results.length,
      failed: results.filter(r => !r.ok).map(r => r.label),
    });

    await reportBootFailures(client, results);
  }
};
