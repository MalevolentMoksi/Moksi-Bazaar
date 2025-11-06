FROM node:22-slim

# Enable pnpm
ENV NODE_ENV=production

WORKDIR /app

# Copy package files first (for better caching)
COPY package.json package-lock.json ./

# Install dependencies (reproducible, fast, no audit/fund noise)
RUN npm ci --omit=dev --no-audit --no-fund


# Copy source code
COPY . .

# Expose port (if your bot uses HTTP)
EXPOSE 3000

# Start the bot
CMD ["node", "src/bot.js"]
