# The API, built for production. Node 24 (same as .nvmrc).
#   runtime (default): the API only, production packages only.
#   tools:   migrations and operator scripts (set a password); run once with `docker compose run --rm tools ...`.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM deps AS tools
ENV NODE_ENV=production
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
USER node
CMD ["npx", "tsx", "scripts/migrate.ts"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
