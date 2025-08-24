// src/commands/tools/remind.js

// … existing imports …
const { randomUUID } = require('crypto');

// Replace the old parseRelative with this:

/**
 * Parses strings like "1d", "2h", "45m", "30s", "1h30m", "2d4h20m5s".
 * Must include units (d, h, m, s). Rejects ambiguous specs.
 * @param {string} spec
 * @returns {number|null} milliseconds or null if invalid
 */
function parseRelative(spec) {
  if (typeof spec !== 'string') return null;
  // Disallow spaces, enforce sequence of number+unit
  const cleaned = spec.trim().toLowerCase();
  // Entire string must be one or more <number><unit> tokens
  if (!/^[\d]+[dhms]([\d]+[dhms])*$/i.test(cleaned)) {
    return null;
  }
  const unitMap = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  let total = 0;
  // Match all number+unit
  const tokenRe = /(\d+)([dhms])/gi;
  let match;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    const val = parseInt(match[1], 10);
    const unit = match[2];
    total += val * unitMap[unit];
  }
  return total > 0 ? total : null;
}

// In your '/remind in' handler, replace duration parsing block with:

if (sub === 'in') {
  const durationSpec = interaction.options.getString('duration', true).replace(/\s+/g, '');
  const reason = interaction.options.getString('reason') || '';
  const deltaMs = parseRelative(durationSpec);
  if (!deltaMs) {
    return interaction.editReply(
      'Invalid duration format. Use formats like `10m`, `2h`, `1d`, or combinations like `1h30m`, `2d4h20m`.'
    );
  }
  const dueAt = Date.now() + deltaMs;
  if (dueAt <= Date.now() + 5000) {
    return interaction.editReply(
      'Please specify a duration at least 5 seconds in the future.'
    );
  }

  // Insert and reschedule
  await insertReminder(interaction.user.id, interaction.channel.id, dueAt, reason);
  // Reset schedulerBusy so scheduleNext actually fires
  schedulerBusy = false;
  await scheduleNext(interaction.client);

  const utcStr = new Date(dueAt).toUTCString();
  return interaction.editReply(`Understood. The Goat will forewarn you\n-# At ${utcStr}`);
}
