// In your bot.js ready event:
const { startReminderScheduler } = require('./commands/tools/remind.js');

client.once('ready', async () => {
  await init();
  console.log(`Logged in as ${client.user.tag}`);
  
  // Start reminder scheduler
  try {
    await startReminderScheduler(client);
    console.log('Reminder scheduler started');
  } catch (e) {
    console.error('Failed to start reminder scheduler:', e);
  }
});
