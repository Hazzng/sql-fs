# syntax=docker/dockerfile:1.7

# ------- Builder -------
FROM node:22-bookworm AS builder
WORKDIR /app
RUN corepack enable
# curl/unzip/bzip2 are needed by scripts/fetch-pyodide-assets.mjs (curl download,
# unzip the Deno binary, tar -xj the Pyodide .tar.bz2).
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip bzip2 \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml package.json ./
# Remove the `prepare` lifecycle hook before install. lefthook install panics
# in Docker Desktop's Linux VM (Go taggedPointerPack runtime bug). Git hooks
# are not needed in the build image; this edit is layer-local only.
RUN node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.scripts.prepare;fs.writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Vendor the Pyodide runtime assets (pinned Deno binary + Pyodide distribution +
# wheels) and build the supplementary custom lock. Reproduced fresh here — never
# committed (see .gitignore / .dockerignore).
RUN node scripts/fetch-pyodide-assets.mjs && node scripts/build-pyodide-lock.mjs

# ------- Runtime -------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
# Pyodide runtime: Node resolves these before spawning the Deno child (Phase 4).
ENV PYODIDE_ASSET_DIR=/app/vendor/pyodide
ENV DENO_BIN_PATH=/app/vendor/deno/deno
WORKDIR /app
RUN groupadd -r app && useradd -r -g app app
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json
# dist/pyodide-runner (raw .ts, copied by the build) ships inside ./dist above;
# vendor/ carries the Deno binary + Pyodide distribution + custom lock.
COPY --from=builder --chown=app:app /app/vendor ./vendor
USER app
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/api/server.js"]
