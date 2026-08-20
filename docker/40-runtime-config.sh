#!/bin/sh
set -eu

envsubst '${HONUA_SERVER_BASE_URL} ${HONUA_OIDC_ISSUER} ${HONUA_OIDC_CLIENT_ID} ${HONUA_OIDC_REDIRECT_URI} ${HONUA_OIDC_SCOPES} ${HONUA_MODEL_PROVIDER} ${HONUA_MODEL}' \
  < /tmp/honua-studio-config.template.json \
  > /usr/share/nginx/html/config.json
