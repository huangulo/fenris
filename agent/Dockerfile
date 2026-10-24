FROM node:22-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.34.8 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# Postinstall scripts (esbuild, ssh2, cpu-features, protobufjs) aren't needed; skip
# them so pnpm doesn't fail with ERR_PNPM_IGNORED_BUILDS in non-interactive builds
ENV CI=true
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# Build with tsup
RUN pnpm run build

# Drop dev deps and the base image's bundled npm (unused at runtime, and the
# source of most scanner findings: tar, picomatch, brace-expansion, ip-address)
RUN pnpm prune --prod \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Non-root user
RUN adduser --disabled-password --no-create-home fenris-agent
USER fenris-agent

# Start agent
CMD ["node", "dist/index.js"]
