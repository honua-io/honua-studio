# Browser Studio release posture

Browser Studio ships as a **Preview** in 2026.1. It is an optional
self-hosted/BYOM client of the Honua server, not a GA product and not part of
the terminal compose/save/govern critical path. A hosted Studio deployment is
not a 2026.1 requirement.

## 2026.1 Preview gates

A `v*` tag publishes only when every gate below passed for that same
`github.sha`. A missing, skipped, or red gate blocks publication.
`workflow_dispatch` must be started from the tag it names
(`gh workflow run release.yml --ref vX.Y.Z -f version=vX.Y.Z`); the release
job refuses any other revision.

- **Packaging integrity.** `release.yml` builds the versioned static archive
  and the container from the smoked revision. `@honua/studio` depends on an
  exact published `@honua/sdk-js` version (`package.json`), not a range.
  The receipt records the version, source SHA, and pushed image digest.
  No `v*` tag has been cut, so nothing is pullable from GHCR yet.
- **Security.** The tag workflow runs filesystem Trivy and OpenSSF Scorecard
  from pinned `honua-io/.github` workflows and `needs` both before publish.
  `security.yml` uses the same pins on pull requests; it does not run on tags,
  which is why the release workflow repeats them. Published assets and
  `deploy/config.example.json` contain no provider key, administrator
  credential, OIDC client secret, or demo credential. Operators inject
  `/config.json` at start.
- **Runtime configuration.** The clean-machine container smoke, and the same
  checks against the image about to be pushed, start nginx read-only as uid
  101, mount an injected `config.json`, and require
  `schemaVersion == honua.studio.runtime-config.v1` plus a deep SPA fallback.
  Both curls use `--retry-all-errors` so a transient startup reset is retried.
  A wrong schema or a missing shell still fails the gate. The tag that is
  pushed is that verified image, not a later rebuild.
- **In-repo server and embed smokes.** The required smoke suite runs the
  browser journeys and the Blazor host smoke. They exercise the supported
  projection against the in-repo server contract and the embed host.
  Deterministic fixture state is enough. Hosted-demo access and a real model
  are not required, and this gate does not call `demo.honua.io`.

The nightly live lane (`.github/workflows/live-demo-smoke.yml`) is not a
Preview publish gate. It keeps concurrency group `live-aws-studio-browser-smoke`
so a release does not run a second writer against that shared demo. Hosted
proof stays behind 2026.1 decision D2.

## Cutting a release

Releases are semver tags `vX.Y.Z`, cut by Release Please
(`.github/workflows/release-please.yml`, `release-please-config.json`,
`.release-please-manifest.json`).

1. Every push to `main` updates one release pull request,
   `chore(main): release X.Y.Z` on branch
   `release-please--branches--main--components--studio`. It bumps
   `package.json`, `package-lock.json`, the manifest and `CHANGELOG.md` from the
   conventional commits since the last tag. The honua-io-bot App opens it so
   the required checks run, and the `PR Issue Disposition` check exempts
   exactly that author, branch and title.
2. Merging it starts a run that tags the merge commit and creates the GitHub
   release. That tag is created with `GITHUB_TOKEN`, which starts no
   workflow, so the run then dispatches
   `gh workflow run release.yml --ref vX.Y.Z -f version=vX.Y.Z`. The gates
   above run on that tag.

Versioning starts from the `0.0.0` that `package.json` reports, which
release-please treats as "never released". `initial-version` makes the first
release `v0.1.0`, not release-please's default `v1.0.0`. While the major is
`0`, `bump-minor-pre-major` turns a breaking change into a minor bump, so it
never jumps to `1.0.0`. `bump-patch-for-minor-pre-major: false` keeps a
`feat` as a minor bump; a `fix` is a patch. Leaving `0.x` is a deliberate
`Release-As: 1.0.0` commit.

Each release attaches:

- `honua-studio-vX.Y.Z.tar.gz`, the standalone static bundle (`dist`), and
  its `.sha256`;
- `honua-studio-console-assets-vX.Y.Z.tar.gz`, the Console bundle
  (`dist-console`, with the pinned embedded Maputnik), and its `.sha256`;
- `honua-studio-vX.Y.Z.receipt.json`, binding the version, source SHA and
  image digest.

Both tarballs carry a GitHub build-provenance attestation. Check one with
`gh attestation verify honua-studio-console-assets-vX.Y.Z.tar.gz --repo honua-io/honua-studio`.
The image `ghcr.io/honua-io/honua-studio:vX.Y.Z` is pushed alongside.

## 2026.2 graduation checklist

Graduating browser Studio from Preview requires the broader product proof that
does not gate 2026.1:

- complete browser composition and lifecycle qualification for map and
  dashboard families against canonical server-owned drafts and versions;
- owner/RBAC, generation-conflict, audit/correlation, and proposal
  separation-of-duties parity with the terminal client;
- real browser-model execution that selects tools, mutates a live server draft,
  saves an immutable version, survives restart, and reopens exact content;
- complete propose/poll/human-approval/final-link user experience;
- standalone/embedded parity and package round trips with Console, followed by
  parity-gated retirement of the superseded Console editors;
- versioned release receipts binding the Studio, server, SDK, model, and tool
  inventory revisions used for that qualification.

Preview evidence must be described as Preview evidence. Fixture or checkpoint
reconciliation must not be represented as model execution.
