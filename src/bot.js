/**
 * Main Bot Entry Point
 * Initializes Discord.js client, loads handlers, and validates environment
 */

require('dotenv').config();

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const logger = require('./utils/logger');
const { runAllValidations } = require('./utils/validateEnvironment');

// Perform startup validations
(async () => {
  logger.info('Starting Moksi\'s Bazaar bot...');
  
  const validation = await runAllValidations();
  if (!validation.valid) {
    logger.error('Startup validation failed. Please fix the following errors:', {
      errors: validation.errors,
    });
    process.exit(1);
  }

  // Initialize bot after validation passes
  initializeBot();
})();

function initializeBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.commands = new Collection();
  client.commandArray = [];

  // Load all handler functions
  const functionFolders = fs.readdirSync('./src/functions');
  for (const folder of functionFolders) {
    const functionFiles = fs.readdirSync(`./src/functions/${folder}`).filter(file => file.endsWith('.js'));
    for (const file of functionFiles) {
      try {
        require(`./functions/${folder}/${file}`)(client);
      } catch (error) {
        logger.error('Failed to load function', { folder, file, error: error.message });
      }
    }
  }

  client.handleEvents();
  client.handleCommands();

  // Login with token from environment
  client.login(process.env.TOKEN || process.env.DISCORD_TOKEN);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    try {
      await client.destroy();
      logger.info('Bot shut down successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  });
}
