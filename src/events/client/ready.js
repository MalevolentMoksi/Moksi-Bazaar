// src/events/client/ready.js

const { init } = require('../../utils/db');
const { initUptimePresence } = require('../../utils/presence');
const { startReminderScheduler } = require('../../commands/tools/remind.js');
const { initWarnReminderScheduler } = require('../../utils/warnReminderScheduler');

module.exports = {
  name: 'clientReady',
  once: true, // This event should only fire once
  async execute(client) {
    try {
      await init();
      console.log('✅ Database initialized, balances table is ready.');
    } catch (error) {
      console.error('❌ Database initialization failed:', error.message);
      process.exit(1);
    }

    console.log(`Logged in as ${client.user.tag}`);

    try {
      initUptimePresence(client);
    } catch (error) {
      console.error('❌ Presence initialization failed:', error.message);
    }
    
    // Start reminder scheduler
    try {
      await startReminderScheduler(client);
      console.log('✅ Reminder scheduler started');
    } catch (e) {
      console.error('❌ Failed to start reminder scheduler:', e);
    }

    // Start warn reminder scheduler
    try {
      await initWarnReminderScheduler(client);
      console.log('✅ Warn reminder scheduler started');
    } catch (e) {
      console.error('❌ Failed to start warn reminder scheduler:', e);
    }
  }
};
