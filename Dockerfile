FROM node:18-slim

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@9.1.4 --activate

WORKDIR /app

# --- ffmpeg install for vc ---
RUN apt-get update \
  && apt-get install -y ffmpeg python3 python3-pip \
  && pip3 install yt-dlp --break-system-packages



# Copy package files first (for better caching)
COPY package.json pnpm-lock.yaml ./

# Install dependencies (cached unless package files change)
RUN pnpm install --frozen-lockfile --prod

# Copy source code
COPY . .

# Expose port (if your bot uses HTTP)
EXPOSE 3000

# Start the bot
CMD ["node", "src/bot.js"]
