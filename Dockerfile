FROM node:22-slim

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

# Install system dependencies:
#   ffmpeg      - required by fluent-ffmpeg for video/GIF processing
#   fontconfig  - required to register our bundled Impact font for SVG/caption rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (ships with Node 22)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy lockfile + manifest first for better layer caching
COPY package.json pnpm-lock.yaml ./

# Install production dependencies.
# --no-frozen-lockfile is intentional: pnpm-lock.yaml was generated on Windows,
# so platform-specific packages (sharp) must be resolved for Linux at build time.
RUN pnpm install --prod --no-frozen-lockfile

# Copy the rest of the source
COPY . .

# Register the bundled Impact font so librsvg/fontconfig can use it for caption rendering
RUN echo '<fontconfig><dir>/app/src/assets/fonts</dir></fontconfig>' \
    > /etc/fonts/conf.d/99-app-fonts.conf && fc-cache -f

CMD ["node", "src/bot.js"]
