# Self-hosted Studio

Studio is packaged as both a static tarball and the container image
`ghcr.io/honua-io/honua-studio:<version>`. Both are produced by
[`release.yml`](../.github/workflows/release.yml) when a `v*` tag is pushed.

> **No release has been cut yet.** No `v*` tag exists, so there is nothing to
> pull from GHCR and no release asset to download today. Until the first tag,
> build the image yourself from this checkout (`docker build -t honua-studio .`)
> and substitute that tag for the `ghcr.io/...` one below; everything else on
> this page applies unchanged, and the clean-machine path is what CI's
> container smoke runs on every pull request.

The same immutable assets run in every environment; deployment settings are read
from `/config.json` on each page load with `Cache-Control: no-store`.

Copy `deploy/config.example.json` to `config.json` and set the public server
URL and public OIDC client values. The file must not contain provider keys,
client secrets, admin tokens, or other credentials. `serverBaseUrl` is the
REST API root (commonly `/api`), while `mcpBaseUrl` is the separately
configured base for the unprefixed `/mcp` endpoint. In the supported
`server-proxy` model mode, the server owns model-provider credentials.
Client-direct model transport is not supported by this contract version.

`$VERSION` below is the release tag, for example `v2026.1.1`; until the first
tag is cut, set `IMAGE=honua-studio` from a local `docker build` instead.

```sh
IMAGE="ghcr.io/honua-io/honua-studio:$VERSION"
docker pull "$IMAGE"
docker run --read-only --tmpfs /var/cache/nginx:uid=101,gid=101 --tmpfs /var/run:uid=101,gid=101 \
  -p 8080:8080 \
  --mount type=bind,src="$PWD/config.json",dst=/usr/share/nginx/html/config.json,readonly \
  "$IMAGE"
curl --fail http://127.0.0.1:8080/config.json
```

Changing `config.json` and restarting the container repoints the same image;
no `npm` install or asset rebuild is involved. OIDC redirect URIs must include
the externally visible Studio URL. The server must allow that origin.

The tag release workflow runs checks and the full smoke suite
([`smoke-suite.yml`](../.github/workflows/smoke-suite.yml) — the same container,
browser and Blazor-host smokes CI runs on every pull request), then builds a
reproducible static archive, pushes the version-only GHCR tag, and attaches the
archive, checksum, and a receipt binding version, source SHA, and image digest
to the GitHub release. Nothing is pushed unless all three smokes pass.

The clean-machine container/config smoke is available now. The credentialed
real-model composition/save/reopen smoke remains the final acceptance item and
will be wired after #40 supplies the live `StudioAgentSession` loop.
