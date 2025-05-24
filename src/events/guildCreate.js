// src/events/guildCreate.js
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');

module.exports = {
  name: 'guildCreate',
  async execute(guild, client) {
    // Grab your command JSON payloads (the same array you used for global)
    const { commandArray } = client;
    if (!process.env.TOKEN) return console.error('No TOKEN in env!');
    
    // Build a REST client
    const rest = new REST({ version: '9' }).setToken(process.env.TOKEN);
    
    try {
      console.log(`📥 Registering commands for new guild: ${guild.id} (${guild.name})`);
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commandArray }
      );
      console.log(`✅ Commands registered in ${guild.name}`);
    } catch (err) {
      console.error('❌ Failed to register guild commands on guildCreate:', err);
    }
  }
};
