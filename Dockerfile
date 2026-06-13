# syntax=docker/dockerfile:1

# --- Web (Vite SPA) ---
FROM node:22-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Backend build (TypeScript -> dist) ---
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build

# --- Runtime ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web/dist
COPY prisma ./prisma
ENV STATIC_DIR=/app/web/dist
EXPOSE 8762
# Apply migrations to the (volume-backed) sqlite DB, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/server.js"]
