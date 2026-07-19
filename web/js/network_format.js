// The shared bike-network YAML format (`network.yaml`) — port of
// bikenetwork/network_format.py (the canonical Python copy). Keep the two in
// step: same defaults, same leniency, same validation messages. Paths and
// networks are plain objects (see makePath / makeNetwork for the fields).
import * as yamlMod from "../vendor/js-yaml.mjs";

const YAML = yamlMod.default ?? yamlMod;

export const FORMAT_ID = "malden-bike-network";
export const FORMAT_VERSION = 1;

export const PATH_TYPES = [
  "quick_build_separated",  // flex posts / paint / precast curb — cheap, fast
  "concrete_separated",     // permanent raised/concrete-protected lane
  "shared_use_path",        // off-street path (e.g. trail spur)
  "buffered_painted",       // painted + buffer (interim only)
  "neighborway",            // traffic-calmed shared street
];

export const STATUSES = ["proposed", "funded", "existing"];
export const JURISDICTIONS = ["city", "state"];

export function makePhase(number, label = "", deadline = "") {
  return { number, label, deadline };
}

export function makePath(over = {}) {
  return {
    name: "",
    type: "quick_build_separated",
    status: "proposed",
    jurisdiction: "city",
    phase: null,           // required for proposed; null for existing/funded
    directions: 2,         // 2 = one facility each way; 1 = one-way
    on_street: "",
    from: "",
    to: "",
    notes: "",
    segments: [],          // [[[lat, lon], ...], ...] — 1+ polylines
    length_miles: 0.0,     // derived; never serialized
    ...over,
  };
}

export function makeNetwork(over = {}) {
  return {
    city: "Malden",
    state: "Massachusetts",
    ordinance_chapter: "",
    phases: [],
    paths: [],
    format_id: FORMAT_ID,
    format_version: FORMAT_VERSION,
    ...over,
  };
}

export function phaseMap(net) {
  return new Map(net.phases.map((p) => [p.number, p]));
}

/* ------------------------------- Parsing -------------------------------- */

function toInt(value, dflt = null) {
  if (typeof value === "boolean") return dflt;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    return parseInt(value, 10);
  }
  return dflt;
}

const str = (v, dflt = "") => String((v ?? dflt) || dflt);

// Normalize the YAML `geometry` value into a list of segments. A flat list of
// [lat, lon] pairs is one segment; a list of such lists is several. Malformed
// points become null so validation can point at them.
function parseSegments(rawGeom) {
  const isList = Array.isArray;
  let segLists;
  if (isList(rawGeom) && rawGeom.length
      && rawGeom.every((el) => isList(el) && el.length && isList(el[0]))) {
    segLists = rawGeom;             // nested: several segments
  } else {
    segLists = [rawGeom || []];     // flat: a single segment
  }
  return segLists.map((seg) => (isList(seg) ? seg : []).map((pt) => {
    if (isList(pt) && pt.length === 2
        && pt.every((v) => typeof v === "number" && Number.isFinite(v))) {
      return [Number(pt[0]), Number(pt[1])];
    }
    return null;
  }));
}

// Parse network.yaml text into a network object. Lenient: missing fields get
// defaults and malformed values become null/empty — run validateNetwork()
// afterwards to get human-readable errors before trusting the result.
export function parseNetwork(text) {
  let raw = YAML.load(text);
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("network.yaml must be a YAML mapping at the top level "
      + `(got a ${Array.isArray(raw) ? "list" : typeof raw}).`);
  }
  return networkFromDict(raw);
}

export function networkFromDict(raw) {
  const phases = [];
  for (const item of raw.phases || []) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    phases.push(makePhase(toInt(item.phase, 0) || 0,
                          str(item.label), str(item.deadline)));
  }

  const paths = [];
  for (const item of raw.paths || []) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    paths.push(makePath({
      name: str(item.name).trim(),
      // `treatment` is the pre-split name for `type`; accept it on read.
      type: str(item.type ?? item.treatment).trim(),
      status: str(item.status, "proposed").trim() || "proposed",
      jurisdiction: str(item.jurisdiction, "city").trim() || "city",
      phase: toInt(item.phase, null),
      directions: toInt(item.directions, 2) || 2,
      on_street: str(item.on_street).trim(),
      from: str(item.from).trim(),
      to: str(item.to).trim(),
      notes: str(item.notes).trim(),
      segments: parseSegments(item.geometry),
    }));
  }

  return makeNetwork({
    city: str(raw.city, "Malden") || "Malden",
    state: str(raw.state, "Massachusetts") || "Massachusetts",
    ordinance_chapter: str(raw.ordinance_chapter),
    phases,
    paths,
    format_id: str(raw.format, FORMAT_ID) || FORMAT_ID,
    format_version: toInt(raw.format_version, FORMAT_VERSION),
  });
}

/* ------------------------------ Validation ------------------------------ */

// Python's repr() look-alike, so error text matches the desktop tool's.
const repr = (v) => (typeof v === "string" ? `'${v}'`
  : v === null || v === undefined ? "None" : String(v));

// Return a list of human-readable errors (empty == valid). Import UIs show
// these verbatim, so every message says which path/field is wrong and why.
export function validateNetwork(net) {
  const errors = [];

  if (net.format_id !== FORMAT_ID) {
    errors.push(`unrecognized format ${repr(net.format_id)}; expected ${repr(FORMAT_ID)}.`);
  }
  if (net.format_version === null || net.format_version === undefined
      || net.format_version > FORMAT_VERSION) {
    errors.push(`format_version ${repr(net.format_version)} is newer than this `
      + `tool understands (max ${FORMAT_VERSION}). Update the tool.`);
  }

  const phaseNumbers = net.phases.map((p) => p.number);
  for (const p of net.phases) {
    if (p.number < 1) {
      errors.push(`phase ${repr(p.number)}: 'phase' must be a positive integer.`);
    }
  }
  const dupes = [...new Set(phaseNumbers.filter(
    (n) => phaseNumbers.filter((m) => m === n).length > 1))].sort((a, b) => a - b);
  if (dupes.length) errors.push(`duplicate phase number(s): [${dupes.join(", ")}].`);

  net.paths.forEach((path, i) => {
    const label = path.name || `path #${i + 1}`;
    if (!path.name) errors.push(`path #${i + 1}: missing required field 'name'.`);
    if (!PATH_TYPES.includes(path.type)) {
      errors.push(`${label}: unknown type ${repr(path.type)}; `
        + `must be one of ${PATH_TYPES.join(", ")}.`);
    }
    if (!STATUSES.includes(path.status)) {
      errors.push(`${label}: unknown status ${repr(path.status)}; `
        + `must be one of ${STATUSES.join(", ")}.`);
    }
    if (!JURISDICTIONS.includes(path.jurisdiction)) {
      errors.push(`${label}: unknown jurisdiction ${repr(path.jurisdiction)}; `
        + `must be one of ${JURISDICTIONS.join(", ")}.`);
    }
    if (path.directions !== 1 && path.directions !== 2) {
      errors.push(`${label}: 'directions' must be 1 or 2 (got ${repr(path.directions)}).`);
    }
    if (path.status === "proposed") {
      if (path.phase === null || path.phase === undefined || path.phase < 1) {
        errors.push(`${label}: a proposed path needs a positive integer `
          + `'phase' (got ${repr(path.phase)}).`);
      } else if (phaseNumbers.length && !phaseNumbers.includes(path.phase)) {
        errors.push(`${label}: phase ${path.phase} is not declared in `
          + `the top-level 'phases' list.`);
      }
    }

    if (!path.segments.length || path.segments.every((s) => s.length < 2)) {
      errors.push(`${label}: 'geometry' needs at least 2 [lat, lon] points.`);
    }
    path.segments.forEach((seg, si) => {
      const where = path.segments.length > 1 ? `segment #${si + 1} ` : "";
      if (path.segments.length > 1 && seg.length < 2) {
        errors.push(`${label}: geometry ${where.trim()} needs at `
          + `least 2 [lat, lon] points.`);
      }
      seg.forEach((pt, j) => {
        if (pt === null) {
          errors.push(`${label}: geometry ${where}point #${j + 1} is `
            + `not a [lat, lon] pair of numbers.`);
        } else if (!(pt[0] >= -90 && pt[0] <= 90 && pt[1] >= -180 && pt[1] <= 180)) {
          errors.push(`${label}: geometry ${where}point #${j + 1} `
            + `(${pt[0]}, ${pt[1]}) is out of range — points `
            + `are [lat, lon], in degrees.`);
        }
      });
    });
  });
  return errors;
}

/* ----------------------------- Serialization ---------------------------- */

const round6 = (v) => Number(v.toFixed(6));

// Format one segment's points as compact YAML flow style ("[[lat, lon], ...]"),
// greedily wrapped near `width` columns with `contIndent` continuation indent
// (PyYAML's default_flow_style=None look).
function formatFlow(items, startCol, contIndent, width = 100) {
  const lines = [];
  let line = "[";
  let col = startCol + 1;
  items.forEach((item, i) => {
    const piece = item + (i < items.length - 1 ? ", " : "");
    if (col + piece.length > width && line.trim() !== "[" && line.trim() !== "") {
      lines.push(line.trimEnd());
      line = " ".repeat(contIndent);
      col = contIndent;
    }
    line += piece;
    col += piece.length;
  });
  lines.push(line + "]");
  return lines.join("\n");
}

function geometryYaml(segments, indentCol) {
  const pointStr = (pt) => `[${round6(pt[0])}, ${round6(pt[1])}]`;
  if (segments.length === 1) {
    return formatFlow(segments[0].map(pointStr), indentCol, indentCol + 2);
  }
  const segStrs = segments.map(
    (seg) => `[${seg.map(pointStr).join(", ")}]`);
  return formatFlow(segStrs, indentCol, indentCol + 2);
}

function pathDict(p, token) {
  const out = { name: p.name, type: p.type, status: p.status,
                jurisdiction: p.jurisdiction };
  if (p.phase !== null && p.phase !== undefined) out.phase = p.phase;
  out.directions = p.directions;
  for (const [key, value] of [["on_street", p.on_street], ["from", p.from],
                              ["to", p.to], ["notes", p.notes]]) {
    if (value) out[key] = value;
  }
  out.geometry = token;
  return out;
}

// Serialize a network to YAML text (stable key order; geometry points in
// compact [lat, lon] flow style). The geometry arrays are formatted by hand
// (via placeholder tokens) so they always come out flow-style regardless of
// nesting depth — js-yaml has no per-node style control.
export function serializeNetwork(net) {
  const salt = Math.random().toString(36).slice(2, 8);
  const tokenFor = (i) => `ZZGEOMZZ${salt}ZZ${i}ZZ`;

  const doc = {
    format: FORMAT_ID,
    format_version: FORMAT_VERSION,
    city: net.city,
    state: net.state,
  };
  if (net.ordinance_chapter) doc.ordinance_chapter = net.ordinance_chapter;
  doc.phases = [...net.phases].sort((a, b) => a.number - b.number)
    .map((p) => ({ phase: p.number, label: p.label, deadline: p.deadline }));
  doc.paths = net.paths.map((p, i) => pathDict(p, tokenFor(i)));

  let body = YAML.dump(doc, { lineWidth: 100, noRefs: true });
  body = body.replace(
    new RegExp(`^([ ]*)geometry: ZZGEOMZZ${salt}ZZ(\\d+)ZZ$`, "gm"),
    (whole, indent, idx) => {
      const p = net.paths[Number(idx)];
      const startCol = indent.length + "geometry: ".length;
      return `${indent}geometry: ${geometryYaml(p.segments, startCol)}`;
    });

  const header = "# Bike network — written by bike-network-builder; re-importable there and\n"
    + "# readable by any YAML tool. Geometry points are [latitude, longitude]\n"
    + "# in degrees. See NETWORK_FORMAT.md.\n";
  return header + body;
}
