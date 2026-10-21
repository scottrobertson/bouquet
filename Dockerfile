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
WORKDIR /app/server
# Compile the dependencies on their own first, against placeholder sources.
# This layer only changes when Cargo.toml or Cargo.lock do, so CI's layer cache
# skips rebuilding every crate when only Bouquet's own code changed.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && touch src/lib.rs \
    && cargo build --release && rm -rf src
COPY server ./
COPY --from=web /app/build ../build
# Touched so cargo sees the real sources as newer than the placeholder build.
RUN touch src/main.rs src/lib.rs && cargo build --release \
    && cp target/release/bouquet /usr/local/bin/bouquet

# Distroless has just what a Rust binary needs: glibc, the gcc runtime and CA
# certificates for reaching providers and S3 over https. The debug variant adds
# a busybox shell and wget for poking around inside a running container.
FROM gcr.io/distroless/cc-debian12:debug AS runtime
# ffprobe/ffmpeg read stream quality for the probe feature. Use a current static
# build instead of Debian's (which is an old 5.1 with backported HLS limits and
# no -extension_picky), so its HLS handling matches dev. Kept first so this layer
# stays cached when only the app changes.
COPY --from=mwader/static-ffmpeg:8.1.2 /ffmpeg /ffprobe /usr/local/bin/
COPY --from=server /usr/local/bin/bouquet /usr/local/bin/bouquet
WORKDIR /app
# The debug variant starts a shell by default.
ENTRYPOINT []
EXPOSE 3000
CMD ["bouquet"]
