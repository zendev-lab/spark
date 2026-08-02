# syntax=docker/dockerfile:1

FROM node:26.5.1-bookworm-slim AS base

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

ARG SPARK_BUILD_GIT_SHA=container-build

ENV CI=1 \
    SPARK_BUILD_GIT_SHA=${SPARK_BUILD_GIT_SHA}

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

RUN pnpm_version="$(node -p "require('./package.json').packageManager.split('@').at(-1)")" \
    && npm install --global "pnpm@${pnpm_version}"

RUN pnpm fetch --frozen-lockfile

COPY . .

RUN pnpm install --offline --frozen-lockfile --ignore-scripts
RUN pnpm run release:pack

FROM base AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    SPARK_HOME=/var/lib/spark \
    SPARK_UPDATE_POLICY=manual \
    PATH=/opt/spark/node_modules/.bin:${PATH}

WORKDIR /opt/spark

COPY --from=build /src/dist/release/spark-v*.tgz /tmp/spark.tgz

RUN npm install --prefix /opt/spark --omit=dev --ignore-scripts /tmp/spark.tgz \
    && npm cache clean --force \
    && rm /tmp/spark.tgz \
    && install -d -o node -g node /var/lib/spark

USER node

VOLUME ["/var/lib/spark"]
EXPOSE 5173
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5173/api/v1/health').then(async (response) => { const body = await response.json(); if (!response.ok || body.service !== 'spark-cockpit' || body.status !== 'ok') process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "/opt/spark/node_modules/@zendev-lab/spark/dist/spark-cockpit-server.js"]
