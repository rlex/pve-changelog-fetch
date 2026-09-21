# Multi-stage build. Stage 1: deps + frontend (vite) + Node server bundle (esbuild).
# Stage 2: runtime image with only the static assets + bundled server — no node_modules.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run sync && npm run build && npm run build:server

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist-server/server.mjs"]