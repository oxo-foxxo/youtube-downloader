# syntax=docker/dockerfile:1.7
FROM node:22.20.0-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts vitest.config.ts ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:22.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOME=/work/home \
    WORK_ROOT=/work/jobs \
    CHROMIUM_PATH=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg python3 python3-pip tini \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.lock /tmp/requirements.lock
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --home-dir /work/home --create-home app \
    && mkdir -p /app /work/jobs \
    && chown -R app:app /app /work

WORKDIR /app
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/server/index.js"]
