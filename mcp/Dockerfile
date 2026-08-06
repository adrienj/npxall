# ─── Dependency stage ─────────────────────────────────────────────────────────
# secure-exec runs code in V8 isolates via isolated-vm, which ships no musl
# prebuilds and must be compiled from source. The toolchain stays in this stage
# so the runtime image does not carry a C++ compiler.
FROM node:22-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN cd mcp && npm ci --omit=dev

# shared/ declares its own secure-exec dependency. Node resolves bare specifiers
# from the IMPORTING file's directory upward, so shared/secure-exec-sandbox.js can
# only ever see shared/node_modules — never mcp/node_modules. Without this install
# the server dies on boot with ERR_MODULE_NOT_FOUND for 'secure-exec'.
COPY shared/package.json shared/package-lock.json ./shared/
RUN cd shared && npm ci --omit=dev

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY --from=deps /app/mcp/node_modules ./mcp/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules

# package.json files carry "type": "module" — without them Node parses the
# servers as CommonJS and the ESM imports fail.
COPY shared/ ./shared/
COPY mcp/package.json mcp/server.js ./mcp/

# Writable cache directory for on-demand npm installs.
# Runs as the unprivileged `node` user: nothing here needs root now that bubblewrap
# (and its CAP_SYS_ADMIN requirement) is gone.
# /app itself must be owned too: bootClean() rmdir's /app/cache on startup, and
# removing a directory requires write permission on its PARENT.
RUN mkdir -p /app/cache && chown node:node /app && chown -R node:node /app/cache
USER node

EXPOSE 3001

CMD ["node", "mcp/server.js"]
