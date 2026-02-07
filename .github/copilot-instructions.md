# Moksi's Bazaar - AI Agent Instructions

## Project Overview
Discord.js v14 bot with casino games, AI chat, and virtual currency. Uses PostgreSQL for persistence and OpenRouter for LLM features.
Reference: https://discord.js.org/docs/packages/discord.js/main

## Architecture

### Command Pattern
Commands live in `src/commands/tools/`. Each exports:
```javascript
module.exports = {
  data: new SlashCommandBuilder()
    .setName('command')
    .setDescription('...'),
  async execute(interaction, client) { ... }
};
```
- Commands auto-register **per guild** (not global) on `clientReady` event
- See [handleCommands.js](../src/functions/handlers/handleCommands.js#L31-L54) - deletes global commands, registers per guild for instant updates
- Use `interaction.deferReply()` for operations >3s to avoid timeout

### Event Pattern
Events in `src/events/client/`. Structure:
```javascript
module.exports = {
  name: 'eventName',      // Discord.js event name
  once: false,            // true for one-time events like 'clientReady'
  async execute(...args, client) { ... }
};
```
- Handler recursively walks `events/` directory - see [handleEvents.js](../src/functions/handlers/handleEvents.js)
- Both `interaction` and `client` are passed to `execute()`

### Database Layer
**All database operations go through [src/utils/db.js](../src/utils/db.js)** - never write raw SQL in commands.

Key functions:
- `getBalance(userId)` / `updateBalance(userId, newBalance)` - currency system
- `getUserContext(userId)` - fetch user preferences, sentiment, interaction count
- `processMediaInMessage(message, analyzeNew)` - cached image analysis via OpenRouter
- `isUserBlacklisted(userId)` - check speak command blacklist

Pattern: Database uses BigInt for balances, parsed as `parseInt()` (line 7).

### Button Interactions
Multi-turn games (blackjack, roulette) use `ComponentType.Button` collectors:
```javascript
const collector = message.createMessageComponentCollector({
  componentType: ComponentType.Button,
  time: 60000  // 1 minute timeout
});

collector.on('collect', async i => {
  if (i.user.id !== interaction.user.id) {
    return i.reply({ content: 'Not your game!', flags: MessageFlags.Ephemeral });
  }
  await i.deferUpdate();  // Acknowledge before processing
  // ... game logic
});
```
**Critical**: Call `i.deferUpdate()` immediately in collector to avoid "interaction failed" errors.

## Development Workflow

### Running Locally
```bash
npm start              # Runs src/bot.js
npm test               # Jest + ESLint
```

### Environment Variables
Required in `.env`:
- `TOKEN` or `DISCORD_TOKEN` - Discord bot token
- `CLIENT_ID` - Application ID (auto-fetched from `client.user.id` if missing)
- `DATABASE_URL` - PostgreSQL connection string
- `OPENROUTER_API_KEY` - For AI features (speak, media analysis)

### Deployment
- **Docker**: Uses Node 22-slim, runs `node src/bot.js` - see [Dockerfile](../Dockerfile)
- **Railway**: `.nixpacks.toml` configures build

## Project-Specific Conventions

### Currency System
- New users seed with $10,000 on first `getBalance()` call
- Always check balance before deducting bets
- Use `MessageFlags.Ephemeral` for error messages in gambling commands

### AI Personality (Speak Command)
- Uses DeepSeek V3 via OpenRouter for chat - see [speak.js](../src/commands/tools/speak.js#L95-L110)
- **Cost optimization**: `buildConversationContext()` only analyzes images in the newest message (line 67-68)
- Caches media descriptions in `media_cache` table to avoid redundant API calls
- User sentiment tracked in `user_preferences` table - see `updateUserAttitudeWithAI()`
- Personality uses custom animated emojis (`GOAT_EMOJIS` object)

### Media Analysis
- Primary: Gemini 2.0 Flash via OpenRouter - see [db.js](../src/utils/db.js#L144)
- Fallback: Llama Vision (free tier)
- Media IDs generated from `sha256(url + messageId + fileName)` - ensures same file reuses cache
- `analyzeImageWithOpenRouter()` has 10s timeout to prevent hangs

### Blackjack Special Logic
- Reveals dealer's full hand only when game ends (bust, stand, or blackjack)
- Embed colors: Purple for blackjack (#800080), Green for wins, Red for losses
- Uses `formatCards()` helper to display `rank+suit` format (e.g., `A♠ K♥`)

### Command Registration Quirk
On `clientReady`, the bot:
1. Fetches and deletes all **global** commands
2. Re-registers all commands **per guild** for instant availability
3. This avoids 1-hour cache delay of global commands during development

## Common Patterns

### Subcommands
```javascript
.addSubcommand(sub =>
  sub.setName('balance')
     .setDescription('Check your balance')
)
```
Access via `interaction.options.getSubcommand()`.

### Owner-Only Logic
Owner ID: `619637817294848012` (see [speak.js](../src/commands/tools/speak.js#L99))
```javascript
const isOwner = userId === "619637817294848012";
```

### Ephemeral Replies
Use for errors, permission denials, or personal data:
```javascript
interaction.reply({ content: '...', flags: MessageFlags.Ephemeral });
```

## Files to Reference

- [src/bot.js](../src/bot.js) - Entry point, client setup, handler initialization
- [src/utils/db.js](../src/utils/db.js) - All database operations, AI integration
- [src/commands/tools/currency.js](../src/commands/tools/currency.js) - Simple subcommand example
- [src/commands/tools/bj.js](../src/commands/tools/bj.js) - Complex button collector pattern
- [src/events/client/interactionCreate.js](../src/events/client/interactionCreate.js) - Command execution entry point

## Trashcan Folder
`trashcan/` contains old/experimental code. **Never reference these files** - they're kept for historical purposes only.
