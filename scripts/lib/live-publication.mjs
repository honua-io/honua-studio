export function liveMapBody(packageKey, extra = {}) {
  return {
    mapPackageId: packageKey,
    format: "honua_map_package.v1",
    status: "Draft",
    createdAt: new Date().toISOString(),
    initialView: { bbox: [-160.6, 18.7, -154.5, 22.5], crs: "EPSG:4326" },
    layers: [],
    widgets: [],
    view: { center: [-157.55, 20.6], zoom: 6 },
    ...extra,
  };
}
