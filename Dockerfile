ARG SOURCE_DATE_EPOCH=0
FROM node:20.19-alpine@sha256:658d0f63e501824d6c23e06d4bb95c71e7d704537c9d9272f488ac03a370d448 AS build
ARG SOURCE_DATE_EPOCH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
ARG SOURCE_DATE_EPOCH
ENV HONUA_SERVER_BASE_URL=/api \
    HONUA_OIDC_ISSUER= \
    HONUA_OIDC_CLIENT_ID= \
    HONUA_OIDC_REDIRECT_URI= \
    HONUA_OIDC_SCOPES="openid profile honua.read honua.write" \
    HONUA_MODEL_PROVIDER= \
    HONUA_MODEL=
USER 0
RUN --mount=from=build,source=/app/dist,target=/tmp/studio-dist,ro \
    --mount=type=bind,source=docker,target=/tmp/studio-docker,ro \
    set -eu; \
    rm -rf /usr/share/nginx/html/*; \
    cp -a /tmp/studio-dist/. /usr/share/nginx/html/; \
    cp /tmp/studio-docker/nginx.conf /etc/nginx/conf.d/default.conf; \
    cp /tmp/studio-docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh; \
    chown -R 101:101 /usr/share/nginx/html; \
    chmod 0644 /etc/nginx/conf.d/default.conf; \
    chmod 0755 /docker-entrypoint.d/40-runtime-config.sh; \
    find /usr/share/nginx/html -exec touch -d "@$SOURCE_DATE_EPOCH" {} +; \
    touch -d "@$SOURCE_DATE_EPOCH" \
      /etc /etc/nginx/conf.d /etc/nginx/conf.d/default.conf \
      /docker-entrypoint.d /docker-entrypoint.d/40-runtime-config.sh
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
