/**
 * Re-vendors `src/map/assets/natural-earth-land-110m.json` from a freshly
 * downloaded Natural Earth 1:110m land GeoJSON (honua-studio#23 REQ-003).
 *
 * The vendored asset is a build INPUT that ships in the bundle, so how it was
 * produced has to be reproducible rather than remembered — run this script,
 * not a sequence of ad-hoc edits. See src/map/assets/README.md for the source
 * URL and licence.
 *
 * Usage: node scripts/vendor-basemap-land.mjs <path-to-ne_110m_land.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Coordinate precision, in decimal degrees places. 3 ≈ 110 m — well below what a 1:110m dataset resolves. */
const PRECISION = 3;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "src", "map", "assets", "natural-earth-land-110m.json");

const inputPath = process.argv[2];
if (!inputPath) {
  process.stderr.write("usage: node scripts/vendor-basemap-land.mjs <path-to-ne_110m_land.json>\n");
  process.exit(2);
}

/** Rounds one position and drops it when it repeats the previous one. */
function quantizeRing(ring) {
  const out = [];
  for (const position of ring) {
    const rounded = [Number(position[0].toFixed(PRECISION)), Number(position[1].toFixed(PRECISION))];
    const previous = out[out.length - 1];
    if (previous && previous[0] === rounded[0] && previous[1] === rounded[1]) continue;
    out.push(rounded);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length >= 4 && first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push([...first]);
  return out.length >= 4 ? out : undefined;
}

const source = JSON.parse(readFileSync(inputPath, "utf8"));
const polygons = [];
for (const feature of source.features) {
  const geometry = feature.geometry;
  const parts = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  for (const polygon of parts) {
    const rings = [];
    for (const [index, ring] of polygon.entries()) {
      const quantized = quantizeRing(ring);
      // An exterior ring that collapses takes its holes with it; a collapsed
      // hole is simply dropped.
      if (!quantized && index === 0) break;
      if (quantized) rings.push(quantized);
    }
    if (rings.length > 0) polygons.push(rings);
  }
}

const output = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: polygons } }],
};

writeFileSync(outputPath, JSON.stringify(output));
process.stdout.write(
  `[honua-studio] vendored ${polygons.length} land polygons -> ${path.relative(projectRoot, outputPath)}\n`,
);
