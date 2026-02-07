/**
 * Main Bot Entry Point
 * Initializes Discord.js client, loads handlers, and validates environment
 */

require('dotenv').config();

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const logger = require('./utils/logger');
const { validateEnvironmentVars } = require('./utils/validateEnvironment');

// Use console as fallback for critical startup errors
console.log('[STARTUP] Starting Moksi\'s Bazaar bot...');

// Perform startup validations
(async () => {
  try {
    // Critical validation: environment variables only
    const envValidation = validateEnvironmentVars();
    if (!envValidation.valid) {
      console.error('[STARTUP_ERROR] Missing required environment variables:', envValidation.errors);
      logger.error('Missing required environment variables', { errors: envValidation.errors });
      process.exit(1);
    }

    console.log('[STARTUP] Environment variables valid, initializing bot...');
    logger.info('Starting Moksi\'s Bazaar bot - env vars validated');

    // Initialize bot
    initializeBot();
  } catch (error) {
    console.error('[STARTUP_ERROR] Unexpected startup error:', error.message);
    logger.error('Unexpected startup error', { error: error.message, stack: error.stack });
    process.exit(1);
  }
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

  // Handle unhandled rejections and exceptions
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED_REJECTION]', reason);
    logger.error('Unhandled Promise Rejection', { reason: String(reason), stack: reason?.stack });
  });

  process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error.message);
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    process.exit(1);
  });

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
