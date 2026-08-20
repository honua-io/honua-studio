FROM node:20.19-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
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
