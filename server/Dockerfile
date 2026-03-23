FROM node:22-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Build with tsup (bundles to dist/index.js)
RUN pnpm run build
# Copy SQL asset alongside the bundle so readFileSync can find it
RUN cp src/db/schema.sql dist/schema.sql

# Create logs directory
RUN mkdir -p /app/logs

# Non-root user
RUN adduser --disabled-password --no-create-home fenris
USER fenris

# Expose port
EXPOSE 3200

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --spider --quiet --tries=1 --timeout=5 http://localhost:3200/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
