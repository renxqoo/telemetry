FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build
WORKDIR /app
RUN npm install --global bun@1.4.4
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
RUN bun install --production --frozen-lockfile
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
WORKDIR /app
RUN groupadd --gid 10001 telemetry && useradd --uid 10001 --gid 10001 --no-create-home telemetry
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
USER 10001:10001
ENV NODE_ENV=production
CMD ["node", "dist/apps/collector/src/main.js"]
