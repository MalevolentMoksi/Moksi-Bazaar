const { ActivityType } = require('discord.js');

/**
 * Formats a duration (in ms) into a human-readable string.
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Initialize presence to show the bot's current runtime.
 */
function initUptimePresence(client) {
  const updateInterval = 60_000; // every minute
  setInterval(() => {
    const uptime = formatDuration(client.uptime);
    client.user.setPresence({
      activities: [{
        name: `Uptime: ${uptime}`,
        type: ActivityType.Watching
      }],
      status: 'online'
    });
  }, updateInterval);
}

module.exports = {
  initUptimePresence,
};
