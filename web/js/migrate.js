// Upgrade a v1 network file to v2. Import only — the tool never writes v1, and
// there is no downgrade export (V2_PLAN.md §4.10).
//
// Everything here is mechanical except the phase dates: v1's `deadline` was
// free text, and v2 wants a sortable `target_date`. Whatever parses is
// converted; whatever doesn't is kept verbatim in the phase's `tags` (as
// `deadline_v1`), so the conversion is lossless even where it is lossy, and
// `phasesNeedingDates()` reports the rest so the UI can ask. That is the
// single interactive step in the whole upgrade.
//
// Ids are assigned DETERMINISTICALLY (`f-1`, `t-1`, ... and `f-s1` for spots),
// not randomly: two people upgrading the same v1 file must end up with the
// same ids, or their files could never be merged. A v1 path that already had
// an `id` keeps it — that is what its `upgrades` references point at.
//
// Port of bikenetwork/migrate.py — the two must agree, or a file upgraded in
// the browser and one upgraded by build.py would differ.
import { registerV1Upgrade } from "./network_format.js";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
                "august", "september", "october", "november", "december"];

export const MUNICIPAL_AUTHORITY = "local";
export const STATE_AUTHORITY = "state-dot";

const str = (v) => (v === null || v === undefined || typeof v === "boolean")
  ? "" : String(v).trim();

function toInt(v, fallback = null) {
  if (typeof v === "boolean") return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

// Turn v1's free-text deadline into `YYYY[-MM[-DD]]`, or null.
//
// Deliberately conservative: it recognises the shapes the tool itself wrote
// ("December 31, 2029") and obvious ISO-ish ones, and gives up on anything
// else rather than guessing a date nobody agreed to.
export function parseV1Deadline(text) {
  // A YAML date may already have been parsed into a Date by js-yaml.
  if (text instanceof Date) return text.toISOString().slice(0, 10);
  const s = str(text);
  if (!s) return null;
  const iso = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (iso) return iso.slice(1).filter(Boolean).join("-");
  let m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    const mm = String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0");
    return `${m[3]}-${mm}-${String(parseInt(m[2], 10)).padStart(2, "0")}`;
  }
  m = /^([A-Za-z]+)\s+(\d{4})$/.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    const mm = String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0");
    return `${m[2]}-${mm}`;
  }
  m = /^(?:end of\s+)?(\d{4})$/i.exec(s);
  if (m) return m[1];
  return null;
}

// [{number, text}, ...] for v1 phases whose deadline didn't parse. The UI shows
// these and asks; nothing is invented on the user's behalf.
export function phasesNeedingDates(raw) {
  const out = [];
  for (const item of (raw && raw.phases) || []) {
    if (!item || typeof item !== "object") continue;
    const text = str(item.deadline);
    if (text && parseV1Deadline(text) === null) {
      out.push({ number: toInt(item.phase, 0) || 0, text });
    }
  }
  return out;
}

// v1 `geometry` was polymorphic: a flat point list meant one segment, a nested
// list meant several. v2 always nests.
function geometryV1ToParts(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const first = raw[0];
  const nested = Array.isArray(first) && first.length && Array.isArray(first[0]);
  return nested ? raw.map((seg) => [...seg]) : [[...raw]];
}

const authorityFor = (j) => (str(j) === "state" ? STATE_AUTHORITY : MUNICIPAL_AUTHORITY);

// v1 `directions` conflated "how many facilities" with "which way you can
// ride": 2 = one each way, 1 = a single one-way facility. Neither could express
// a two-way track on one side, which is why v2 splits them.
const travelAndSides = (d) => (toInt(d, 2) === 1 ? ["one_way", 1] : ["two_way", 2]);

export function upgradeV1(raw) {
  const doc = (raw && typeof raw === "object") ? raw : {};
  const city = str(doc.city) || "Unnamed area";
  const state = str(doc.state);

  const areaId = "area-" + city.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const area = { id: areaId, name: city, kind: "municipality" };
  if (state) area.context = state;
  area.default_authority = MUNICIPAL_AUTHORITY;

  const authorities = [
    { id: MUNICIPAL_AUTHORITY, name: city || "The municipality", level: "municipal" },
    { id: STATE_AUTHORITY, name: state ? `${state} DOT` : "The state DOT",
      level: "state" },
  ];

  const phases = [];
  const phaseIdByNumber = new Map();
  for (const item of doc.phases || []) {
    if (!item || typeof item !== "object") continue;
    const number = toInt(item.phase, phases.length + 1) || 1;
    const pid = `phase-${number}`;
    phaseIdByNumber.set(number, pid);
    const entry = { id: pid, number };
    if (str(item.label)) entry.label = str(item.label);
    const text = item.deadline instanceof Date ? item.deadline : str(item.deadline);
    const parsed = text ? parseV1Deadline(text) : null;
    if (parsed) entry.target_date = parsed;
    else if (text) entry.tags = { deadline_v1: str(text) };
    phases.push(entry);
  }

  const features = [];
  let index = 0;
  for (const item of doc.paths || []) {
    if (!item || typeof item !== "object") continue;
    index += 1;
    const [travel, sides] = travelAndSides(item.directions);
    const phaseNum = toInt(item.phase, null);
    const treatment = {
      // v1's path `id` was what `upgrades` referenced, and in v2 upgrades
      // reference TREATMENTS — so the old id belongs here, not on the feature,
      // or every upgrade reference in the file would dangle.
      id: str(item.id) || `t-${index}`,
      type: str(item.type) || str(item.treatment) || "other",
      status: str(item.status) || "proposed",
      authority: authorityFor(item.jurisdiction),
    };
    if (phaseNum && phaseIdByNumber.has(phaseNum)) {
      treatment.phase = phaseIdByNumber.get(phaseNum);
    }
    if (travel !== "two_way") treatment.travel = travel;
    if (sides !== 2) treatment.sides = sides;
    if (str(item.upgrades)) treatment.upgrades = [str(item.upgrades)];

    const feature = { id: `f-${index}`, name: str(item.name) };
    for (const [src, dst] of [["on_street", "on_street"], ["from", "start"],
                              ["to", "end"], ["notes", "notes"]]) {
      if (str(item[src])) feature[dst] = str(item[src]);
    }
    feature.treatments = [treatment];
    feature.geometry = geometryV1ToParts(item.geometry);
    features.push(feature);
  }

  let spotIndex = 0;
  for (const item of doc.spots || []) {
    if (!item || typeof item !== "object") continue;
    spotIndex += 1;
    const loc = item.location;
    if (!Array.isArray(loc) || loc.length !== 2) continue;
    const phaseNum = toInt(item.phase, null);
    const treatment = {
      id: `t-s${spotIndex}`,
      type: str(item.type) || str(item.kind) || "other",
      status: str(item.status) || "proposed",
      authority: authorityFor(item.jurisdiction),
    };
    if (phaseNum && phaseIdByNumber.has(phaseNum)) {
      treatment.phase = phaseIdByNumber.get(phaseNum);
    }
    const feature = {
      id: `f-s${spotIndex}`,
      name: str(item.name) || str(item.type) || "Spot",
      treatments: [treatment],
      geometry: [[[...loc]]],
    };
    if (str(item.notes)) feature.notes = str(item.notes);
    features.push(feature);
  }

  const out = {
    format: "bike-network",
    format_version: 2,
    crs: "EPSG:4326",
    units: "metric",
    areas: [area],
    authorities,
    phases,
    features,
  };
  // Anything v1 carried that v2 doesn't interpret rides along untouched
  // (`ordinance_chapter` is the motivating case).
  const consumed = new Set(["format", "format_version", "city", "state",
                            "phases", "paths", "spots"]);
  for (const [key, value] of Object.entries(doc)) {
    if (!consumed.has(key) && !(key in out)) out[key] = value;
  }
  return out;
}

// Fill in target dates a human supplied: {phaseNumber: 'YYYY-MM-DD'}. An empty
// or missing value means "no target date", which is a legitimate answer.
export function applyPhaseDates(rawV2, dates) {
  for (const phase of rawV2.phases || []) {
    const chosen = str((dates || {})[phase.number]);
    if (chosen) phase.target_date = chosen;
  }
  return rawV2;
}

// Wire the upgrader into the format module. Doing it here (rather than a
// static import there) keeps `parseNetwork` synchronous without a circular
// static dependency, which is a load-order hazard in the browser.
registerV1Upgrade(upgradeV1);
