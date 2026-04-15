FROM node:22-slim

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

# Install system dependencies:
#   ffmpeg       - required by fluent-ffmpeg for video/GIF processing
#   libcairo2, libpango*, libjpeg*, libgif*, librsvg2-2
#                - runtime libs for the canvas npm package (caption rendering)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (ships with Node 22)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy lockfile + manifest first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install production dependencies
# --no-frozen-lockfile is intentional: the lock file is generated on Windows
# so platform-specific packages (sharp, canvas) must be resolved for Linux at build time
RUN pnpm install --prod --no-frozen-lockfile

# Copy the rest of the source
COPY . .

CMD ["node", "src/bot.js"]
