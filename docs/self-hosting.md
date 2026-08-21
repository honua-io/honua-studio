# Self-host Honua Studio

Honua Studio is a static browser application. The container serves the same
immutable bundle everywhere and writes `config.json` from environment values
at startup, so server, OIDC, and model routing do not require a rebuild.

```bash
docker build -t honua-studio:2026.1 .
docker run --rm -p 8080:8080 \
  -e HONUA_SERVER_BASE_URL=https://honua.example.com \
  -e HONUA_OIDC_ISSUER=https://idp.example.com/realms/honua \
  -e HONUA_OIDC_CLIENT_ID=honua-studio \
  -e HONUA_OIDC_REDIRECT_URI=http://localhost:8080/ \
  -e HONUA_MODEL_PROVIDER=bedrock \
  -e HONUA_MODEL=operator-default \
  honua-studio:2026.1
```

`HONUA_SERVER_BASE_URL` is the Honua server origin before `/v1` and `/mcp`
(do not append `/api` for a direct server connection). The server must allow
the Studio origin. Model credentials remain server-side; the browser receives
only a provider/model route. Do not put API keys or client secrets in these
values or in `config.json`.

For a plain static host, copy `dist/` and replace `config.json` with the same
shape as `public/config.json`. Configure an SPA fallback to `index.html`, cache
hashed `/assets/` indefinitely, and serve `config.json` with `no-store`.

## Honest integration gates

- honua-server#3303 must land before a real operator-selected provider can be
  authenticated and verified through the Studio AI proxy.
- honua-server#3312 must land before draft durability can be claimed across a
  server restart.
- honua-server#3304 must land before Studio can poll a real publication request
  and return its human-approved link.

The local mock covers these browser contracts deterministically. It is not a
production server or a hosted-demo receipt.
