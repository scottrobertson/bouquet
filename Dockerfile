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
# ffprobe (shipped in ffmpeg) reads stream quality for the probe feature. Kept
# first so this slow apt layer stays cached when only the app or deps change.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json server.js ./
COPY drizzle ./drizzle
EXPOSE 3000
CMD ["node", "server.js"]
