# syntax=docker/dockerfile:1

# Build: TypeScript for the server (src + adapters + server) and nothing else.
# The EJS views are already compiled and committed, so no template work here.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json ./
COPY src ./src
COPY adapters ./adapters
COPY server ./server
RUN npm run build:server

# Runtime: production dependencies, the compiled server, the static files and
# the migrations. Runs as the unprivileged `node` user.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY public ./public
COPY migrations ./migrations
# SQLite deployments write here; PostgreSQL deployments ignore it.
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV PORT=3000
ENV DATABASE_URL=file:./data/cuota.db
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "build/server/main.js"]