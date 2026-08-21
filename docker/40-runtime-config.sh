#!/bin/sh
set -eu

output=${HONUA_CONFIG_OUTPUT:-/usr/share/nginx/studio/config.json}

json_string() {
  value=$1
  printf '"'
  if ! printf '%s' "$value" | awk '
    BEGIN { ORS = "" }
    NR > 1 { printf "\\n" }
    {
      for (i = 1; i <= length($0); i += 1) {
        char = substr($0, i, 1)
        if (char == "\\") printf "\\\\"
        else if (char == "\"") printf "\\\""
        else if (char ~ /[[:cntrl:]]/) exit 42
        else printf "%s", char
      }
    }
  '; then
    echo "runtime config contains an unsupported control character" >&2
    return 1
  fi
  printf '"'
}

temporary="/tmp/honua-runtime-config.$$"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
{
  printf '{\n  "serverBaseUrl": '
  json_string "${HONUA_SERVER_BASE_URL:-}"
  printf ',\n'
  printf '  "oidc": {\n'
  printf '    "issuer": '
  json_string "${HONUA_OIDC_ISSUER:-}"
  printf ',\n    "clientId": '
  json_string "${HONUA_OIDC_CLIENT_ID:-}"
  printf ',\n    "redirectUri": '
  json_string "${HONUA_OIDC_REDIRECT_URI:-}"
  printf ',\n    "scopes": '
  json_string "${HONUA_OIDC_SCOPES:-}"
  printf '\n'
  printf '  },\n  "model": {\n'
  printf '    "provider": '
  json_string "${HONUA_MODEL_PROVIDER:-}"
  printf ',\n    "model": '
  json_string "${HONUA_MODEL:-}"
  printf '\n'
  printf '  }\n}\n'
} > "$temporary"
cat "$temporary" > "$output"
rm -f "$temporary"
trap - EXIT HUP INT TERM
