// Undo and redo. Snapshots bounded by BYTES, so a small network gets deep
// history and a huge one gets shallow history rather than eating the tab.
import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../js/history.js";

const h = (opts) => new History({ coalesceMs: 0, ...opts });

test("nothing to undo until something has changed", () => {
  const hist = h();
  assert.equal(hist.canUndo, false);
  hist.push("a");
  assert.equal(hist.canUndo, false);   // the first push is just the baseline
  hist.push("b");
  assert.equal(hist.canUndo, true);
});

test("undo walks back and redo walks forward", () => {
  const hist = h();
  hist.push("a"); hist.push("b"); hist.push("c");
  assert.equal(hist.undo(), "b");
  assert.equal(hist.undo(), "a");
  assert.equal(hist.canUndo, false);
  assert.equal(hist.redo(), "b");
  assert.equal(hist.redo(), "c");
  assert.equal(hist.canRedo, false);
});

test("undoing past the start returns null rather than throwing", () => {
  const hist = h();
  hist.push("a");
  assert.equal(hist.undo(), null);
  assert.equal(hist.redo(), null);
});

test("a new edit forks the future", () => {
  // Standard undo semantics: once you undo and then do something else, the
  // redo branch is gone.
  const hist = h();
  hist.push("a"); hist.push("b"); hist.push("c");
  hist.undo();
  assert.equal(hist.canRedo, true);
  hist.push("d");
  assert.equal(hist.canRedo, false);
  assert.equal(hist.undo(), "b");
});

test("pushing an unchanged state is not a step", () => {
  const hist = h();
  hist.push("a"); hist.push("a"); hist.push("a");
  assert.equal(hist.canUndo, false);
});

test("rapid edits of the same kind coalesce into one step", () => {
  // Typing a name should not be twenty undos.
  let t = 0;
  const hist = new History({ coalesceMs: 700, now: () => t });
  hist.push("", "rename");
  t = 100; hist.push("M", "rename");
  t = 200; hist.push("Ma", "rename");
  t = 300; hist.push("Mai", "rename");
  t = 400; hist.push("Main", "rename");
  assert.equal(hist.depth, 1);
  assert.equal(hist.undo(), "");
});

test("edits far apart in time stay separate steps", () => {
  let t = 0;
  const hist = new History({ coalesceMs: 700, now: () => t });
  hist.push("a", "rename");
  t = 5000; hist.push("b", "rename");
  t = 10000; hist.push("c", "rename");
  assert.equal(hist.depth, 2);
});

test("different kinds of edit never coalesce", () => {
  let t = 0;
  const hist = new History({ coalesceMs: 700, now: () => t });
  hist.push("a", "rename");
  t = 10; hist.push("b", "delete");
  assert.equal(hist.depth, 1);
  t = 20; hist.push("c", "rename");
  assert.equal(hist.depth, 2);
});

test("history is bounded by BYTES, so a big network gets shallow history", () => {
  // The whole reason for bounding this way: 60 snapshots of a 6 MB network
  // would be 360 MB of tab memory.
  const big = "x".repeat(1000);
  const hist = h({ maxBytes: 3000, maxEntries: 1000 });
  for (let i = 0; i < 20; i++) hist.push(big + i);
  assert.ok(hist.depth <= 3, `kept ${hist.depth} steps`);
  assert.ok(hist.bytes <= 3000);
});

test("history is also bounded by count, for small states", () => {
  const hist = h({ maxEntries: 5, maxBytes: 1e9 });
  for (let i = 0; i < 50; i++) hist.push(String(i));
  assert.ok(hist.depth <= 5);
});

test("trimming drops the OLDEST steps", () => {
  // The recent past is what people reach for.
  const hist = h({ maxEntries: 2, maxBytes: 1e9 });
  ["a", "b", "c", "d"].forEach((s) => hist.push(s));
  assert.equal(hist.undo(), "c");
  assert.equal(hist.undo(), "b");
  assert.equal(hist.canUndo, false);     // "a" was trimmed
});

test("labels describe the edit, so a button can say what it will reverse", () => {
  const hist = h();
  hist.push("a", "");
  hist.push("b", "delete");
  assert.equal(hist.undoLabel, "delete");
  hist.undo();
  assert.equal(hist.redoLabel, "delete");
});

test("clear resets everything", () => {
  const hist = h();
  hist.push("a"); hist.push("b");
  hist.clear();
  assert.equal(hist.canUndo, false);
  assert.equal(hist.canRedo, false);
  assert.equal(hist.bytes, 0);
});
