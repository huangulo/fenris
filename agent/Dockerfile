FROM node:22-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json ./
# Postinstall scripts (esbuild, ssh2, cpu-features, protobufjs) aren't needed; skip
# them so pnpm doesn't fail with ERR_PNPM_IGNORED_BUILDS in non-interactive builds
ENV CI=true
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false
RUN pnpm install --ignore-scripts

COPY . .

# Build with tsup
RUN pnpm run build

# Non-root user
RUN adduser --disabled-password --no-create-home fenris-agent
USER fenris-agent

# Start agent
CMD ["node", "dist/index.js"]
