// src/functions/handlers/handleCommands.js
const fs    = require('fs');
const path  = require('path');
const { REST }   = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');

module.exports = (client) => {
  client.handleCommands = async () => {
    // 1️⃣ Gather all commands from src/commands/**/*
    const commands = [];
    const commandsPath = path.join(__dirname, '..', '..', 'commands');
    for (const category of fs.readdirSync(commandsPath)) {
      const categoryPath = path.join(commandsPath, category);
      if (!fs.lstatSync(categoryPath).isDirectory()) continue;
      for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'))) {
        const cmd = require(path.join(categoryPath, file));
        if (cmd.data && cmd.execute) {
          client.commands.set(cmd.data.name, cmd);
          commands.push(cmd.data.toJSON());
        }
      }
    }

    // 2️⃣ Read your bot token (Railway uses TOKEN; locally you might use DISCORD_TOKEN)
    const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
    if (!token) {
      console.error('❌ Missing TOKEN / DISCORD_TOKEN env var — commands will not register.');
      return;
    }

    // 3️⃣ Create one REST instance with your token
    const rest = new REST({ version: '9' }).setToken(token);

    // 4️⃣ Once ready, register commands in every guild
    client.once('ready', async () => {
      // derive your application ID from the logged-in user if no env var
      const appId = process.env.CLIENT_ID ?? client.user.id;
      console.log(`Logged in as ${client.user.tag} (appId=${appId}). Registering ${commands.length} commands…`);

      for (const guild of client.guilds.cache.values()) {
        try {
          console.log(`🔄 Registering commands in guild ${guild.id} (${guild.name})…`);
          await rest.put(
            Routes.applicationGuildCommands(appId, guild.id),
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
