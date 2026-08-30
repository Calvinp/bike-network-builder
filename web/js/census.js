// Looking up an area's boundary by NAME, so that adding Medford is a click
// rather than a scavenger hunt for a GeoJSON file.
//
// Source: the US Census TIGERweb ArcGIS REST service, which is public, sends
// CORS headers, and is the authority for exactly the units people mean when
// they say "the next town over". This is the only outbound call the editor
// makes, and it happens ONLY when the user opens the area picker or asks to
// add a town — never on load, never per-tile. (Contrast the roads graph, which
// is served as static tiles precisely because it WOULD be per-tile; see
// AGENTS.md. Static files can't be DDoSed by your own users.)
//
// Nothing here is required for the editor to work: no network, no picker, and
// uploading a .geojson still covers "our advocacy area is these six
// neighbourhoods", which no registry anywhere will ever have.

const BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb"
  + "/Places_CouSub_ConCity_SubMCD/MapServer";

// The CURRENT vintage's layers. Later groups in the same service are older
// vintages; ids 1 and 4 are the live ones.
const LAYER_COUSUB = 1;      // County Subdivisions — towns/cities in New England
const LAYER_PLACE = 4;       // Incorporated Places — cities elsewhere

// A municipal boundary is worth ~3 m of precision: a 10 m tolerance can move a
// border street to the wrong side of the line, and this outline decides what
// gets clipped. 427 points becomes 128; 17 KB becomes 3 KB.
const SIMPLIFY_DEG = 0.00003;

// FIPS -> [abbreviation, full name]. The abbreviation is what a picker row has
// room for; the full name is what `context` holds, because that is what
// place.json already writes and an area's context should not depend on whether
// it was typed by hand or fetched.
const STATES = {
  "01": ["AL", "Alabama"], "02": ["AK", "Alaska"], "04": ["AZ", "Arizona"],
  "05": ["AR", "Arkansas"], "06": ["CA", "California"], "08": ["CO", "Colorado"],
  "09": ["CT", "Connecticut"], 10: ["DE", "Delaware"],
  11: ["DC", "District of Columbia"], 12: ["FL", "Florida"], 13: ["GA", "Georgia"],
  15: ["HI", "Hawaii"], 16: ["ID", "Idaho"], 17: ["IL", "Illinois"],
  18: ["IN", "Indiana"], 19: ["IA", "Iowa"], 20: ["KS", "Kansas"],
  21: ["KY", "Kentucky"], 22: ["LA", "Louisiana"], 23: ["ME", "Maine"],
  24: ["MD", "Maryland"], 25: ["MA", "Massachusetts"], 26: ["MI", "Michigan"],
  27: ["MN", "Minnesota"], 28: ["MS", "Mississippi"], 29: ["MO", "Missouri"],
  30: ["MT", "Montana"], 31: ["NE", "Nebraska"], 32: ["NV", "Nevada"],
  33: ["NH", "New Hampshire"], 34: ["NJ", "New Jersey"], 35: ["NM", "New Mexico"],
  36: ["NY", "New York"], 37: ["NC", "North Carolina"], 38: ["ND", "North Dakota"],
  39: ["OH", "Ohio"], 40: ["OK", "Oklahoma"], 41: ["OR", "Oregon"],
  42: ["PA", "Pennsylvania"], 44: ["RI", "Rhode Island"],
  45: ["SC", "South Carolina"], 46: ["SD", "South Dakota"], 47: ["TN", "Tennessee"],
  48: ["TX", "Texas"], 49: ["UT", "Utah"], 50: ["VT", "Vermont"],
  51: ["VA", "Virginia"], 53: ["WA", "Washington"], 54: ["WV", "West Virginia"],
  55: ["WI", "Wisconsin"], 56: ["WY", "Wyoming"], 60: ["AS", "American Samoa"],
  66: ["GU", "Guam"], 69: ["MP", "Northern Mariana Islands"],
  72: ["PR", "Puerto Rico"], 78: ["VI", "U.S. Virgin Islands"],
};
const stateRow = (fips) => STATES[String(fips).padStart(2, "0")] || ["", ""];
export const stateAbbr = (fips) => stateRow(fips)[0];
export const stateName = (fips) => stateRow(fips)[1];

// "Medford city" / "Saugus town" / "Yarmouth CDP" are the Census's names, not
// anyone else's. BASENAME is the bare one, and the suffix is worth keeping as
// a KIND so the picker can say what it is offering.
const SUFFIX = /\s+(city|town|village|borough|township|CDP|CCD|municipality|county)$/i;
export function tidyName(attrs) {
  const full = String(attrs.NAME || "");
  const base = String(attrs.BASENAME || full).trim();
  const m = full.match(SUFFIX);
  return { name: base, kind: m ? m[1].toLowerCase() : "" };
}

function rowsToAreas(rows, layer) {
  return (rows || []).map((r) => {
    const a = r.attributes || r.properties || {};
    const { name, kind } = tidyName(a);
    return {
      geoid: String(a.GEOID || ""), name, kind, layer,
      state: stateAbbr(a.STATE), stateName: stateName(a.STATE),
    };
  }).filter((a) => a.geoid && a.name);
}

// A county subdivision and an incorporated place of the same name are the same
// town twice. Prefer the SUBDIVISION — in New England that is the governmental
// unit and the place is the shadow — except where the subdivision is a "CCD",
// which is a statistical division the Census invented for states that have no
// real ones, and which nobody builds bike lanes for.
function dedupe(areas) {
  const best = new Map();
  for (const a of areas) {
    const key = `${a.name}|${a.state}`;
    const prev = best.get(key);
    if (!prev) { best.set(key, a); continue; }
    const prefer = (x) => (x.kind === "ccd" ? 0
      : x.layer === LAYER_COUSUB ? 2 : 1);   // tidyName lowercases kind
    if (prefer(a) > prefer(prev)) best.set(key, a);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// One query against one layer. `fetchImpl` is injectable so this is testable
// without a network, and so a caller can impose its own timeout.
async function query(layer, params, { fetchImpl = fetch, signal } = {}) {
  const url = `${BASE}/${layer}/query?` + new URLSearchParams({
    f: "json", outFields: "NAME,BASENAME,GEOID,STATE", returnGeometry: "false",
    ...params,
  });
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`Census service returned ${res.status}`);
  const doc = await res.json();
  if (doc.error) throw new Error(doc.error.message || "Census service error");
  return rowsToAreas(doc.features, layer);
}

// The areas touching a bounding box — "the towns next to you", which is what
// somebody adding a second area almost always wants.
export async function nearbyAreas(bbox, opts = {}) {
  const [south, west, north, east] = bbox;
  const geometry = JSON.stringify({
    xmin: west, ymin: south, xmax: east, ymax: north,
    spatialReference: { wkid: 4326 },
  });
  const params = {
    geometry, geometryType: "esriGeometryEnvelope", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", resultRecordCount: "40",
  };
  const [subs, places] = await Promise.all([
    query(LAYER_COUSUB, params, opts),
    query(LAYER_PLACE, params, opts).catch(() => []),
  ]);
  return dedupe([...subs, ...places]);
}

// Free-text search, nationwide. Matches from the start of the name, which is
// how people type ("medf" -> Medford) and keeps the result list short.
export async function searchAreas(text, opts = {}) {
  const preferState = opts.preferState || "";
  const q = String(text || "").trim().replace(/'/g, "''");
  if (q.length < 2) return [];
  const params = {
    where: `UPPER(BASENAME) LIKE '${q.toUpperCase()}%'`,
    resultRecordCount: "40",
  };
  const [subs, places] = await Promise.all([
    query(LAYER_COUSUB, params, opts).catch(() => []),
    query(LAYER_PLACE, params, opts).catch(() => []),
  ]);
  const all = dedupe([...subs, ...places]);
  // There is a Somerville in five states. Someone working on Malden who types
  // "Somerville" means the one next door, so the state they are already in
  // outranks everything; an exact name match comes next.
  const exact = q.toUpperCase();
  const rank = (x) => (x.state === preferState ? 2 : 0)
    + (x.name.toUpperCase() === exact ? 1 : 0);
  return all.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name))
    .slice(0, 25);
}

// GeoJSON is [lon, lat]; every boundary in this codebase is [lat, lon]. Getting
// this backwards puts Massachusetts in the Indian Ocean, so it happens here,
// once, at the edge.
export function toBoundary(geometry) {
  if (!geometry) return [];
  const ring = (r) => r.map(([lon, lat]) => [lat, lon]);
  if (geometry.type === "Polygon") return [geometry.coordinates.map(ring)];
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((poly) => poly.map(ring));
  }
  return [];
}

// The boundary of one area, as a [lat, lon] multipolygon.
export async function areaBoundary(area, { fetchImpl = fetch, signal } = {}) {
  const url = `${BASE}/${area.layer}/query?` + new URLSearchParams({
    f: "geojson", where: `GEOID='${area.geoid}'`, outFields: "GEOID",
    returnGeometry: "true", outSR: "4326",
    maxAllowableOffset: String(SIMPLIFY_DEG),
  });
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`Census service returned ${res.status}`);
  const doc = await res.json();
  if (doc.error) throw new Error(doc.error.message || "Census service error");
  const feat = (doc.features || [])[0];
  return feat ? toBoundary(feat.geometry) : [];
}

// Which area contains a point — used to name the town a drawn line ran into,
// so the notice can offer "Add Medford" rather than "add an area".
export async function areaAt(lat, lon, opts = {}) {
  const params = {
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", resultRecordCount: "4",
  };
  const found = dedupe(await query(LAYER_COUSUB, params, opts));
  return found[0] || null;
}

// A stable id for an area that came from the Census, so the same town added
// twice is recognised as the same town — and so full resolution stays
// re-fetchable later (V2_PLAN.md §5).
export const censusId = (area) => `census:${area.geoid}`;
