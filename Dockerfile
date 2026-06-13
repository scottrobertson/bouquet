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
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json server.js ./
COPY drizzle ./drizzle
EXPOSE 3000
CMD ["node", "server.js"]
