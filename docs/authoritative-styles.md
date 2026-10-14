# Authoritative styles

Studio reads the real `honua_get_style` catalog and requests the canonical
`mapbox-style` inline body. A style ID or title is never evidence that a map
satisfies a field or palette request. The provider records the server root,
integer revision, exact inline-body SHA256 and observation time, then binds the
style to an independently read `honua_describe_layer` response and its hash.
Legacy revision zero is valid in the server contract.

The initial runtime subset is fill, line and circle styles with exactly one
layer compatible with the discovered source geometry. Paint, layout, filter and
zoom limits apply to the existing composition layer and source; canonical style
layer IDs do not replace composition IDs. Referenced fields must exist in the
actual descriptor. Inline GeoJSON sources may appear in the canonical document,
but are never imported into the map. External sources, sprites, glyphs, imports
and image patterns are rejected. Legacy property functions and property-name
filters are unsupported; use expression syntax with explicit `get`/`has` field
references. Ambiguous or unavailable styles produce visible
unresolved layers rather than a certified fallback preset. Older host catalogs
without authoritative locators retain the existing fixture projection behavior.
Eligibility is per discovered Honua service identity: unrelated OGC and external
GeoServices sources in a mixed catalog retain their
existing preset projection, without authoritative observations or provenance.
Honua service sources still reject unknown or unverifiable styles visibly.

Discovery uses only the configured MCP endpoint, fresh session tokens, one 401
refresh and redirect refusal. It never follows advertised encoding URLs and
keeps no persistent or shared style cache. Session changes discard pending
results. Model context advertises at most ten supported definitions under an
eight-second discovery deadline, including their actual descriptions, revisions
and hashes. Definitions are catalog data, not model instructions.

`CompositionMapView.observeAuthoritativeStyles()` reads the actual MapLibre
style and rendered feature count. An external browser proof may supply those
observations through `runServerCorpus`'s `observeStyles` callback, together with
explicit `styleRequirements` naming the trusted server, source and requested
classification field or palette. The supplemental verifier recomputes both raw
hashes, binds the observation to the final composition, checks runtime source,
style metadata and applied properties, and requires rendered features. Field
classification must actually use the requested field as a match/step/interpolate
input with distinct outputs. Palette requirements name the requested paint
values; no palette is inferred from a style name.

The original strict fixture score is unchanged. Without actual runtime
observations and explicit requirements, style cases remain
`prerequisite-unmet`. This API does not create a renderer for the server-only
corpus or turn scripted calls into model-quality evidence. Real synthetic
style create/readback, rendered browser evidence and cleanup are still required
for issue86; release-candidate qualification remains a separate gate.

## Production browser corpus observer

Set `HONUA_CORPUS_STYLE_REQUIREMENTS` to a JSON file keyed by corpus task ID,
with each requirement naming `sourceId`, actual upstream `serverRoot`, a
user-readable `description`, and `classificationField` or explicit `palette`.
Use `HONUA_CORPUS_AUTH_MODULE` for the normal fresh host token callback and
`HONUA_CORPUS_SOURCES` for explicit host-catalog aliases. The observer verifies
those aliases against real discovered service/layer identities and uses the
actual discovered locator bytes. Build production first, then run the corpus
under the shared build lock. The style branch must include the authenticated
feature transport before real rendering can pass.

The CLI starts an actual production preview and browser, then replays each
independently read server composition through the public controller API. It
never installs source/style metadata overrides or intercepts routes. For cases
with an unspecified view it frames bounds derived from the actual bounded
EPSG:4326 GeoJSON feature response, recording the exact request, response hash
and diagnostic camera separately from untouched composition state. Unverified
CRS or missing real features cannot pass. The receipt records the explicit
preview-proxy to owned-upstream binding, production asset hashes, actual
requests, per-turn runtime observations and screenshots. Browser origin and
upstream server identity remain distinct.

Explicit visibility, active filters and opacity controls remain authoritative:
composition visibility overrides canonical visibility in both directions; control
filters are combined with canonical filters,
and control opacity multiplies canonical opacity. Derived polygon outlines use
the same effective filter, visibility and zoom limits. Evidence compares the effective rendered properties
while checking requested palette values against the canonical definition.

The browser observer also requires `HONUA_CORPUS_DEPLOYMENT_RECEIPT`, naming the current owned Docker deployment receipt. It retains its exact bytes and hash and independently verifies the running container, loopback port, image source label, and server binary hash before observation, per observed turn, and at shutdown. A changed deployment invalidates the proof. Both supported host source shapes (top-level service/layer fields and `locator`) must match actual discovery; runtime locator bytes always come from discovery.

Native receipts retain the `honua.owned-native-diagnostic.v1` schema and native
binary checks. A separate `honua.owned-managed-diagnostic.v1` receipt identifies
an explicitly synthetic `managed-jit` functional deployment. It requires
`releaseQualification: false`, `securityQualification: false`,
`nativeQualification: false` and an actual `health.status: 200` receipt; it has no
native binary identity and establishes no NativeAOT qualification. Keep its
endpoint, configuration and result directories separate from native runs.

Managed receipts bind the actual command
`/diagnostic-dotnet/dotnet exec /managed/Honua.Server.dll`, the assembly and
runtime configuration hashes, and the complete regular-file closure under
`/managed` and `/diagnostic-dotnet`. `closureFiles` maps absolute paths to SHA256
digests; `/diagnostic/managed-closure.sha256` contains the matching ordinary
checksum lines and has its own retained digest. The observer checks actual
container entrypoint/arguments, source and image identity, loopback binding,
file inventory and every file hash on each revalidation. Extra or missing
files, symlinks, unsafe paths and changed receipts fail. Each complete checksum
command has a 60-second bound; container metadata reads retain a 10-second bound.
Inspection never reads container environment credentials. Strict and semantic
scoring are identical for both execution kinds.

When managed and native diagnostics share owned synthetic style data, retain
those styles until both consumers finish. Each proof removes only its own
uniquely created drafts; it does not remove another diagnostic's fixtures.

Canonical MapLibre `name` and `metadata["honua:description"]` may supply explicit author-written display context when server catalog descriptions are unavailable. These values are bound to the retained stylesheet hash, never inferred from style identifiers.

Map views reuse successful bindings for up to 30 seconds while the exact style/source descriptor/session tuple remains unchanged. Selection and appearance changes reuse these bindings; changes to the tuple or a subsequent update after expiry revalidate against the server. Bindings are memory-only, pruned when layers disappear and cleared on disposal or session replacement. There is no persistent stylesheet cache.

`CompositionMapView.refreshAuthoritativeStyles()` explicitly revalidates unchanged style identities and server revisions. The actual browser proof observer calls it before every observed turn, bypassing the interaction cache.
