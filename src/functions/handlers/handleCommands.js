// src/functions/handlers/handleCommands.js
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const { REST, Routes } = require('discord.js');
const { probeCapabilities, unmetRequirements } = require('../../utils/media/capabilities');

/**
 * Every boot used to PUT the full command list to every guild, whether or not
 * anything had changed. Command registration is one of the more aggressively
 * rate-limited endpoints Discord has, and on a bot that redeploys often that is
 * a lot of identical writes. The payload is hashed instead and the PUT is
 * skipped when the hash matches what was registered last time.
 *
 * Set FORCE_REGISTER=1 to override, which is the escape hatch for the case
 * where Discord's copy and ours have drifted apart for some other reason.
 */
const HASH_KEY_PREFIX = 'cmd_hash:';

function hashCommands(commands) {
  return crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex').slice(0, 16);
}

module.exports = (client) => {
  client.handleCommands = async () => {
    // Load all commands from disk.
    //
    // Each file is loaded in isolation. This loop used to require() bare: one
    // module throwing on import (a native dependency that did not build, a
    // typo in a rarely-touched file) aborted the whole pass, so every command
    // after it alphabetically silently ceased to exist, registration never ran,
    // and Discord kept offering commands the bot no longer knew. The symptom
    // was a slash command that spins forever, which names nothing.
    const commands = [];
    const failures = [];
    /** Deliberately withheld: still on disk, no longer offered. */
    const retired = [];
    /** name -> the command module, so requirements can be read after loading. */
    const loaded = new Map();
    const commandsPath = path.join(__dirname, '..', '..', 'commands');
    for (const category of fs.readdirSync(commandsPath)) {
      const categoryPath = path.join(commandsPath, category);
      if (!fs.lstatSync(categoryPath).isDirectory()) continue;
      for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'))) {
        try {
          const exported = require(path.join(categoryPath, file));
          const cmdList = Array.isArray(exported) ? exported : [exported];
          let usable = 0;
          for (const cmd of cmdList) {
            if (cmd?.data && cmd?.execute) {
              // A command whose moment has passed. Kept on disk on purpose, so
              // the file still has to load cleanly and still counts as usable;
              // it is simply not offered, here or to the persona, until the
              // flag comes off. Deregistration follows, because registration
              // mirrors what loaded.
              if (cmd.retired) {
                retired.push(cmd.data.name);
                usable++;
                continue;
              }
              client.commands.set(cmd.data.name, cmd);
              commands.push(cmd.data.toJSON());
              loaded.set(cmd.data.name, cmd);
              usable++;
            }
          }
          if (!usable) {
            failures.push({ file: `${category}/${file}`, error: 'exported no usable command' });
          }
        } catch (error) {
          failures.push({ file: `${category}/${file}`, error: error.message });
          console.error(`[COMMANDS] Failed to load ${category}/${file}:`, error.message);
        }
      }
    }

    // Kept on the client so the dashboard can show what the bot actually
    // knows, rather than what the source tree implies.
    client.commandLoadFailures = failures;
    if (failures.length) {
      console.error(`[COMMANDS] ${failures.length} file(s) failed to load; those commands will not answer.`);
    }
    if (retired.length) {
      console.log(`[COMMANDS] Withheld ${retired.length} retired: ${retired.join(', ')}`);
    }
    console.log(`[COMMANDS] Loaded ${commands.length} commands from disk`);

    // Store command JSON array for guildCreate event
    client.commandArray = commands;

    const token = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
    if (!token) {
      console.error('Missing DISCORD_TOKEN/TOKEN - skipping registration');
      return;
    }
    const rest = new REST({ version: '10' }).setToken(token);

    client.once('clientReady', async () => {
      const appId = process.env.CLIENT_ID ?? client.user.id;
      console.log(`App ID: ${appId}`);

      // Registration mirrors what loaded, so a file that stops loading does
      // deregister its command; that is honest. Loading NOTHING, though, is a
      // broken deploy rather than an intentional emptying, and pushing it
      // would strip every command from Discord and leave nothing to diagnose
      // with. Keep the old registration and let the logs do the talking.
      if (commands.length === 0) {
        console.error('[COMMANDS] Nothing loaded; skipping registration so the existing commands survive.');
        return;
      }

      // The hash lives in the database because the container filesystem is
      // wiped on every deploy, which is exactly when this needs to remember.
      //
      // ready.js runs init() on this same event, so on a cold database the
      // speak_config table may not exist yet when the read below happens. Every
      // access is therefore guarded, and an unreadable hash always means
      // "assume stale" so the worst case is a redundant registration.
      const { getSpeakConfigValue, setSpeakConfigValue } = require('../../utils/db');

      // Withhold commands this container cannot actually run.
      //
      // /magick needs ImageMagick and /videodl needs yt-dlp, and neither
      // survived the builder change that stopped running the Dockerfile.
      // Both already refused politely, but a command nobody can use should
      // not be in the picker at all, and more importantly client.commands is
      // what tells the bot's persona which commands it has. Left alone, it
      // offers to download videos it cannot download.
      //
      // Dropped from client.commands too, not just from the registration, so
      // the persona and Discord agree. Self-reversing: on any builder that
      // installs the binaries again, the probe finds them and they come back
      // without a code change, re-registering because the hash below moves.
      let publishable = commands;
      try {
        const caps = await probeCapabilities();
        const withheld = [];
        for (const [name, cmd] of loaded) {
          const unmet = unmetRequirements(cmd, caps);
          if (unmet.length) {
            withheld.push({ name, needs: unmet });
            client.commands.delete(name);
          }
        }
        if (withheld.length) {
          publishable = commands.filter(c => !withheld.some(w => w.name === c.name));
          client.commandArray = publishable;
          console.warn(`[COMMANDS] Withholding ${withheld.length} command(s) this host cannot run: `
            + withheld.map(w => `/${w.name} (needs ${w.needs.join(', ')})`).join(', '));
        }
      } catch (error) {
        // Fail open, loudly. A probe that throws must never deregister a
        // working command from every guild; the worst case stays what it was
        // before this existed, which is a command that refuses politely.
        console.error('[COMMANDS] Capability probe failed; publishing everything as loaded:', error.message);
      }

      const payloadHash = hashCommands(publishable);
      const force = process.env.FORCE_REGISTER === '1';

      // 1. Fetch and delete existing global commands
      let globalCmds = [];
      try {
        globalCmds = await rest.get(Routes.applicationCommands(appId));
      } catch (err) {
        console.error('Could not fetch global commands:', err);
      }

      if (globalCmds.length > 0) {
        await Promise.all(globalCmds.map(cmd =>
          rest.delete(Routes.applicationCommand(appId, cmd.id))
            .then(() => console.log(`Deleted global /${cmd.name}`))
            .catch(err => console.error(`Failed to delete /${cmd.name}:`, err))
        ));
      }

      // 2. Register per-guild commands, skipping guilds already up to date
      const guilds = [...client.guilds.cache.values()];
      const targets = [];
      for (const guild of guilds) {
        if (force) { targets.push(guild); continue; }
        try {
          const stored = await getSpeakConfigValue(`${HASH_KEY_PREFIX}${guild.id}`, null);
          if (stored === payloadHash) {
            console.log(`Commands unchanged in ${guild.name}, skipping registration`);
            continue;
          }
        } catch {
          // Unreadable hash means "assume stale", never "assume fresh".
        }
        targets.push(guild);
      }

      const results = await Promise.allSettled(
        targets.map(guild =>
          rest.put(
            Routes.applicationGuildCommands(appId, guild.id),
            { body: publishable }
          ).then(() => console.log(`Registered ${publishable.length} commands in ${guild.name}`))
        )
      );

      // Index into `targets`, not into the filtered failure list: the old code
      // read guilds[i] off the failures array and named the wrong server.
      for (let i = 0; i < results.length; i++) {
        const guild = targets[i];
        if (results[i].status === 'rejected') {
          console.error(`Failed guild-register in ${guild?.name ?? 'unknown guild'}:`, results[i].reason);
          continue;
        }
        await setSpeakConfigValue(`${HASH_KEY_PREFIX}${guild.id}`, payloadHash)
          .catch(err => console.error('Could not store command hash:', err.message));
      }
    });
  };
};
