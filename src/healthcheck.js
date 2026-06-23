'use strict';

// Container healthcheck for the API service.
//
// Exits 0 only when GET /health returns 200 with status "ok"; exits 1 otherwise.
// Kept as a standalone script (rather than an inline `node -e "..."` in compose)
// so it has no shell metacharacters — some compose runtimes (e.g. podman-compose)
// execute the healthcheck via /bin/sh, where parens in an inline program break.

const http = require('http');

const port = Number(process.env.PORT) || 8080;

const req = http.get(
  { host: '127.0.0.1', port, path: '/health', timeout: 4000 },
  (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      let ok = false;
      try {
        ok = res.statusCode === 200 && JSON.parse(body).status === 'ok';
      } catch (_) {
        ok = false;
      }
      process.exit(ok ? 0 : 1);
    });
  }
);

req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
