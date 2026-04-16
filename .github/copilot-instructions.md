# Moksi's Bazaar - AI Agent Instructions

## Project Overview
Discord.js v14 bot with casino games, AI chat, and virtual currency. Uses PostgreSQL for persistence and OpenRouter for LLM features.
Reference: https://discord.js.org/docs/packages/discord.js/main

**Model Context**: This is a production bot serving multiple Discord servers. Prioritize **reliability**, **consistency**, and **user experience**. When in doubt, check existing similar commands for patterns before implementing new ones.

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
- See [handleCommands.js](../src/functions/handlers/handleCommands.js#L33-L72) - deletes global commands, registers per guild in parallel for instant updates
- Use `interaction.deferReply()` for operations >3s to avoid timeout
  ```javascript
  async execute(interaction, client) {
    // Quick operations (<3s) can reply immediately
    const balance = await getBalance(interaction.user.id);
    if (quickOperation) {
      return interaction.reply({ content: `$${balance}` });
    }
    
    // Expensive operations (>3s) must defer first
    await interaction.deferReply();
    const result = await expensiveApi();
    await interaction.editReply({ content: result });
  }
  ```

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

**Critical Pattern**: Always fetch fresh state before mutations, never assume previous state is valid.

Key functions:
- `getBalance(userId)` / `updateBalance(userId, newBalance)` - currency system
  ```javascript
  const balance = await getBalance(userId);
  if (balance < bet) throw new Error('Insufficient balance');
  await updateBalance(userId, balance - bet);  // Do NOT chain these calls
  ```
- `getUserContext(userId)` - fetch user preferences, sentiment, interaction count, display name, last seen
- `processMediaInMessage(message, analyzeNew)` - cached image analysis via OpenRouter
- `isUserBlacklisted(userId)` - check speak command blacklist
- `createPendingDuel()` / `getPendingDuelsFor()` / `updateDuelStatus()` / `deleteDuel()` - DB-backed duel state
- `setUserCooldown()` / `getUserCooldownRemaining()` / `isUserOnCooldown()` - persistent cooldowns
  ```javascript
  if (await isUserOnCooldown(userId, 'gamble')) {
    const remaining = await getUserCooldownRemaining(userId, 'gamble');
    throw new Error(`Cooldown: ${remaining}ms remaining`);
  }
  await setUserCooldown(userId, 'gamble', 5000); // 5 second cooldown
  ```

Pattern: Database uses BigInt for balances, parsed as `parseInt()`.
Pattern: Uses Node 22 native `fetch` (no `node-fetch` dependency).

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
Centralized API call utilities with timeout and error handling via OpenRouter (all models migrated April 2026):
- `callOpenRouterAPI(model, messages, options)` - Primary API wrapper for all LLM calls
  ```javascript
  const response = await callOpenRouterAPI('deepseek/deepseek-chat', [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ], { temperature: 0.85, maxTokens: 250, cacheControl: true });
  ```
  - Supports fallback models via `options.fallbackModel`
  - Includes cache control for large system prompts (20% input cost savings on hits)
  - Auto-cleans thinking blocks from DeepSeek output
- `getErrorType(error)` - Error classification (TIMEOUT_ERROR, RATE_LIMIT_ERROR, etc.)

**Important**: Always wrap API calls in try-catch. Implement exponential backoff for rate limits (429 errors).

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

**Cleanup**: Deterministic cleanup triggers when estimated row count exceeds 1000 (uses `pg_class.reltuples` for fast approximation), deletes oldest 200 entries.

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

#### user_cooldowns
Persistent command cooldowns per user per command.
```sql
user_id   TEXT NOT NULL
command   TEXT NOT NULL
expires_at TIMESTAMP NOT NULL
PRIMARY KEY (user_id, command)
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

collector.on('end', (collected, reason) => {
  if (reason === 'time') {
    // Handle timeout - e.g., auto-fold hand, return bet
  }
});
```
**Critical**: 
- Call `i.deferUpdate()` immediately in collector to avoid "interaction failed" errors
- Always handle `collector.on('end')` for timeout scenarios
- Cleanup collectors explicitly on error or game end to prevent memory leaks

## Development Workflow

### Running Locally
```bash
npm start              # Runs src/bot.js
npm test               # Jest + ESLint
```

### Environment Variables
Required in `.env` (see `.env.example`):
- `TOKEN` or `DISCORD_TOKEN` - Discord bot token
- `DATABASE_URL` - PostgreSQL connection string

Optional:
- `CLIENT_ID` - Application ID (auto-fetched from `client.user.id` if missing)
- `OPENROUTER_API_KEY` - For AI features (speak, media analysis)
- `LANGUAGE_API_KEY` - For Groq-powered features (shh command)

### Deployment
- **Docker**: Uses Node 22-slim, runs `node src/bot.js` - see [Dockerfile](../Dockerfile)
- **Railway**: `.nixpacks.toml` configures build

## Project-Specific Conventions

### Currency System
- New users seed with $10,000 on first `getBalance()` call
- Always check balance before deducting bets
- Use `MessageFlags.Ephemeral` for error messages in gambling commands

### AI Personality (Speak Command)
- Uses **DeepSeek Chat** via OpenRouter (`deepseek/deepseek-chat` model) - see [speak.js](../src/commands/tools/speak.js#L250)
- **Cost optimization**: `buildConversationContext()` only analyzes images in the newest message
- Caches media descriptions in `media_cache` table to avoid redundant API calls (~60-70% hit rate)
- User sentiment tracked in `user_preferences` table via `analyzeMessageSentiment()`
- Personality uses custom animated emojis (`GOAT_EMOJIS` object)
- **Cache control enabled**: System prompts cached for 20% input cost savings on repeated calls

### Media Analysis
- **Primary**: Gemini 3.1 Flash-Lite (2.5X faster TTFT, 45% faster output, $0.25/$1.50/1M - replaces deprecated 2.0) - see [db.js](../src/utils/db.js#L244-L266)
- **Fallback**: Qwen 2.5 VL 7B ($0.12/$0.36/1M) - excellent for text/memes in images
- **Retry logic**: Exponential backoff (100ms, 200ms, 400ms) for transient failures
- Media IDs generated from `sha256(url + messageId + fileName)` - ensures same file reuses cache
- `analyzeImageWithOpenRouter()` has 10s timeout (primary) / 8s timeout (fallback) to prevent hangs

### Sentiment & Relationship Analysis
- **Primary**: MiMo-V2-Flash ($0.09/$0.29/1M) - cost-efficient JSON scoring of message sentiment directed at bot
- Returns JSON: `{sentiment: -1.0 to 1.0, reasoning: "..."}`
- Sentiment scores update `user_preferences.attitude_level` for personality adaptation
- Thresholds defined in `constants.js`: `SENTIMENT_THRESHOLDS` (hostile, cautious, neutral, friendly, familiar)

### Blackjack Special Logic
- Reveals dealer's full hand only when game ends (bust, stand, or blackjack)
- Embed colors: Purple for blackjack (#800080), Green for wins, Red for losses
- Uses `formatCards()` helper to display `rank+suit` format (e.g., `A♠ K♥`)
- **Button timeout handling**: On 1m timeout, auto-stand the player's hand
- **State persistence**: Game state stored in message embed (not DB), so avoid bot restarts during gameplay

### Command Registration
On `clientReady`, the bot:
1. Fetches and deletes all **global** commands
2. Re-registers all commands **per guild** in parallel (`Promise.allSettled`) for instant availability
3. This avoids 1-hour cache delay of global commands during development
4. On `guildCreate`, commands are registered immediately for new guilds (with guard for empty commandArray)

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

# Best Practices & Common Pitfalls

## Critical Gotchas

### Database & Race Conditions
- **Balance race condition**: Always fetch fresh balance before deducting, then immediately update. Never assume previous state is still valid.
  ```javascript
  const balance = await getBalance(userId);  // Fresh fetch
  if (balance < bet) return sendError(...);
  await updateBalance(userId, balance - bet); // Atomic update
  ```
- **User context stale data**: `getUserContext()` returns a snapshot. If modifying user preferences, refetch after updates.
- **Transaction isolation**: PostgreSQL uses READ COMMITTED by default. For critical operations (duels, large transfers), fetch-and-update patterns work, but never rely on transaction ordering across multiple operations.

### Interaction Timeout Pitfalls
- **3-second rule**: If an operation might exceed 3 seconds, call `interaction.deferReply()` BEFORE starting work.
  ```javascript
  async execute(interaction) {
    await interaction.deferReply();  // Tell Discord "I'm working on this"
    // Now you have 15 minutes to respond
    const result = await expensiveOperation();
    await interaction.editReply({ content: result });
  }
  ```
- **Button collectors**: ALWAYS call `i.deferUpdate()` immediately when button is pressed, before any async operations.
- **Message editing**: Editing takes ~500ms on average. Budget for this in game loops.

### Media & API Failures
- **Image analysis timeout**: Primary has 10s timeout, fallback has 8s. Oversized/corrupted images fail silently → implement fallback to cached personality or error message.
- **Automatic retry with backoff**: `analyzeImageWithOpenRouter()` retries up to 3 times with exponential backoff (100ms, 200ms, 400ms) for transient failures.
- **Cache misses on identical images**: Media IDs use `sha256(url + messageId + fileName)`. Different URLs = different cache entries (intentional for URL tracking).
- **OpenRouter rate limits (429)**: Implement exponential backoff when retrying. Use `options.fallbackModel` in `callOpenRouterAPI()` to failover gracefully.

### Button Interaction Errors
- **"Interaction failed" on slow operations**: This means you didn't call `deferUpdate()` or `deferReply()` before the 3-second window closed.
- **Editing components after timeout**: If collector times out, the message may be read-only. Wrap edits in try-catch.
- **User ID mismatch**: Always verify `i.user.id === interaction.user.id` before processing button clicks. Attackers can click any button.

## Error Handling Patterns

### Command-Level Error Handling
```javascript
async execute(interaction, client) {
  try {
    await interaction.deferReply();
    
    // Core logic
    const balance = await getBalance(interaction.user.id);
    
    await interaction.editReply({ content: `Balance: $${balance}` });
  } catch (error) {
    // Centralized handler logs and sends user-friendly error
    await handleCommandError(interaction, error, 'currency_check', getErrorType(error));
  }
}
```

### API Error Classification
- `TIMEOUT_ERROR` - Operation exceeded time limit (use in retry logic)
- `RATE_LIMIT_ERROR` - API returned 429 (implement backoff)
- `AUTHENTICATION_ERROR` - Invalid API key or missing permission
- `VALIDATION_ERROR` - Bad input parameters
- `INTERNAL_ERROR` - Server-side failure, safe to retry

## Performance Optimization

### Query Optimization
- **Avoid N+1 queries**: Don't loop calling `getBalance()`. Fetch all user IDs once, then batch query if possible.
- **Index usage**: Conversation memories indexed on `(user_id, timestamp DESC)`. Always filter by user_id first, then time range.
- **Media cache cleanup**: Automatic via `last_accessed` index. Cache hit saves ~500ms API call and $0.01 per analyze.

### API Cost Reduction
1. **Reuse cached media**: Check `media_cache` before calling `analyzeImageWithOpenRouter()` (~$0.01 saved per cache hit).
2. **Batch analyze only latest message**: `buildConversationContext()` only analyzes newest message images to reduce costs.
3. **Enable cache control**: OpenRouter's ephemeral cache saves ~20% on large system prompts. Use `cacheControl: true` in `callOpenRouterAPI()`.
4. **Model selection by cost**:
   - MiMo-V2-Flash: Cheapest for sentiment ($0.09/$0.29/1M)
   - Gemini 3.1 Flash-Lite: Best vision quality ($0.25/$1.50/1M)
   - Qwen 2.5 VL 7B: Text/meme specialist ($0.12/$0.36/1M)
   - DeepSeek Chat: Personality & reasoning ($0.14/$0.28/1M)

## Database Atomicity & Consistency

### Multi-Step Operations
When operation requires multiple DB calls:
1. **Fetch authoritative state** (balance, cooldown, etc.)
2. **Validate against state** (sufficient balance, not on cooldown)
3. **Execute atomic update** (single UPDATE or INSERT statement)
4. **If fails**: Return error, state unchanged

## Testing & Validation Checklist

### Pre-Implementation
- [ ] Command follows existing pattern in `src/commands/tools/`
- [ ] Database operations use utility functions from `db.js`, not raw SQL
- [ ] Timeout handling: Operations >3s call `interaction.deferReply()`
- [ ] Error handling: Command wrapped in try-catch with `handleCommandError()`
- [ ] Permissions: Owner-only logic verified (use `constants.isOwner()`)
- [ ] Currency validation: Check balance before deducting
- [ ] Button collectors: Immediate `deferUpdate()`, proper cleanup on end/error
- [ ] Embed usage: Uses functions from `embedBuilder.js`
- [ ] Ephemeral messages: Uses `MessageFlags.Ephemeral`, not deprecated `ephemeral: true`

### Testing Locally
```bash
npm start              # Runs bot, auto-loads commands per guild
npm test               # Jest + ESLint
```

## Common Issues & Diagnostics

1. **"Interaction failed"** → Missing `deferReply()` or `deferUpdate()` before 3s timeout
2. **"Interaction already replied"** → Multiple `reply()` calls or missing defer
3. **Balance not updating** → Verify `updateBalance()` completed and DB flushed
4. **Media analysis returning null** → Check image URL is public, timeout not hit
5. **Command not registering** → Verify guild ID, command name syntax
6. **User sees error but no log** → Wrap entire command in try-catch

## Code Style Guidelines

### Variable Naming
- User IDs: `userId` (camelCase) or `user_id` (snake_case in DB)
- Discord Snowflakes: Always `string` type, never `number`
- Balance: Always `balance`, consistent naming
- Messages: `messageId`, `channelId`, `guildId`

### Import Order (Commands)
```javascript
// 1. Discord.js imports
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

// 2. Node builtins (if any)

// 3. Local utilities
const { getBalance, updateBalance } = require('../../utils/db');
const { handleCommandError } = require('../../utils/errorHandler');
```

# Model Best Practices Checklist
- Always use `MessageFlags.Ephemeral` for ephemeral responses, never the deprecated `ephemeral: true` option
- Never write raw SQL in commands; all DB operations go through `src/utils/db.js`
- Always verify user IDs match on button clicks (`i.user.id === interaction.user.id`)
- Always call `deferReply()` or `deferUpdate()` before operations that might exceed 3 seconds
- Wrap all command logic in try-catch with `handleCommandError()` handler
- Check balance BEFORE attempting to deduct (never assume state)
- Always handle collector `end` event for cleanup (especially timeouts)
- Fetch fresh user context before modifying user preferences
- Use `isOwner()` helper from constants, never hardcode owner ID
- Reference existing similar commands for implementation patterns before writing new code
