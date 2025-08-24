// src/events/client/ready.js

const { init } = require('../../utils/db');
const { initUptimePresence } = require('../../utils/presence');
const { startReminderScheduler } = require('../../commands/tools/remind.js');

module.exports = {
  name: 'ready',
  once: true, // This event should only fire once
  async execute(client) {
    await init();
    console.log(`Logged in as ${client.user.tag}`);
    initUptimePresence(client);
    console.log('✅ Database initialized, balances table is ready.');
    
    // Start reminder scheduler
    try {
      await startReminderScheduler(client);
      console.log('✅ Reminder scheduler started');
    } catch (e) {
      console.error('❌ Failed to start reminder scheduler:', e);
    }
  }
};
