// src/events/client/guildCreate.js
const { REST, Routes } = require('discord.js');
const logger = require('../../utils/logger');

module.exports = {
  name: 'guildCreate',
  async execute(guild, client) {
    const { commandArray } = client;
    const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;

    if (!token) {
      logger.error('No TOKEN in env — cannot register guild commands');
      return;
    }
    if (!commandArray || commandArray.length === 0) {
      logger.warn('commandArray is empty — skipping guild registration', { guildId: guild.id });
      return;
    }

    const rest = new REST({ version: '10' }).setToken(token);

    try {
      logger.info('Registering commands for new guild', { guildId: guild.id, guildName: guild.name });
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commandArray }
      );
      logger.info('Commands registered in guild', { guildName: guild.name, count: commandArray.length });
    } catch (err) {
      logger.error('Failed to register guild commands on guildCreate', { guildId: guild.id, error: err.message });
    }
  }
};
