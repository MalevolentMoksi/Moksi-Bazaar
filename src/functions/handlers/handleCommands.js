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

    // 2️⃣ Read your bot token & app ID
    const token    = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
    const appId    = process.env.CLIENT_ID;
    if (!token || !appId) {
      console.error('❌ Missing TOKEN / DISCORD_TOKEN or CLIENT_ID — commands will not register.');
      return;
    }

    // 3️⃣ Create one REST instance with your token
    const rest = new REST({ version: '9' }).setToken(token);

    // 4️⃣ Once ready...
    client.once('ready', async () => {
      console.log(`Logged in as ${client.user.tag} (appId=${appId}).`);

      // 🔥 Clear all *global* commands
      try {
        console.log('🗑️  Clearing all global slash-commands…');
        await rest.put(
          Routes.applicationCommands(appId),
          { body: [] }
        );
        console.log('✅ Global slash-commands cleared.');
      } catch (err) {
        console.error('❌ Failed to clear global commands:', err);
      }

      // 🔄 Register commands *per-guild* for instant availability
      for (const guild of client.guilds.cache.values()) {
        try {
          console.log(`🔄 Registering ${commands.length} commands in guild ${guild.name} (${guild.id})…`);
          await rest.put(
            Routes.applicationGuildCommands(appId, guild.id),
            { body: commands }
          );
          console.log(`✅ Registered in ${guild.name}`);
        } catch (error) {
          console.error(`❌ Failed to register in ${guild.id}:`, error);
        }
      }
    });
  };
};
