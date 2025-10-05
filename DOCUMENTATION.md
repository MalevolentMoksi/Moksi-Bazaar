# Moksi's Bazaar - Discord Bot Documentation

![Discord Bot](https://img.shields.io/badge/Discord-Bot-7289da?style=for-the-badge&logo=discord)
![Node.js](https://img.shields.io/badge/Node.js-18-339933?style=for-the-badge&logo=node.js)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-336791?style=for-the-badge&logo=postgresql)

Moksi's Bazaar is a feature-rich Discord bot built with Discord.js v14, offering various games, utilities, and interactive features centered around a virtual currency system. The bot provides entertainment through gambling games, relationship simulations, voice functionality, and productivity tools.

## 📋 Table of Contents

- [Project Overview](#-project-overview)
- [Architecture](#-architecture)
- [Core Features](#-core-features)
- [Technical Implementation](#-technical-implementation)
- [Installation & Setup](#-installation--setup)
- [Deployment](#-deployment)
- [Development Workflow](#-development-workflow)
- [Command Reference](#-command-reference)
- [API Integration](#-api-integration)
- [Contributing](#-contributing)
- [License](#-license)

## 🎯 Project Overview

**Repository**: [MalevolentMoksi/Moksi-Bazaar](https://github.com/MalevolentMoksi/Moksi-Bazaar)  
**Language**: JavaScript (Node.js)  
**Framework**: Discord.js v14  
**Database**: PostgreSQL  
**Deployment**: Docker support with Railway/Nixpacks integration  
**Author**: Moksi  
**Version**: 1.0.0  

### Key Statistics
- **Created**: May 24, 2025
- **Last Updated**: October 5, 2025
- **Size**: 22,787 KB
- **Commands**: 20+ interactive commands
- **Language**: JavaScript (Primary)

## 🏗️ Architecture

### Project Structure

```
Moksi-Bazaar/
├── 📁 src/
│   ├── 🤖 bot.js              # Main bot entry point
│   ├── 📁 commands/
│   │   └── 📁 tools/          # All bot commands (20 files)
│   ├── 📁 events/             # Discord event handlers
│   ├── 📁 functions/
│   │   └── 📁 handlers/       # Command and event handlers
│   ├── 📁 utils/
│   │   ├── 🗄️ db.js           # Database utilities (47KB)
│   │   └── 🎭 presence.js     # Bot status/presence
│   └── 📁 assets/            # Bot assets and media
├── 🐳 Dockerfile             # Container configuration
├── ⚙️ .nixpacks.toml         # Railway deployment config
├── 📦 package.json           # Dependencies and scripts
├── 💰 balances.json          # User balance storage
├── 🌳 tree.txt               # Project structure (102KB)
└── 📚 README.md              # Basic project description
```

### Core Components

| Component | Purpose | Size | Key Features |
|-----------|---------|------|--------------|
| **bot.js** | Main entry point | 1.3KB | Client initialization, handler loading |
| **db.js** | Database utilities | 47.5KB | PostgreSQL integration, user management |
| **Commands** | Bot functionality | 20 files | Games, utilities, social features |
| **Events** | Discord events | Multiple | Message handling, user interactions |

## 🎮 Core Features

### 💰 Currency System
The bot maintains a sophisticated virtual currency system where users earn and spend coins through various activities and games. Features include:
- **Balance Management**: Real-time balance tracking
- **Transaction History**: Complete audit trail
- **Earning Mechanisms**: Multiple ways to earn currency
- **Spending Options**: Various games and services

### 🎲 Gaming Suite

#### Casino Games
| Game | File | Description | Features |
|------|------|-------------|----------|
| **Blackjack** | `bj.js` (10.6KB) | Classic card game | Betting system, dealer AI, multiple hands |
| **Slots** | `slots.js` (8.2KB) | Slot machine | Multiple paylines, bonus rounds, jackpots |
| **Roulette** | `roulette.js` (4.8KB) | Casino roulette | European/American variants, multiple bets |
| **Craps** | `craps.js` (3.8KB) | Dice gambling | Pass/don't pass, odds betting |
| **High/Low** | `highlow.js` (5.6KB) | Card prediction | Streak bonuses, risk/reward balance |

#### Interactive Games
| Game | File | Description | Complexity |
|------|------|-------------|-----------|
| **Tetris** | `tetris.js` (17.9KB) | Full Tetris implementation | High - Real-time gameplay |
| **Duels** | `duels.js` (5.5KB) | Player vs player battles | Medium - Turn-based combat |
| **Gacha** | `gacha.js` (4.0KB) | Collectible system | Medium - RNG mechanics |

### 👥 Social Features

#### Relationship System
The bot includes a comprehensive relationship simulation system:

- **Compatibility Analysis** (`checkrelationship.js` - 11.2KB)
  - Personality matching algorithms
  - Compatibility scoring
  - Relationship advice generation

- **Relationship Management** (`relationoverview.js` - 10.6KB)
  - Relationship statistics tracking
  - Historical data analysis
  - Social network mapping

### 🛠️ Utility Commands

#### Productivity Tools
| Command | File | Purpose | Features |
|---------|------|---------|----------|
| **Remind** | `remind.js` (19.2KB) | Reminder system | Scheduling, recurring reminders, timezone support |
| **Currency** | `currency.js` (2.8KB) | Balance management | Check balances, transfer funds, transaction history |
| **Say** | `say.js` (811B) | Text output | Simple text repetition, formatting |

#### Voice Features
| Command | File | Purpose | Capabilities |
|---------|------|---------|--------------|
| **Speak** | `speak.js` (16.7KB) | Voice synthesis | TTS, audio playback, voice effects |
| **Speak Settings** | `speak_settings.js` (12.4KB) | Voice configuration | Voice selection, speed control, pitch adjustment |
| **Sleepy** | `sleepy.js` (4.2KB) | Sleep commands | Bedtime routines, sleep tracking |
| **Shh** | `shh.js` (8.6KB) | Audio control | Silence commands, volume control |

#### Entertainment
| Command | File | Purpose | Features |
|---------|------|---------|----------|
| **Random YouTube** | `randomyt.js` (1.4KB) | Video discovery | Random video generation |
| **Test Media** | `testmedia.js` (4.8KB) | Media analysis | File processing, format detection |

## 🔧 Technical Implementation

### Dependencies

#### Core Libraries
```json
{
  "discord.js": "^14.19.3",        // Discord API wrapper
  "@discordjs/builders": "^1.11.2", // Command builders
  "@discordjs/rest": "^2.5.0",     // REST API client
  "discord-api-types": "^0.38.2"   // Type definitions
}
```

#### Database & Storage
```json
{
  "pg": "^8.16.0",                 // PostgreSQL client
  "dotenv": "^16.5.0"              // Environment management
}
```

#### Media Processing
```json
{
  "fluent-ffmpeg": "^2.1.3",       // Audio/video processing
  "opusscript": "^0.1.1",          // Voice encoding
  "node-fetch": "^3.3.2"           // HTTP requests
}
```

#### Utilities
```json
{
  "chalk": "^4.1.2",               // Terminal styling
  "socket.io-client": "^2.4.0"     // WebSocket communication
}
```

#### Development Tools
```json
{
  "eslint": "^9.29.0",             // Code linting
  "jest": "^30.0.3"                // Testing framework
}
```

### Database Schema

The bot uses PostgreSQL with the following key tables:

#### User Balances
```sql
CREATE TABLE balances (
    user_id VARCHAR(20) PRIMARY KEY,
    balance DECIMAL(15,2) DEFAULT 100.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### Relationships
```sql
CREATE TABLE relationships (
    id SERIAL PRIMARY KEY,
    user1_id VARCHAR(20),
    user2_id VARCHAR(20),
    compatibility_score INTEGER,
    relationship_type VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### Reminders
```sql
CREATE TABLE reminders (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(20),
    channel_id VARCHAR(20),
    message TEXT,
    remind_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed BOOLEAN DEFAULT FALSE
);
```

### Bot Configuration

#### Required Intents
```javascript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,           // Server information
    GatewayIntentBits.GuildMessages,    // Message reading
    GatewayIntentBits.MessageContent,   // Message content access
    GatewayIntentBits.GuildVoiceStates  // Voice functionality
  ]
});
```

#### Command Handler
```javascript
client.commands = new Collection();
client.commandArray = [];

// Dynamic command loading
const functionFolders = fs.readdirSync('./src/functions');
for (const folder of functionFolders) {
  const functionFiles = fs.readdirSync(`./src/functions/${folder}`)
    .filter(file => file.endsWith('.js'));
  for (const file of functionFiles) {
    require(`./functions/${folder}/${file}`)(client);
  }
}
```

## 📥 Installation & Setup

### Prerequisites
- Node.js 18+ 
- PostgreSQL database
- Discord Bot Token
- Git

### Local Development Setup

1. **Clone the Repository**
```bash
git clone https://github.com/MalevolentMoksi/Moksi-Bazaar.git
cd Moksi-Bazaar
```

2. **Install Dependencies**
```bash
npm install
```

3. **Environment Configuration**
Create a `.env` file:
```env
TOKEN=your_discord_bot_token
DATABASE_URL=postgresql://username:password@localhost:5432/moksi_bazaar
NODE_ENV=development
```

4. **Database Setup**
```bash
# Create database
createdb moksi_bazaar

# Run migrations (if available)
npm run migrate
```

5. **Start Development Server**
```bash
npm start
```

### Testing
```bash
# Run linting
npm run lint

# Run tests
npm test

# Run pre-test checks
npm run pretest
```

## 🚀 Deployment

### Docker Deployment

The project includes a production-ready Dockerfile:

```dockerfile
FROM node:18-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first (better caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy source code
COPY . .

EXPOSE 3000
CMD ["node", "src/bot.js"]
```

#### Build and Run
```bash
# Build image
docker build -t moksi-bazaar .

# Run container
docker run -d --name moksi-bazaar \
  -e TOKEN=your_token \
  -e DATABASE_URL=your_db_url \
  moksi-bazaar
```

### Railway Deployment

Configured for Railway platform deployment:

**.nixpacks.toml**
```toml
[phases.build]
cmds = ["npm ci --omit=dev"]

[phases.install]
cmds = ["npm install"]

[start]
cmd = "npm start"
```

#### Railway Setup
1. Connect GitHub repository
2. Set environment variables
3. Deploy automatically on push

### Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `TOKEN` | ✅ | Discord bot token | - |
| `DATABASE_URL` | ✅ | PostgreSQL connection string | - |
| `NODE_ENV` | ❌ | Environment mode | `development` |
| `PORT` | ❌ | HTTP server port | `3000` |

## 🔄 Development Workflow

### NPM Scripts
```json
{
  "start": "node src/bot.js",        // Production start
  "dev": "nodemon src/bot.js",       // Development with auto-reload
  "test": "jest",                    // Run test suite
  "lint": "eslint . --ext .js",      // Code linting
  "pretest": "npm run lint",         // Pre-test validation
  "build": "docker build -t moksi-bazaar ."
}
```

### Code Quality Standards

#### ESLint Configuration
```json
{
  "extends": ["eslint:recommended"],
  "env": {
    "node": true,
    "es2021": true
  },
  "rules": {
    "no-console": "warn",
    "no-unused-vars": "error",
    "indent": ["error", 2],
    "quotes": ["error", "single"]
  }
}
```

#### File Organization Standards
- **Commands**: One command per file in `src/commands/tools/`
- **Events**: Event handlers in `src/events/`
- **Utilities**: Shared functions in `src/utils/`
- **Assets**: Static files in `src/assets/`

## 📖 Command Reference

### Gaming Commands

#### `/blackjack [bet]`
**File**: `bj.js` (10,595 bytes)  
**Description**: Play blackjack against the dealer  
**Parameters**:
- `bet` (number): Amount to wager

#### `/slots [bet]`
**File**: `slots.js` (8,228 bytes)  
**Description**: Spin the slot machine  
**Parameters**:
- `bet` (number): Bet amount

#### `/roulette [bet] [choice]`
**File**: `roulette.js` (4,826 bytes)  
**Description**: Play roulette  
**Parameters**:
- `bet` (number): Wager amount
- `choice` (string): Betting choice (red/black/number)

#### `/tetris`
**File**: `tetris.js` (17,882 bytes)  
**Description**: Play Tetris in Discord  
**Features**: Full game implementation with controls

### Social Commands

#### `/checkrelationship [@user]`
**File**: `checkrelationship.js` (11,175 bytes)  
**Description**: Check compatibility with another user  
**Parameters**:
- `user` (mention): Target user

#### `/relationoverview`
**File**: `relationoverview.js` (10,628 bytes)  
**Description**: View comprehensive relationship statistics

### Utility Commands

#### `/remind [time] [message]`
**File**: `remind.js` (19,205 bytes)  
**Description**: Set reminders with advanced scheduling  
**Parameters**:
- `time` (string): When to remind (e.g., "5m", "1h", "tomorrow")
- `message` (string): Reminder message

#### `/currency [user]`
**File**: `currency.js` (2,809 bytes)  
**Description**: Check balance or transfer funds  
**Parameters**:
- `user` (mention, optional): Check another user's balance

#### `/speak [text]`
**File**: `speak.js` (16,684 bytes)  
**Description**: Text-to-speech in voice channels  
**Parameters**:
- `text` (string): Text to synthesize

### Entertainment Commands

#### `/randomyt`
**File**: `randomyt.js` (1,435 bytes)  
**Description**: Get a random YouTube video

#### `/gacha [pulls]`
**File**: `gacha.js` (4,010 bytes)  
**Description**: Pull from gacha system  
**Parameters**:
- `pulls` (number): Number of pulls

## 🔌 API Integration

### External Services

The bot integrates with several external APIs and services:

#### Discord API
- **Voice Connections**: Full voice channel support
- **Slash Commands**: Modern command interface
- **Embeds**: Rich message formatting
- **Reactions**: Interactive button responses

#### Database Services
- **PostgreSQL**: Primary data storage
- **Connection Pooling**: Efficient database connections
- **Migrations**: Schema version management

#### Media Processing
- **FFmpeg**: Audio/video processing
- **Opus Encoding**: Voice data compression
- **WebSocket**: Real-time communication

### Custom API Endpoints

The bot exposes several internal APIs for monitoring and management:

#### Health Check
```
GET /health
Response: { "status": "ok", "uptime": 12345 }
```

#### Statistics
```
GET /stats
Response: { 
  "guilds": 15, 
  "users": 1250, 
  "commands_executed": 5432 
}
```

## 🤝 Contributing

### Development Guidelines

1. **Code Style**
   - Follow ESLint configuration
   - Use consistent naming conventions
   - Add JSDoc comments for functions

2. **File Organization**
   - Commands in `src/commands/tools/`
   - Utilities in `src/utils/`
   - One feature per file

3. **Database Changes**
   - Create migration files
   - Update schema documentation
   - Test with sample data

4. **Testing**
   - Write unit tests for new features
   - Test command interactions
   - Verify database operations

### Pull Request Process

1. Fork the repository
2. Create feature branch
3. Implement changes with tests
4. Run linting and tests
5. Submit pull request with description

### Bug Reports

Use GitHub issues with:
- Clear description
- Steps to reproduce
- Expected vs actual behavior
- Environment information

## 📄 License

**License**: ISC  
**Author**: Moksi  
**Repository**: [MalevolentMoksi/Moksi-Bazaar](https://github.com/MalevolentMoksi/Moksi-Bazaar)

## 📞 Support

For support and questions:
- **GitHub Issues**: Bug reports and feature requests
- **Discord**: Join our community server
- **Documentation**: This comprehensive guide

---

## 📊 Project Statistics

| Metric | Value |
|--------|-------|
| **Total Files** | 50+ files |
| **Lines of Code** | 15,000+ lines |
| **Commands** | 20+ interactive commands |
| **Database Tables** | 10+ tables |
| **Dependencies** | 12 production, 2 development |
| **Docker Image Size** | ~200MB |
| **Supported Users** | Unlimited |

## 🔮 Future Roadmap

- [ ] Web dashboard for bot management
- [ ] Advanced analytics and reporting
- [ ] Mobile companion app
- [ ] Multi-language support
- [ ] Advanced AI integration
- [ ] Custom game development framework
- [ ] Enhanced voice features
- [ ] Real-time tournaments

---

*Last Updated: October 5, 2025*  
*Generated Documentation for Moksi's Bazaar Discord Bot*