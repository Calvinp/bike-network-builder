// The treatment registry: what the tool can represent.
//
// `data/treatments.json` — not the format spec — holds the vocabulary. That is
// what makes "adding a bus lane is a registry entry, not a spec change"
// literally true (V2_PLAN.md §4.5).
//
// Two rules carry most of the weight:
//
//  * UNKNOWN treatments degrade, they don't fail. A file written by a newer
//    tool still opens: the unknown treatment draws neutrally, contributes
//    nothing to costs or bike totals, and is reported so the UI can say so.
//    Structure is still strict.
//  * `stack_rank` is DRAW ORDER ONLY, never semantics. A feature draws EVERY
//    treatment it carries, lowest rank first so the highest ends up on top.
//    Nothing may treat `treatments[0]` as primary: list order is declared
//    insignificant precisely so an `arrangement:` key stays reachable later.
//
// Port of bikenetwork/registry.py, reading the same file.

export const KM_PER_MILE = 1.609344;

// Where an unknown treatment sorts: after everything shipped, so a file from a
// newer tool can't reorder what this one draws underneath.
export const UNKNOWN_RANK = 10000;

function makeTreatment(raw) {
  const style = (raw.style && typeof raw.style === "object") ? raw.style : {};
  const cost = (raw.cost && typeof raw.cost === "object") ? raw.cost : null;
  return {
    id: String(raw.id),
    label: String(raw.label || ""),
    category: String(raw.category || "other"),
    measure: String(raw.measure || "counted"),
    unit: String(raw.unit || ""),
    geometry: Array.isArray(raw.geometry) ? raw.geometry : ["point", "line"],
    cost,
    style,
    unknown: false,
    get color() { return style.color || ""; },
    get glyph() { return style.glyph || ""; },
    get stackRank() {
      return Number.isFinite(Number(style.stack_rank))
        ? Number(style.stack_rank) : UNKNOWN_RANK;
    },
    get isBike() { return this.category === "bike"; },
    get costPerKm() { return (cost && cost.per_km) ? cost.per_km : null; },
    get costPerUnit() { return (cost && cost.per_unit) ? cost.per_unit : null; },
    appliesTo(kind) { return this.geometry.includes(kind); },
  };
}

// A placeholder for an id this version doesn't know. Readable label, no cost
// (never invent a figure), neutral style, and it applies to any geometry so it
// can still be drawn wherever the file put it.
export function unknownTreatment(id) {
  const t = makeTreatment({
    id,
    label: String(id).replace(/_/g, " ").replace(/:/g, ": "),
    category: "unknown",
    measure: "counted",
    unit: "items",
    geometry: ["point", "line"],
    cost: null,
    style: { color: "#8c8c8c", glyph: "?", stack_rank: UNKNOWN_RANK },
  });
  t.unknown = true;
  return t;
}

export class Registry {
  constructor(treatments = [], version = 1) {
    this._byId = new Map(treatments.map((t) => [t.id, t]));
    this.version = version;
  }

  static fromDoc(doc) {
    const raw = (doc && Array.isArray(doc.treatments)) ? doc.treatments : [];
    return new Registry(
      raw.filter((t) => t && t.id).map(makeTreatment),
      Number(doc && doc.registry_version) || 1);
  }

  // Always returns a treatment — a synthesized `unknown` one when the id isn't
  // shipped — so callers never have to branch on null.
  get(id) { return this._byId.get(id) || unknownTreatment(id); }

  isKnown(id) { return this._byId.has(id); }

  all() { return [...this._byId.values()]; }

  // The treatments that make sense on a given geometry ("point" or "line").
  // The FORMAT allows any treatment on any geometry and always will — a file
  // written by another tool is not wrong for saying so. This is what the
  // editor OFFERS, which is a different question: a separated bike lane on a
  // single point, or bike parking spread along a corridor, is almost always a
  // slip, and the registry has known which is which all along.
  forGeometry(kind) { return this.all().filter((t) => t.appliesTo(kind)); }

  // The ids in `used` this version doesn't recognise, sorted. The UI turns
  // these into "this file uses N kinds of improvement this version doesn't
  // know about".
  unknownIds(used) {
    return [...new Set((used || []).filter((t) => t && !this._byId.has(t)))].sort();
  }

  // Treatments in draw order: lowest stack_rank first, so the highest is drawn
  // last and ends up on top. Ties break on id, so the result never depends on
  // the order the file happened to list them in.
  sortedForDraw(ids) {
    return (ids || []).map((id) => this.get(id)).sort(
      (a, b) => (a.stackRank - b.stackRank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

// The app loads the registry once at startup and every renderer reads it
// synchronously from here — the alternative is threading it through every
// drawing function, which buys nothing.
let CURRENT = new Registry([]);

export function setRegistry(docOrRegistry) {
  CURRENT = (docOrRegistry instanceof Registry)
    ? docOrRegistry : Registry.fromDoc(docOrRegistry);
  return CURRENT;
}

export function registry() { return CURRENT; }
export const treatment = (id) => CURRENT.get(id);
