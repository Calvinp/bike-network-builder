// The deployment's default area, read from `data/place.json`.
//
// Nothing in the app names a city, a boundary file, or a map centre. Point
// place.json at somewhere else — with its own boundary GeoJSON beside it — and
// the app follows, no code change. That is the whole of what
// "geography-agnostic" means in practice; test/place.test.js pins it with a
// town that doesn't exist.
//
// Port of bikenetwork/place.py, reading the same file (web/data/place.json is
// a byte-identical copy of data/place.json — a test enforces that, as it does
// for every other shared asset). Asset paths are relative to `web/` here and
// to the repo root there; the same string works for both, because web/data/
// mirrors data/.

const str = (v, fallback = "") =>
  (typeof v === "string" && v.trim()) ? v.trim() : fallback;

export function makePlace(fields = {}) {
  return {
    id: "",
    name: "",
    context: "",
    kind: "municipality",
    authorities: [],
    defaultAuthority: "",
    assets: {},
    mapCenter: null,
    mapZoom: 13,
    fetch: {},
    ...fields,

    // "Malden, Massachusetts" — or just the name when there is no context.
    // Disambiguation matters more than it looks: there is a Malden in
    // Massachusetts and another in Washington.
    get displayName() {
      return this.context ? `${this.name}, ${this.context}` : this.name;
    },

    // The display name for an authority id, falling back to the id itself: a
    // file may reference an authority this deployment hasn't declared, and the
    // UI still has to put a word on the screen.
    authorityName(id) {
      const found = (this.authorities || []).find((a) => a && a.id === id);
      return (found && found.name) || id;
    },

    // The relative path for a named asset, or null when this deployment
    // doesn't ship one. A missing street graph or seed network is a normal
    // state, not an error — see V2_PLAN.md §7 and §8.4.
    asset(key) {
      return str(this.assets && this.assets[key]) || null;
    },
  };
}

export function parsePlace(raw) {
  const doc = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const map = (doc.map && typeof doc.map === "object") ? doc.map : {};
  const c = map.center;
  const center = (Array.isArray(c) && c.length === 2
    && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
    ? [Number(c[0]), Number(c[1])]
    : null;                       // never guess a centre — fall back to bounds
  return makePlace({
    id: str(doc.id),
    name: str(doc.name),
    context: str(doc.context),
    kind: str(doc.kind, "municipality"),
    authorities: Array.isArray(doc.authorities) ? doc.authorities : [],
    defaultAuthority: str(doc.default_authority),
    assets: (doc.assets && typeof doc.assets === "object") ? doc.assets : {},
    mapCenter: center,
    mapZoom: Number.isFinite(Number(map.zoom)) ? Number(map.zoom) : 13,
    fetch: (doc.fetch && typeof doc.fetch === "object") ? doc.fetch : {},
  });
}
