// src/functions/handlers/handleCommands.js
const fs = require('fs');
const path = require('path');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');

module.exports = (client) => {
  client.handleCommands = async () => {
    // 1. Gather all commands
    const commands = [];
    const commandsPath = path.join(__dirname, '..', '..', 'commands');
    for (const category of fs.readdirSync(commandsPath)) {
      const categoryPath = path.join(commandsPath, category);
      if (!fs.lstatSync(categoryPath).isDirectory()) continue;
      for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'))) {
        const command = require(path.join(categoryPath, file));
        if (command.data && command.execute) {
          client.commands.set(command.data.name, command);
          commands.push(command.data.toJSON());
        }
      }
    }

    // 2. Read env-vars (Railway uses TOKEN; locally you might use DISCORD_TOKEN)
    const token    = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
    const clientId = process.env.CLIENT_ID;
    if (!token) {
      console.error('❌ Missing TOKEN / DISCORD_TOKEN env var — commands will not register.');
      return;
    }
    if (!clientId) {
      console.error('❌ Missing CLIENT_ID env var — commands will not register.');
      return;
    }

    // 3. Create one REST instance with your token
    const rest = new REST({ version: '9' }).setToken(token);

    // 4. On ready, push commands to every guild
    client.once('ready', async () => {
      console.log(`Logged in as ${client.user.tag}. Registering ${commands.length} commands…`);
      for (const guild of client.guilds.cache.values()) {
        try {
          console.log(`🔄 Registering commands in guild ${guild.id} (${guild.name})…`);
          await rest.put(
            Routes.applicationGuildCommands(clientId, guild.id),
            { body: commands }
          );
          console.log(`✅ Commands registered in ${guild.name}`);
        } catch (error) {
          console.error(`❌ Failed to register in ${guild.id}:`, error);
        }
      }
    });
  };
};
