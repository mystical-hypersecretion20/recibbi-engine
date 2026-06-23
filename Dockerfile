# Works with both `docker build` and `podman build`.
# (Podman also auto-detects a file named `Containerfile`; a symlink is provided.)
FROM docker.io/library/node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json* ./
# better-sqlite3 is a NATIVE module. Two constraints on this setup: (1) v11.10.0
# is the last release shipping a Node-20/ABI-115 prebuilt, and (2) the
# TLS-interception wall blocks prebuild-install's GitHub download from inside the build. So we
# vendor the prebuilt (see .vendor/, fetched with curl) and install JS deps with
# --ignore-scripts (the only build script we skip is better-sqlite3's native
# build; tesseract.js's is a harmless `opencollective-postinstall || true`), then
# drop the prebuilt binary for THIS image's arch into place and verify it loads.
COPY .vendor/ /tmp/vendor/
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi \
 && arch="$(node -p 'process.arch')" \
 && tar -xzf "/tmp/vendor/better-sqlite3-v11.10.0-node-v115-linuxmusl-${arch}.tar.gz" -C node_modules/better-sqlite3/ \
 && node -e "new (require('better-sqlite3'))(':memory:').exec('SELECT 1')" \
 && echo "better-sqlite3 native module OK (${arch})" \
 && rm -rf /tmp/vendor

# App source
COPY . .

# Run as the unprivileged built-in `node` user (uid 1000).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

EXPOSE 8080

# Default command; compose overrides this per-service (server/worker/bot).
CMD ["node", "src/server.js"]
