// Convert between path lists and GeoJSON FeatureCollections — port of
// bikenetwork/geojson.py. Geometry always travels WITH its path — nothing here
// is keyed by name, so duplicate names are harmless. Single-segment paths are
// LineStrings; combined paths are MultiLineStrings.
import { segmentsMiles } from "./geometry.js";
import { makePath } from "./network_format.js";

function geojsonGeometry(segments) {
  const coords = segments.map((seg) => seg.map(([lat, lon]) => [lon, lat]));
  if (coords.length === 1) return { type: "LineString", coordinates: coords[0] };
  return { type: "MultiLineString", coordinates: coords };
}

function segmentsFromGeometry(geom) {
  const gtype = (geom || {}).type;
  const coords = (geom || {}).coordinates || [];
  let segLists;
  if (gtype === "MultiLineString") segLists = coords;
  else if (gtype === "LineString") segLists = [coords];
  else return [];
  const segments = [];
  for (const seg of segLists) {
    const pts = seg.map(([lon, lat]) => [lat, lon]);
    if (pts.length >= 2) segments.push(pts);
  }
  return segments;
}

// Build a GeoJSON FeatureCollection (one feature per path).
export function pathsToGeojson(paths) {
  const features = [];
  for (const p of paths) {
    const segments = p.segments.filter((s) => s.length >= 2);
    if (!segments.length) continue;
    features.push({
      type: "Feature",
      geometry: geojsonGeometry(segments),
      properties: {
        name: p.name,
        type: p.type,
        status: p.status,
        jurisdiction: p.jurisdiction,
        phase: p.phase,
        directions: p.directions,
        on_street: p.on_street,
        from: p.from,
        to: p.to,
        notes: p.notes,
        miles: Math.round((p.length_miles || segmentsMiles(segments)) * 1e4) / 1e4,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

// Build path objects from a FeatureCollection whose features carry the full
// property set (the editor's save payload). LineString and MultiLineString
// both work; features with no usable segment are skipped.
export function pathsFromGeojson(fc) {
  const paths = [];
  (fc.features || []).forEach((feat, i) => {
    const props = feat.properties || {};
    const segments = segmentsFromGeometry(feat.geometry);
    if (!segments.length) return;
    let phase = null;
    if (props.phase !== null && props.phase !== undefined) {
      const n = parseInt(props.phase, 10);
      phase = Number.isNaN(n) ? null : n;
    }
    let directions = parseInt(props.directions ?? 2, 10);
    if (Number.isNaN(directions) || !directions) directions = 2;
    const p = makePath({
      name: String(props.name || `Path ${i + 1}`),
      // `treatment` is the pre-split property name; accept it on read.
      type: String(props.type || props.treatment || "quick_build_separated"),
      status: String(props.status || "proposed"),
      jurisdiction: String(props.jurisdiction || "city"),
      phase,
      directions,
      on_street: String(props.on_street || ""),
      from: String(props.from || ""),
      to: String(props.to || ""),
      notes: String(props.notes || ""),
      segments,
    });
    p.length_miles = segmentsMiles(segments);
    paths.push(p);
  });
  return paths;
}
