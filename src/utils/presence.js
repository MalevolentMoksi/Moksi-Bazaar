// src/utils/presence.js
const { ActivityType } = require('discord.js');

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function initUptimePresence(client) {
  setInterval(() => {
    const uptime = formatUptime(client.uptime);
    client.user.setPresence({
      activities: [{
        name: `Uptime: ${uptime}`,
        type: ActivityType.Watching
      }],
      status: 'online'
    });
  }, 60_000); // Update every minute
}

module.exports = { initUptimePresence };