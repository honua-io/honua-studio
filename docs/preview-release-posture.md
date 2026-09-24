# Browser Studio release posture

Browser Studio ships as a **Preview** in 2026.1. It is an optional
self-hosted/BYOM client of the GA Honua server, not part of the terminal
compose/save/govern critical path.

## 2026.1 Preview gates

A 2026.1 browser Studio candidate is releasable when all of these are true:

- packaging integrity: the versioned static bundle and container are built
  from the candidate, and the private `@honua/studio` package resolves its
  exact published SDK dependency;
- security: repository security workflows pass and no provider, administrator,
  OIDC client secret, or demo credential is embedded in the assets or image;
- runtime configuration: server, OIDC, and model-transport settings can be
  injected at startup without rebuilding the static assets;
- GA-server smoke: the built browser client boots against the GA server and
  exercises its supported server-backed projection. Deterministic credentials
  may be supplied by the smoke environment; hosted-demo or real-model access is
  not required.

The clean-machine container/runtime-configuration job is a required Preview
gate. A candidate is not qualified when that job is absent, skipped, allowed to
fail, or red.

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
  inventory revisions used for qualification.

Preview evidence must be described as Preview evidence. Fixture or checkpoint
reconciliation must not be represented as model execution.
