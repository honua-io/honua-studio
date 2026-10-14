/** Bounds from an actual bounded RFC7946 response, never descriptor metadata. */
export function observedGeoJsonBounds(collection) {
  if (
    collection?.type !== "FeatureCollection" ||
    !Array.isArray(collection.features) ||
    collection.features.length > 2000 ||
    collection.crs !== undefined
  )
    throw new Error("Expected a bounded RFC7946 FeatureCollection without alternate CRS.");
  const bounds = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  let positions = 0;
  const coordinates = (value, depth = 0) => {
    if (depth > 8 || !Array.isArray(value)) throw new Error("Invalid bounded GeoJSON coordinates.");
    if (typeof value[0] === "number") {
      const [x, y] = value;
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90 || ++positions > 100000)
        throw new Error("Observed coordinates are not bounded longitude/latitude.");
      bounds[0] = Math.min(bounds[0], x);
      bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x);
      bounds[3] = Math.max(bounds[3], y);
    } else for (const child of value) coordinates(child, depth + 1);
  };
  const geometry = (value, depth = 0) => {
    if (!value) return;
    if (depth > 8) throw new Error("Geometry collection nesting exceeded the bound.");
    if (value.type === "GeometryCollection" && Array.isArray(value.geometries)) {
      for (const child of value.geometries) geometry(child, depth + 1);
    } else if (["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(value.type))
      coordinates(value.coordinates);
    else throw new Error("Unsupported observed GeoJSON geometry.");
  };
  for (const feature of collection.features) {
    if (feature?.type !== "Feature") throw new Error("Invalid GeoJSON feature.");
    geometry(feature.geometry);
  }
  if (positions === 0) throw new Error("No observed positions are available for diagnostic framing.");
  return bounds;
}
