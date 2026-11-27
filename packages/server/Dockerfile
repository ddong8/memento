# The TypeScript server (docs/ts-server-migration.md). Built from the repo root (npm workspace):
#   docker build -f packages/server/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --workspace @memento/server --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/server packages/server
RUN npm run build -w @memento/server

# One bundled file, no node_modules
FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/packages/server/dist ./dist
COPY deploy/bootstrap ./bootstrap
COPY data/updates ./data/updates
ENV NODE_ENV=production
# Last, so a new commit doesn't invalidate the layers above; /health and the x-memento-server header report it
ARG GIT_SHA=dev
ENV MEMENTO_BUILD_SHA=${GIT_SHA}
USER node
EXPOSE 8000
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
