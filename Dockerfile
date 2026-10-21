# syntax=docker/dockerfile:1

# The browser app, built to static files.
FROM node:26-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The build renders the app's first page through a short-lived local server.
# Build containers often have no IPv6 loopback, so make "localhost" mean 127.0.0.1.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
RUN npm run build

# The Rust server, with the browser app built into the binary.
FROM rust:1-bookworm AS server
WORKDIR /app
COPY server ./server
COPY --from=web /app/build ./build
# The cache mounts keep downloaded crates and compiled dependencies between
# builds, so only Bouquet's own code is recompiled.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/server/target \
    cd server && cargo build --release && cp target/release/bouquet /usr/local/bin/bouquet

FROM debian:bookworm-slim AS runtime
# curl is handy for debugging the container (hitting internal routes, checking
# streams). ca-certificates lets the server reach providers and S3 over https.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
# ffprobe/ffmpeg read stream quality for the probe feature. Use a current static
# build instead of Debian's (which is an old 5.1 with backported HLS limits and
# no -extension_picky), so its HLS handling matches dev. Kept first so this layer
# stays cached when only the app changes.
COPY --from=mwader/static-ffmpeg:8.1.2 /ffmpeg /ffprobe /usr/local/bin/
COPY --from=server /usr/local/bin/bouquet /usr/local/bin/bouquet
WORKDIR /app
EXPOSE 3000
CMD ["bouquet"]
