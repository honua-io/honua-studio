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
and image patterns are rejected. Ambiguous or unavailable styles produce visible
unresolved layers rather than a certified fallback preset. Older host catalogs
without authoritative locators retain the existing fixture projection behavior.

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
