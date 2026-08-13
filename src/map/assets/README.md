# Vendored map assets (honua-studio#23 REQ-003)

Everything the composition map needs to draw a recognisable world must be
**in this repository**. honua-studio#23 REQ-003 is explicit: *no runtime CDN
dependency*. honua-console has the opposite bug today (honua-console#333) —
a MapLibre surface that silently fails, or silently phones home, when the
network is unavailable. Studio must not repeat it.

Practically that means three things, and all three are satisfied here:

| Asset | How it is vendored |
| --- | --- |
| MapLibre GL JS | `maplibre-gl` is a **pinned exact** npm dependency (no `^`), bundled by Vite. Its web worker is inlined by MapLibre itself as a blob URL — no separate worker file is fetched. |
| MapLibre GL CSS | Imported as `maplibre-gl/dist/maplibre-gl.css?inline` and injected into the canvas element's shadow root as a string. Never a `<link>` to a CDN. |
| Basemap geometry | `natural-earth-land-110m.json` (this directory), imported as a JSON module. |

## `natural-earth-land-110m.json`

- **Source:** Natural Earth 1:110m *physical / land* (`ne_110m_land`), via
  <https://github.com/martynafford/natural-earth-geojson>.
- **Licence:** Natural Earth is in the **public domain**. No permission is
  required and no attribution is legally mandated; we credit it anyway in
  the basemap's MapLibre `attribution` string (see `../basemap.ts`), because
  the map control shows attribution and crediting the data is right.
- **Processing:** the 127 source features were merged into a single
  `MultiPolygon` feature, coordinates rounded to 3 decimal places (~110 m),
  and consecutive duplicate vertices dropped. 237 KB → 86 KB with no visible
  change at the zoom levels a 1:110m dataset is legible at.
- **What it is *not*:** production cartography. 1:110m is a *world reference*
  basemap — coastlines are generalised and there are no roads, labels, or
  imagery. It exists so the composition surface is a real, oriented map with
  zero network calls. A deployment that wants real cartography points
  `<honua-studio-canvas>.basemapStyle` (or the `basemap-style-url` attribute)
  at its own style/tile server; see `../basemap.ts`.

## Re-vendoring

```sh
curl -sL -o /tmp/ne_110m_land.json \
  https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json
node scripts/vendor-basemap-land.mjs /tmp/ne_110m_land.json
```

`scripts/vendor-basemap-land.mjs` performs exactly the merge/round/dedupe
described above and rewrites this file deterministically, so re-vendoring is
reproducible rather than a remembered sequence of one-off edits.
