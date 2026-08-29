// Bringing in someone else's network (V2_PLAN.md §6).
//
// **The unit of replacement is a whole AREA.** No per-feature merge, no
// conflict resolution, no three-way anything. That is deliberate: it maps onto
// how the work is actually divided — one advocacy group owns one town — and it
// is the entire reason the feature can be described in one sentence.
//
// The vocabulary is *add*, *keep mine*, *use theirs*, *areas*. Never commit,
// merge, branch, diff, conflict or revision: this tool is for people who are
// enthusiastic about bike networks, not about version control.
//
// Rules, in the order they matter:
//
//  * Areas you don't have default to ADD. Areas you do default to KEEP MINE —
//    import never destroys work silently.
//  * A feature belongs to the area holding the MAJORITY OF ITS LENGTH, so
//    exactly one side owns a corridor that crosses a border and "replace this
//    area" is never ambiguous.
//  * Incoming ids that collide are rewritten, and every reference follows.
//  * Phase mapping is skipped entirely when it would be trivial.
import { clipSegmentsLatlon } from "./boundary.js";
import { assignAreas } from "./pipeline.js";
import { makeArea, makeFeature, makeNetwork, makePhase, makeTreatment, newId }
  from "./network_format.js";

export const UNASSIGNED = null;   // "somewhere that isn't a declared area"

// --------------------------------------------------------------------------
// Which area does a feature belong to?
// --------------------------------------------------------------------------
// Re-exported from pipeline.js, which needs the same answer for its per-area
// totals. One implementation, so the sheet and the totals can never disagree
// about which town a corridor is in.
export { assignAreas };

const areaLabel = (id, areas) => {
  const a = areas.find((x) => x.id === id);
  return a ? (a.name || a.id) : "Somewhere else";
};

// --------------------------------------------------------------------------
// The plan: what the import sheet shows
// --------------------------------------------------------------------------
export function planMerge(mine, theirs) {
  const allAreas = [...mine.areas, ...theirs.areas.filter(
    (a) => !mine.areas.some((m) => m.id === a.id))];
  const mineBy = assignAreas(mine.features, allAreas);
  const theirsBy = assignAreas(theirs.features, allAreas);

  const ids = [...new Set([...mineBy.values(), ...theirsBy.values()])];
  // Declared areas first, in their own order; the "somewhere else" bucket last.
  const ordered = [...allAreas.map((a) => a.id).filter((id) => ids.includes(id))];
  if (ids.includes(UNASSIGNED)) ordered.push(UNASSIGNED);

  const areas = ordered.map((id) => {
    const mineCount = [...mineBy.values()].filter((v) => v === id).length;
    const theirsCount = [...theirsBy.values()].filter((v) => v === id).length;
    const isNew = mineCount === 0 && theirsCount > 0;
    return {
      id,
      name: areaLabel(id, allAreas),
      mineCount,
      theirsCount,
      isNew,
      // Nothing to decide when the file has nothing for this area.
      untouched: theirsCount === 0,
      // Areas I don't have: add. Areas I do: keep mine.
      choice: isNew ? "theirs" : "mine",
    };
  });

  // Features of theirs that reach into an area I'm keeping. The summary says
  // so out loud rather than letting the trim be a surprise.
  const keeping = new Set(areas.filter((a) => a.choice === "mine").map((a) => a.id));
  const seamCrossing = [];
  for (const f of theirs.features) {
    const owner = theirsBy.get(f.id);
    if (owner === UNASSIGNED || keeping.has(owner)) continue;
    const lines = typeof f.lines === "function" ? f.lines() : [];
    if (!lines.length) continue;
    for (const area of allAreas) {
      if (!keeping.has(area.id) || !area.boundary || !area.boundary.length) continue;
      const [, miles] = clipSegmentsLatlon(lines, area.boundary);
      if (miles > 0.01) { seamCrossing.push(f.name); break; }
    }
  }

  return { areas, seamCrossing, phases: phasePlan(mine, theirs),
           theirsBy, mineBy, allAreas };
}

// --------------------------------------------------------------------------
// Phases (D6)
// --------------------------------------------------------------------------
// Two files can both say "Phase 1" and mean different years. Rather than guess,
// map their phases onto mine — but ONLY when that is a real question. The
// fantasy-map user who put everything in one phase should never see this.
export function phasePlan(mine, theirs) {
  const mineP = [...mine.phases].sort((a, b) => a.number - b.number);
  const theirsP = [...theirs.phases].sort((a, b) => a.number - b.number);

  const sameShape = mineP.length === theirsP.length && mineP.every(
    (p, i) => p.number === theirsP[i].number && (p.label || "") === (theirsP[i].label || ""));
  const trivial = mineP.length <= 1 || theirsP.length <= 1 || sameShape;

  const rows = theirsP.map((p) => ({
    fromId: p.id,
    fromNumber: p.number,
    fromLabel: p.label || `Phase ${p.number}`,
    fromDate: p.target_date || "",
    // Default to identity by number, which makes the common case one Confirm
    // rather than a dozen decisions.
    toId: (mineP.find((m) => m.number === p.number) || mineP[mineP.length - 1]
           || { id: null }).id,
  }));

  return {
    trivial,
    keep: "mine",
    rows,
    options: mineP.map((p) => ({ id: p.id, number: p.number,
                                 label: p.label || `Phase ${p.number}`,
                                 date: p.target_date || "" })),
    // Many-to-one is a normal thing to want and never warns. Only ORDER
    // INVERSION does: their sequencing wouldn't survive the import.
    isInverted(currentRows) {
      const num = (id) => (mineP.find((m) => m.id === id) || {}).number ?? null;
      const seq = (currentRows || rows)
        .slice().sort((a, b) => a.fromNumber - b.fromNumber)
        .map((r) => num(r.toId)).filter((n) => n !== null);
      for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) return true;
      return false;
    },
  };
}

// --------------------------------------------------------------------------
// Applying it
// --------------------------------------------------------------------------
function cloneTreatment(t, idMap) {
  return makeTreatment({ ...t,
    id: idMap.get(t.id) || t.id,
    upgrades: (t.upgrades || []).map((u) => idMap.get(u) || u),
    tags: { ...(t.tags || {}) } });
}
function cloneFeature(f, idMap, phaseFor) {
  return makeFeature({
    ...f,
    id: idMap.get(f.id) || f.id,
    treatments: f.treatments.map((t) => {
      const c = cloneTreatment(t, idMap);
      if (c.phase) c.phase = phaseFor(c.phase) || c.phase;
      return c;
    }),
    geometry: f.geometry.map((part) => part.map((pt) => [...pt])),
    tags: { ...(f.tags || {}) },
  });
}

/**
 * Merge `theirs` into `mine`.
 *
 * `areaChoices` maps area id -> "mine" | "theirs" (missing = keep mine).
 * `phaseMapping` maps their phase id -> my phase id, or the string "__new__"
 * to append their phase to my plan.
 * `featureChoices` is the ADVANCED escape hatch: feature id -> boolean. It is
 * per-feature SELECTION, not per-feature merging — a different and much
 * simpler thing.
 */
export function applyMerge(mine, theirs, {
  areaChoices = {}, phaseMapping = null, featureChoices = null,
} = {}) {
  const plan = planMerge(mine, theirs);
  const choiceFor = (id) => areaChoices[String(id)]
    ?? (plan.areas.find((a) => a.id === id) || {}).choice ?? "mine";

  // Ids in play across BOTH networks, so a rewritten id can't collide with a
  // phase appended below (or vice versa).
  const usedIds = new Set(mine.allIds());

  // --- phases: mine are authoritative; theirs are mapped or appended -------
  const phases = mine.phases.map((p) => makePhase({ ...p, tags: { ...(p.tags || {}) } }));
  const phaseFor = (theirId) => {
    const target = phaseMapping ? phaseMapping[theirId] : undefined;
    if (target && target !== "__new__") return target;
    const theirPhase = theirs.phases.find((p) => p.id === theirId);
    if (!theirPhase) return null;
    if (target === "__new__") {
      const existing = phases.find((p) => p.tags && p.tags.__from === theirId);
      if (existing) return existing.id;
      const added = makePhase({
        ...theirPhase,
        id: uniqueId(theirPhase.id, usedIds),
        number: phases.reduce((m, p) => Math.max(m, p.number), 0) + 1,
        tags: { ...(theirPhase.tags || {}), __from: theirId },
      });
      phases.push(added);
      usedIds.add(added.id);
      return added.id;
    }
    // No mapping supplied: identity by number, falling back to my last phase.
    const byNumber = phases.find((p) => p.number === theirPhase.number);
    return (byNumber || phases[phases.length - 1] || {}).id || null;
  };

  const idMap = new Map();
  // --- ids: mine keep theirs; incoming collisions are rewritten -----------
  for (const f of theirs.features) {
    idMap.set(f.id, uniqueId(f.id, usedIds));
    usedIds.add(idMap.get(f.id));
    for (const t of f.treatments) {
      idMap.set(t.id, uniqueId(t.id, usedIds));
      usedIds.add(idMap.get(t.id));
    }
  }

  // --- features ------------------------------------------------------------
  const features = [];
  for (const f of mine.features) {
    const area = plan.mineBy.get(f.id);
    // My features survive unless I asked for theirs in that area.
    if (choiceFor(area) !== "theirs") features.push(f);
  }
  for (const f of theirs.features) {
    const area = plan.theirsBy.get(f.id);
    if (choiceFor(area) !== "theirs") continue;
    if (featureChoices && featureChoices[f.id] === false) continue;
    features.push(cloneFeature(f, idMap, phaseFor));
  }

  // --- areas and authorities ----------------------------------------------
  const areas = mine.areas.map((a) => makeArea({ ...a }));
  for (const a of theirs.areas) {
    if (areas.some((x) => x.id === a.id)) continue;      // mine wins on a tie
    if (choiceFor(a.id) !== "theirs") continue;
    areas.push(makeArea({ ...a }));
  }
  const authorities = [...mine.authorities];
  for (const a of theirs.authorities) {
    if (!authorities.some((x) => x.id === a.id)) authorities.push({ ...a });
  }

  return makeNetwork({
    areas, authorities, phases, features,
    meta: { ...mine.meta },
    costs: { ...mine.costs },
    units: mine.units,
    crs: mine.crs,
    extra: { ...mine.extra },
  });
}

function uniqueId(wanted, used) {
  if (!used.has(wanted)) return wanted;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${wanted}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return newId();
}

// --------------------------------------------------------------------------
// Plain-language summary of what an import did.
// --------------------------------------------------------------------------
export function describeMerge(plan, areaChoices = {}) {
  const lines = [];
  for (const a of plan.areas) {
    const choice = areaChoices[String(a.id)] ?? a.choice;
    if (a.untouched) {
      lines.push(`${a.name} — not in this file. Your ${a.mineCount} `
        + `${a.mineCount === 1 ? "feature is" : "features are"} untouched.`);
    } else if (choice === "theirs" && a.isNew) {
      lines.push(`${a.name} — added ${a.theirsCount} from the file.`);
    } else if (choice === "theirs") {
      lines.push(`${a.name} — replaced your ${a.mineCount} with their `
        + `${a.theirsCount}.`);
    } else {
      lines.push(`${a.name} — kept yours; their ${a.theirsCount} left out.`);
    }
  }
  if (plan.seamCrossing.length) {
    const n = plan.seamCrossing.length;
    lines.push(`${n} ${n === 1 ? "feature crosses" : "features cross"} into `
      + `areas you're keeping — they stay as you have them.`);
  }
  return lines;
}
