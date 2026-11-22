/**
 * Ensures the verification cohort has one anonymous polygon layer the authoring
 * journey can open. A fresh cohort ships with no FeatureServer layer, so the
 * non-coder journey cannot start until this seed exists. Re-running keeps the
 * same table and service.
 */
const TABLE = "studio_journey_212";
const SERVICE = "studio-journey";
const LAYER = "studio-journey-212";

export async function ensureCohortAuthorLayer({ baseUrl, apiKey }) {
  const root = baseUrl.replace(/\/api\/?$/, "").replace(/\/$/, "");
  const headers = { "x-api-key": apiKey, accept: "application/json" };
  const existing = await findLayer(root, headers);
  if (existing) {
    await allowAnonymousRead(root, headers);
    const count = await anonymousCount(root, existing.layerId);
    return { service: SERVICE, layerId: existing.layerId, count };
  }
  await importZones(root, headers);
  const column = await geometryColumn(root, headers);
  await publishLayer(root, headers, column);
  const created = await findLayer(root, headers);
  if (!created) throw new Error(`Published ${LAYER} is not on ${SERVICE}.`);
  await allowAnonymousRead(root, headers);
  const count = await anonymousCount(root, created.layerId);
  if (count < 1) throw new Error(`Anonymous query of ${LAYER} returned no features.`);
  return { service: SERVICE, layerId: created.layerId, count };
}

async function findLayer(root, headers) {
  const response = await fetch(`${root}/rest/services/${SERVICE}/FeatureServer?f=json`, { headers });
  if (response.status === 499 || response.status === 401 || response.status === 404) return undefined;
  if (!response.ok) throw new Error(`FeatureServer ${SERVICE} returned ${response.status}.`);
  const body = await response.json();
  if (body.error) {
    const message = body.error.message ?? "";
    if (body.error.code === 404 || /not found/i.test(message)) return undefined;
    throw new Error(`FeatureServer ${SERVICE} was refused: ${message || "error"}`);
  }
  const layer = (body.layers ?? []).find((item) => item.name === LAYER);
  return layer ? { layerId: layer.id } : undefined;
}

async function importZones(root, headers) {
  const form = new FormData();
  form.set("file", new Blob([zonesGeoJson()], { type: "application/geo+json" }), "zones.geojson");
  form.set("tableName", TABLE);
  form.set("targetSrid", "4326");
  form.set("overwriteExisting", "true");
  const response = await fetch(`${root}/api/v1/admin/import/upload`, { method: "POST", headers, body: form });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(`Zone import failed (${response.status}): ${body.message ?? "no message"}`);
  }
}

async function geometryColumn(root, headers) {
  const connectionId = await connectionIdFor(root, headers);
  const response = await fetch(`${root}/api/v1/admin/connections/${connectionId}/tables`, { headers });
  const body = await readJson(response, "table discovery");
  const tables = body.data?.items ?? body.data?.tables ?? body.data ?? body.tables ?? [];
  const table = tables.find((item) => item.table === `imported_${TABLE}` || item.table === TABLE);
  if (!table?.geometryColumn) throw new Error(`Imported table ${TABLE} has no geometry column.`);
  return {
    connectionId,
    schema: table.schema,
    table: table.table,
    geometryColumn: table.geometryColumn,
    srid: table.srid,
  };
}

async function connectionIdFor(root, headers) {
  const response = await fetch(`${root}/api/v1/admin/connections`, { headers });
  const body = await readJson(response, "connections");
  const items = body.data?.items ?? body.data?.connections ?? body.data ?? [];
  const connection = items[0];
  const id = connection?.id ?? connection?.connectionId;
  if (!id) throw new Error("The cohort has no database connection to publish into.");
  return id;
}

async function publishLayer(root, headers, column) {
  const response = await fetch(`${root}/api/v1/admin/connections/${column.connectionId}/layers`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      schema: column.schema,
      table: column.table,
      layerName: LAYER,
      geometryColumn: column.geometryColumn,
      srid: column.srid,
      serviceName: SERVICE,
      license: "CC0-1.0",
      attribution: "Synthetic verification polygons",
      publisher: "Honua verification",
    }),
  });
  const body = await response.json();
  if (response.status === 409) return;
  if (!response.ok || body.success === false) {
    throw new Error(`Layer publish failed (${response.status}): ${body.message ?? "no message"}`);
  }
}

async function allowAnonymousRead(root, headers) {
  const response = await fetch(`${root}/api/v1/admin/services/${SERVICE}/access-policy`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ allowAnonymous: true, allowAnonymousWrite: false }),
  });
  if (!response.ok) throw new Error(`Anonymous read policy returned ${response.status}.`);
}

async function anonymousCount(root, layerId) {
  const response = await fetch(
    `${root}/rest/services/${SERVICE}/FeatureServer/${layerId}/query?where=1%3D1&returnCountOnly=true&f=json`,
  );
  if (!response.ok) throw new Error(`Anonymous feature query returned ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(`Anonymous feature query was refused: ${body.error.message ?? "error"}`);
  return body.count ?? 0;
}

async function readJson(response, label) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${body.message ?? "no message"}`);
  return body;
}

function zonesGeoJson() {
  const polygons = [
    [
      "R1",
      "north",
      [
        [-157.85, 21.3],
        [-157.84, 21.3],
        [-157.84, 21.31],
        [-157.85, 21.31],
        [-157.85, 21.3],
      ],
    ],
    [
      "C2",
      "south",
      [
        [-157.83, 21.28],
        [-157.82, 21.28],
        [-157.82, 21.29],
        [-157.83, 21.29],
        [-157.83, 21.28],
      ],
    ],
    [
      "R1",
      "east",
      [
        [-157.81, 21.3],
        [-157.8, 21.3],
        [-157.8, 21.31],
        [-157.81, 21.31],
        [-157.81, 21.3],
      ],
    ],
    [
      "I1",
      "west",
      [
        [-157.86, 21.29],
        [-157.855, 21.29],
        [-157.855, 21.295],
        [-157.86, 21.295],
        [-157.86, 21.29],
      ],
    ],
  ];
  return JSON.stringify({
    type: "FeatureCollection",
    features: polygons.map(([zoning_code, name, coordinates]) => ({
      type: "Feature",
      properties: { zoning_code, name },
      geometry: { type: "Polygon", coordinates: [coordinates] },
    })),
  });
}
