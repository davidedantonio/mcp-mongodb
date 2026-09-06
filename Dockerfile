FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first: this layer is cached until the lockfile moves.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY index.ts ./
COPY src ./src

# noEmitOnError is on, so a type error fails the image build rather
# than shipping JavaScript that crashes on start.
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only: no TypeScript, no tsx, no test runner.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/lib ./lib

# The image carries no config: mount it and point MCP_CONFIG_PATH at it.
# Nothing is exposed until it does.
USER node

# Only meaningful with MCP_TRANSPORT=http. Under stdio the client owns
# the process and this port is unused.
EXPOSE 3000

ENTRYPOINT ["node", "lib/index.js"]
