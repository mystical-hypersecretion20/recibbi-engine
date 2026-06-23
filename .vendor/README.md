# Vendored native prebuilt binaries

`better-sqlite3` is a **native** module. On this project's setup it can't be
installed the normal way, so its prebuilt binary is vendored here and installed
offline:

- **Node 20 only has a prebuilt up to `better-sqlite3@11.10.0`** — v12 dropped the
  Node-20 / ABI-115 binaries (it ships ABI v127+ only), forcing a source compile.
  So the dependency is pinned to `11.10.0`.
- **TLS interception breaks the download from Node** (`prebuild-install`
  and node-gyp fail with `unable to get local issuer certificate`). `curl` is not
  affected, so we fetch the prebuilt with curl and drop it in.

The `*.tar.gz` files are **gitignored** (like `tessdata/*.traineddata`) — fetch
them per machine. They must exist here for:

1. **Local dev** — install JS deps without the native build, then extract the
   macOS binary:
   ```bash
   cd receipt-enricher
   npm install --ignore-scripts
   tar -xzf .vendor/better-sqlite3-v11.10.0-node-v115-darwin-arm64.tar.gz \
       -C node_modules/better-sqlite3/        # -> build/Release/better_sqlite3.node
   node -e "new (require('better-sqlite3'))(':memory:').exec('SELECT 1')"   # verify
   ```

2. **The container build** — the `Dockerfile` copies `.vendor/` into the build and
   extracts the `linuxmusl-<arch>` binary (the image is `node:20-alpine` = musl).

## Fetch them (curl works even when Node's TLS is blocked)

```bash
cd receipt-enricher
V=11.10.0; BASE="https://github.com/WiseLibs/better-sqlite3/releases/download/v$V"
for a in darwin-arm64 linuxmusl-arm64 linuxmusl-x64; do
  curl -sL -o ".vendor/better-sqlite3-v$V-node-v115-$a.tar.gz" \
    "$BASE/better-sqlite3-v$V-node-v115-$a.tar.gz"
done
```

`darwin-arm64` is for local dev on Apple Silicon; the two `linuxmusl` archs cover
the container on arm64 and x64 hosts. ABI `v115` = Node 20.
