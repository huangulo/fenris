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

# Create logs and data directories, owned by non-root user
RUN adduser --disabled-password --no-create-home fenris \
 && mkdir -p /app/logs /app/data \
 && chown -R fenris:fenris /app/logs /app/data

USER fenris

# Expose port
EXPOSE 3200

# Health check — use node fetch with explicit IPv4 address; wget resolves
# 'localhost' to ::1 (IPv6) in Alpine but the server only listens on IPv4.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3200/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Start server
CMD ["node", "dist/index.js"]
