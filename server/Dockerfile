FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Compile TypeScript
RUN npm install -g typescript
RUN npx tsc

# Create logs directory
RUN mkdir -p /app/logs

# Expose port
EXPOSE 3200

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --spider --quiet --tries=1 --timeout=5 http://localhost:3200/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
