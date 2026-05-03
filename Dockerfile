# ── Build stage: use Bun to install deps and bundle the frontend ──────────────
FROM oven/bun:1-debian AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ── Runtime stage: Node.js with Playwright's pre-configured Chromium ──────────
# The official Playwright image ships with a Chromium build that correctly
# handles --no-crashpad and all subprocess lifecycle signals, which the system
# Chromium package does not. Node.js (vs Bun) has correct SIGCHLD propagation
# so renderer child processes are reaped instead of becoming zombies.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

RUN apt-get update && apt-get install -y tini --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed node_modules and built artifacts from the builder stage.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public

# Copy source files needed at runtime.
COPY --from=builder /app/fetchers ./fetchers
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/*.ts ./
COPY --from=builder /app/*.js ./
COPY --from=builder /app/package.json ./

# The Playwright image already has Chromium at $PLAYWRIGHT_BROWSERS_PATH;
# skip downloading a second copy.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 7000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "server.ts"]
