// Convert between v2 features and GeoJSON FeatureCollections.
//
// This is BOTH the editor's internal wire format and the exported
// `network.geojson`, so it is a second public artifact — hence the
// format/format_version properties on the collection (V2_PLAN.md V7): a
// downstream consumer can tell what it is holding.
//
// Geometry always travels WITH its feature; nothing is keyed by name, so
// duplicate names are harmless. A v2 feature's geometry is a list of PARTS,
// which maps onto GeoJSON as:
//
//   one line part          -> LineString
//   several line parts     -> MultiLineString
//   one point part         -> Point
//   several point parts    -> MultiPoint
//   a mix of both          -> GeometryCollection
//
// The mixed case is why this isn't just "LineString or Point": a row of street
// trees that is partly individual trees and partly a continuous run is ONE
// feature, and splitting it here would undo the whole reason features and
// spots were unified.
import { FORMAT_ID, FORMAT_VERSION, makeFeature, makeTreatment }
  from "./network_format.js";

const toLonLat = (part) => part.map(([lat, lon]) => [lon, lat]);
const toLatLon = (coords) => coords.map(([lon, lat]) => [lat, lon]);

export function geojsonGeometry(parts) {
  const lines = parts.filter((p) => p.length >= 2);
  const points = parts.filter((p) => p.length === 1);
  const lineGeom = lines.length === 1
    ? { type: "LineString", coordinates: toLonLat(lines[0]) }
    : { type: "MultiLineString", coordinates: lines.map(toLonLat) };
  const pointGeom = points.length === 1
    ? { type: "Point", coordinates: toLonLat(points[0])[0] }
    : { type: "MultiPoint", coordinates: points.map((p) => toLonLat(p)[0]) };

  if (lines.length && points.length) {
    return { type: "GeometryCollection", geometries: [lineGeom, pointGeom] };
  }
  if (lines.length) return lineGeom;
  if (points.length) return pointGeom;
  return null;
}

export function partsFromGeojson(geom) {
  if (!geom) return [];
  const { type, coordinates } = geom;
  switch (type) {
    case "LineString":
      return coordinates.length >= 2 ? [toLatLon(coordinates)] : [];
    case "MultiLineString":
      return coordinates.filter((c) => c.length >= 2).map(toLatLon);
    case "Point":
      return [[[coordinates[1], coordinates[0]]]];
    case "MultiPoint":
      return coordinates.map(([lon, lat]) => [[lat, lon]]);
    case "GeometryCollection":
      return (geom.geometries || []).flatMap(partsFromGeojson);
    default:
      return [];
  }
}

function treatmentProps(t) {
  const out = { id: t.id, type: t.type, status: t.status };
  if (t.phase) out.phase = t.phase;
  if (t.authority) out.authority = t.authority;
  if (t.travel !== "two_way") out.travel = t.travel;
  if (t.sides !== 2) out.sides = t.sides;
  if (t.side) out.side = t.side;
  if (t.quantity !== null && t.quantity !== undefined) out.quantity = t.quantity;
  if (t.upgrades && t.upgrades.length) out.upgrades = [...t.upgrades];
  if (t.proposed_by) out.proposed_by = t.proposed_by;
  if (t.notes) out.notes = t.notes;
  if (t.tags && Object.keys(t.tags).length) out.tags = { ...t.tags };
  return out;
}

// One GeoJSON feature per network feature. Treatments ride along as a nested
// property array rather than being flattened into one feature per treatment:
// flattening would duplicate the geometry, which is precisely what unifying
// features and treatments was meant to stop.
export function featuresToGeojson(features) {
  const out = [];
  for (const f of features || []) {
    const geometry = geojsonGeometry(f.geometry.filter((p) => p.length));
    if (!geometry) continue;
    out.push({
      type: "Feature",
      geometry,
      properties: {
        id: f.id,
        name: f.name,
        on_street: f.on_street,
        start: f.start,
        end: f.end,
        notes: f.notes,
        treatments: f.treatments.map(treatmentProps),
        ...(Object.keys(f.tags || {}).length ? { tags: { ...f.tags } } : {}),
        ...(f.length_km ? { km: Math.round(f.length_km * 1e4) / 1e4 } : {}),
      },
    });
  }
  return {
    type: "FeatureCollection",
    format: FORMAT_ID,
    format_version: FORMAT_VERSION,
    features: out,
  };
}

export function featuresFromGeojson(fc) {
  const out = [];
  for (const gf of (fc && fc.features) || []) {
    const parts = partsFromGeojson(gf.geometry);
    if (!parts.length) continue;
    const props = gf.properties || {};
    const treatments = (Array.isArray(props.treatments) ? props.treatments : [])
      .map((t) => makeTreatment({
        ...t,
        phase: t.phase || null,
        upgrades: Array.isArray(t.upgrades) ? [...t.upgrades] : [],
        quantity: (t.quantity === null || t.quantity === undefined)
          ? null : Number(t.quantity),
        tags: t.tags ? { ...t.tags } : {},
      }));
    out.push(makeFeature({
      id: props.id || "",
      name: props.name || "",
      on_street: props.on_street || "",
      start: props.start || "",
      end: props.end || "",
      notes: props.notes || "",
      treatments,
      geometry: parts,
      tags: props.tags ? { ...props.tags } : {},
    }));
  }
  return out;
}
