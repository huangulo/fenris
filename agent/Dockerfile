FROM node:22-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json ./
RUN pnpm install

COPY . .

# Build with tsup
RUN pnpm run build

# Non-root user
RUN adduser --disabled-password --no-create-home fenris-agent
USER fenris-agent

# Start agent
CMD ["node", "dist/index.js"]
