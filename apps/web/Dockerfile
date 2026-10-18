# Built from the repo root (npm workspace): web depends on packages/core.
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS builder

WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace web --workspace @memento/core --include-workspace-root

COPY packages/core packages/core
COPY apps/web apps/web
# Don't set NEXT_PUBLIC_API_URL — frontend auto-detects from window.location
RUN npm run build -w web

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./.next/static
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./public
COPY --from=builder /repo/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
