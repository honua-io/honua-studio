# Self-hosted Studio

Studio is distributed as both a static tarball and
`ghcr.io/honua-io/honua-studio:<version>`. The same immutable assets run in
every environment; deployment settings are read from `/config.json` on each
page load with `Cache-Control: no-store`.

Copy `deploy/config.example.json` to `config.json` and set the public server
URL and public OIDC client values. The file must not contain provider keys,
client secrets, admin tokens, or other credentials. In `server-proxy` mode,
the server owns model-provider credentials. `client-direct` requires a model
base URL but still must not embed provider credentials.

```sh
docker pull ghcr.io/honua-io/honua-studio:v2026.1.1
docker run --read-only --tmpfs /var/cache/nginx:uid=101,gid=101 --tmpfs /var/run:uid=101,gid=101 \
  -p 8080:8080 \
  --mount type=bind,src="$PWD/config.json",dst=/usr/share/nginx/html/config.json,readonly \
  ghcr.io/honua-io/honua-studio:v2026.1.1
curl --fail http://127.0.0.1:8080/config.json
```

Changing `config.json` and restarting the container repoints the same image;
no `npm` install or asset rebuild is involved. OIDC redirect URIs must include
the externally visible Studio URL. The server must allow that origin.

The tag release workflow runs checks, builds a reproducible static archive,
pushes the version-only GHCR tag, and attaches the archive, checksum, and a
receipt binding version, source SHA, and image digest to the GitHub release.

The clean-machine container/config smoke is available now. The credentialed
real-model composition/save/reopen smoke remains the final acceptance item and
will be wired after #40 supplies the live `StudioAgentSession` loop.
