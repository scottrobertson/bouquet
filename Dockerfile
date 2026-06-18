# syntax=docker/dockerfile:1

# Debian-based image so better-sqlite3 native prebuilds work without a toolchain.
FROM node:22-bookworm-slim AS dev-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=dev-deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
# curl is handy for debugging the container (hitting internal routes, checking streams).
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
# ffprobe/ffmpeg read stream quality for the probe feature. Use a current static
# build instead of Debian's (which is an old 5.1 with backported HLS limits and
# no -extension_picky), so its HLS handling matches dev. Kept first so this layer
# stays cached when only the app or deps change.
COPY --from=mwader/static-ffmpeg:8.1.2 /ffmpeg /ffprobe /usr/local/bin/
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json server.js ./
COPY drizzle ./drizzle
EXPOSE 3000
CMD ["node", "server.js"]
