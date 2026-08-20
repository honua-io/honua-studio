FROM node:20.19-alpine@sha256:658d0f63e501824d6c23e06d4bb95c71e7d704537c9d9272f488ac03a370d448 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
ENV HONUA_SERVER_BASE_URL=/api \
    HONUA_OIDC_ISSUER= \
    HONUA_OIDC_CLIENT_ID= \
    HONUA_OIDC_REDIRECT_URI= \
    HONUA_OIDC_SCOPES="openid profile honua.read honua.write" \
    HONUA_MODEL_PROVIDER= \
    HONUA_MODEL=
COPY --chown=101:101 --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/runtime-config.template.json /tmp/honua-studio-config.template.json
COPY --chmod=755 docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
