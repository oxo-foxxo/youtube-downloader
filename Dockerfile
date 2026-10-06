# syntax=docker/dockerfile:1.7
FROM node:22.20.0-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts vitest.config.ts ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:22.20.0-bookworm-slim AS runtime-base

ENV NODE_ENV=production \
    HOME=/work/home \
    WORK_ROOT=/work/jobs \
    CHROMIUM_PATH=/app/scripts/chromium-guest.sh

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg python3 python3-pip tini xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.lock /tmp/requirements.lock
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --home-dir /work/home --create-home app \
    && mkdir -p /app /work/jobs \
    && chown -R app:app /app /work

WORKDIR /app

FROM runtime-base AS runtime
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chmod=755 scripts/chromium-guest.sh ./scripts/chromium-guest.sh

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["xvfb-run", "-a", "node", "dist/src/server/index.js"]

FROM runtime-base AS session-browser
RUN apt-get update \
    && apt-get install -y --no-install-recommends novnc websockify x11vnc openbox x11-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /session /control \
    && chown app:app /session /control \
    && chmod 700 /session /control
COPY --chmod=755 scripts/start-session-browser.sh /app/scripts/start-session-browser.sh
COPY scripts/session-browser.py /app/scripts/session-browser.py
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/scripts/start-session-browser.sh"]
