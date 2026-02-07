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
- `getUserContext(userId)` - fetch user preferences, sentiment, interaction count, display name, last seen
- `processMediaInMessage(message, analyzeNew)` - cached image analysis via OpenRouter
- `isUserBlacklisted(userId)` - check speak command blacklist

Pattern: Database uses BigInt for balances, parsed as `parseInt()`.

**Important**: `getUserContext()` now returns `interactionCount` and `lastSeen` fields (bug fixed in redesign).

### Utility Modules

#### constants.js
Central repository for all configuration values:
- `OWNER_ID` - Bot owner ID
- `ATTITUDE_LEVELS` - Enum of all attitude states
- `SENTIMENT_THRESHOLDS` - Sentiment score boundaries for attitude transitions
- `MEMORY_LIMITS` - Message/memory limits (conversation context, fetch limits, etc.)
- `TIMEOUTS` - API call and interaction timeouts
- `EMBED_COLORS` - Consistent color scheme for all embeds
- `GOAT_EMOJIS` - Animated emoji mappings
- Helper functions: `getColorForAttitude()`, `getEmojiForAttitude()`, `isOwner()`

#### apiHelpers.js
Centralized API call utilities with timeout and error handling:
- `callGroqAPI(prompt, options)` - Groq API calls (relationship analysis)
- `callOpenRouterAPI(model, messages, options)` - OpenRouter calls (speak command)
- `getErrorType(error)` - Error classification

#### errorHandler.js
Unified error handling for commands:
- `handleCommandError(interaction, error, context, errorType)` - Logs and sends user-friendly errors
- `sendError(interaction, message, ephemeral)` - Simple error replies
- `ERROR_MESSAGES` - Mapping of error types to user messages

#### embedBuilder.js
Consistent embed creation:
- `createRelationshipEmbed(userContext, targetUser, options)` - Single user relationship card
- `createOverviewEmbed(relationships, options)` - Multi-user overview with categorization
- `createStatsEmbed(userContext, user, recentSentiments)` - Personal stats display
- `createSuccessEmbed()` / `createErrorEmbed()` - Status messages

### Database Schema
The PostgreSQL database contains 8 tables:

#### balances
Stores virtual currency for each user.
```sql
user_id  TEXT PRIMARY KEY
balance  BIGINT
```
- New users auto-seed with $10,000 on first access
- Balance stored as BigInt, parsed to integer in JavaScript

#### conversation_memories
Stores conversation history for AI context and sentiment tracking.
```sql
id               INTEGER PRIMARY KEY (auto-increment)
user_id          TEXT NOT NULL
channel_id       TEXT NOT NULL
user_message     TEXT
bot_response     TEXT
timestamp        BIGINT NOT NULL
created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
sentiment_score  NUMERIC(4,2)
```
Indexes: `user_id`, `timestamp DESC`

**Cleanup**: Deterministic cleanup triggers when table exceeds 1000 rows, deletes oldest 200 entries.

#### media_cache
Caches media descriptions from AI analysis to reduce API costs.
```sql
media_id        TEXT PRIMARY KEY
description     TEXT NOT NULL
media_type      TEXT NOT NULL
original_url    TEXT
created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
accessed_count  INTEGER DEFAULT 1
last_accessed   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```
- `media_id` is SHA256 hash of `url + messageId + fileName`
- Index on `last_accessed` for cache cleanup
- Avoids re-analyzing same images across conversations

#### reminders
Stores scheduled reminders for `/remind` command.
```sql
id                TEXT PRIMARY KEY
user_id           TEXT NOT NULL
channel_id        TEXT NOT NULL
due_at_utc_ms     BIGINT NOT NULL
reason            TEXT
created_at_utc_ms BIGINT NOT NULL
```
Index: `due_at_utc_ms` for efficient polling

#### settings
Global bot settings storage (key-value boolean flags).
```sql
setting  TEXT PRIMARY KEY
state    BOOLEAN
```

#### sleepy_counts
Tracks "sleepy" command usage per user per guild.
```sql
guild_id  TEXT NOT NULL
user_id   TEXT NOT NULL
count     INTEGER NOT NULL DEFAULT 0
PRIMARY KEY (guild_id, user_id)
```

#### speak_blacklist
Users banned from using the `/speak` command.
```sql
user_id  TEXT PRIMARY KEY
```

#### user_preferences
Stores user context for AI personality adaptation.
```sql
user_id                TEXT PRIMARY KEY
display_name           TEXT
interaction_count      INTEGER DEFAULT 0
last_seen              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
attitude_level         TEXT DEFAULT 'neutral'
sentiment_score        NUMERIC(4,3) DEFAULT 0.000
last_sentiment_update  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```
- `attitude_level` values: 'friendly', 'neutral', 'annoyed', etc.
- `sentiment_score` updates via `updateUserAttitudeWithAI()` after each conversation
- Used by speak command to adjust personality tone

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
- Uses DeepSeek via OpenRouter for chat (`deepseek/deepseek-chat` model) - see [speak.js](../src/commands/tools/speak.js#L185-L195)
- **Cost optimization**: `buildConversationContext()` only analyzes images in the newest message (line 67-68)
- Caches media descriptions in `media_cache` table to avoid redundant API calls
- User sentiment tracked in `user_preferences` table - see `updateUserAttitudeWithAI()`
- Personality uses custom animated emojis (`GOAT_EMOJIS` object)

### Media Analysis
- Primary: Gemini 2.0 Flash via OpenRouter (fast, accurate vision) - see [db.js](../src/utils/db.js#L212)
- Fallback: Qwen 2.5 VL 7B (excellent for text/memes in images)
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
- [src/utils/constants.js](../src/utils/constants.js) - Shared constants and configuration
- [src/utils/apiHelpers.js](../src/utils/apiHelpers.js) - API call wrappers with timeout/error handling
- [src/utils/errorHandler.js](../src/utils/errorHandler.js) - Centralized error handling
- [src/utils/embedBuilder.js](../src/utils/embedBuilder.js) - Standardized embed creation
- [src/commands/tools/speak.js](../src/commands/tools/speak.js) - Main AI conversation command
- [src/commands/tools/mystats.js](../src/commands/tools/mystats.js) - User self-inspection command
- [src/commands/tools/currency.js](../src/commands/tools/currency.js) - Simple subcommand example
- [src/commands/tools/bj.js](../src/commands/tools/bj.js) - Complex button collector pattern
- [src/events/client/interactionCreate.js](../src/events/client/interactionCreate.js) - Command execution entry point

## Trashcan Folder
`trashcan/` contains old/experimental code. **Never reference these files** - they're kept for historical purposes only.
