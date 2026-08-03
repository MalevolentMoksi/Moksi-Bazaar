// src/functions/handlers/handleEvents.js
const fs   = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

module.exports = (client) => {
  client.handleEvents = () => {
    const eventsPath = path.join(__dirname, '..', '..', 'events');
    const eventFiles = [];

    // Recursively collect all .js files under eventsPath
    const walk = (dir) => {
      for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          walk(fullPath);
        } else if (dirent.isFile() && dirent.name.endsWith('.js')) {
          eventFiles.push(fullPath);
        }
      }
    };
    walk(eventsPath);

    // Register each event. A file may export one handler or an array of them,
    // matching how handleCommands.js already treats command modules.
    for (const filePath of eventFiles) {
      const exported = require(filePath);
      const handlers = Array.isArray(exported) ? exported : [exported];

      for (const event of handlers) {
        if (!event?.name || !event?.execute) {
          console.warn(`Skipping bad event export in: ${filePath}`);
          continue;
        }

        // Ensure both interaction and client are passed to execute.
        // Catch rejections here so they carry event context instead of
        // surfacing as anonymous unhandledRejection noise.
        const run = async (...args) => {
          try {
            await event.execute(...args, client);
          } catch (error) {
            logger.error('Event handler failed', {
              event: event.name,
              file: path.relative(process.cwd(), filePath),
              error: error.message,
              stack: error.stack,
            });
          }
        };
        if (event.once) {
          client.once(event.name, run);
        } else {
          client.on(event.name, run);
        }
        console.log(`Loaded event ${event.name} from ${path.relative(process.cwd(), filePath)}`);
      }
    }
  };
};
