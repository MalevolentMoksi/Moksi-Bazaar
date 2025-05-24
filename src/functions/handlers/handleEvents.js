// src/functions/handlers/handleEvents.js
const fs   = require('fs');
const path = require('path');

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

    // Register each event
    for (const filePath of eventFiles) {
      const event = require(filePath);
      if (!event.name || !event.execute) {
        console.warn(`Skipping bad event file: ${filePath}`);
        continue;
      }
      if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
      } else {
        client.on(event.name, (...args) => event.execute(...args, client));
      }
      console.log(`Loaded event ${event.name} from ${path.relative(process.cwd(), filePath)}`);
    }
  };
};
