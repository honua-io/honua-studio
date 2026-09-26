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
