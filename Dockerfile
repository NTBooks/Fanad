# Fanad container image — serves the REST API + built web UI on :8787.
# Used both for the Home Assistant App (published to ghcr.io) and plain `docker run`.
# node:24-alpine is deliberate: native node:sqlite (no C++ addon) needs Node >= 24, and
# the only binary dep (@resvg/resvg-js, for chart PNGs) ships musl prebuilds for x64+arm64.
FROM node:24-alpine

WORKDIR /app

# Install deps first for better layer caching. Workspaces need each package.json present.
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY cli/package.json cli/
RUN npm ci

# App source, then build the web + CLI bundles (same as `npm run build`).
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PERSIST_DATA=/data
EXPOSE 8787

# The entrypoint maps Home Assistant add-on options (/data/options.json) onto env, then
# starts the server. With no options.json (plain docker) it uses the container env as-is.
CMD ["node", "entrypoint.mjs"]
