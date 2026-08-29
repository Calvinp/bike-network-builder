// Undo and redo.
//
// Until now there was none at all: autosave overwrote storage continuously and
// a deleted corridor was simply gone. That gets worse as networks get bigger
// and get shared, so the import sheet's "save a copy first" was the only
// safety net in the tool.
//
// ## Why snapshots rather than commands
//
// The plan flagged command-based undo as the "correct" design, because a
// bounded stack of serialized states is trivial for one town and untenable at
// metro scale. But command-based undo means every mutation in the editor
// becomes a command object, which is a large refactor of code that is
// currently direct and readable — and it buys nothing for the networks anyone
// actually has today.
//
// So: snapshots, BOUNDED BY BYTES rather than by count. A small network gets
// deep history; a huge one gets shallow history instead of eating the tab's
// memory. That degrades in the right direction, and the depth is reported so
// the UI can be honest about it. If shallow undo on a very large network ever
// becomes a real complaint, commands are the upgrade path and this interface
// does not change.

export const MAX_BYTES = 24 * 1024 * 1024;   // ~24 MB of history, total
export const MAX_ENTRIES = 60;
// Edits closer together than this coalesce into one step, so typing a name
// isn't twenty undos.
export const COALESCE_MS = 700;

export class History {
  constructor({ maxBytes = MAX_BYTES, maxEntries = MAX_ENTRIES,
                coalesceMs = COALESCE_MS, now = () => Date.now() } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.coalesceMs = coalesceMs;
    this.now = now;
    this.past = [];       // [{state, label, at}]
    this.future = [];
    this.present = null;
    this._bytes = 0;
  }

  // Record the state the editor is in now. `label` describes the edit that
  // PRODUCED it, so the UI can say "Undo delete" rather than just "Undo".
  push(state, label = "") {
    if (this.present === null) { this._setPresent(state, label); return; }
    if (state === this.present.state) return;      // nothing actually changed

    const at = this.now();
    // Rapid successive edits of the same kind are one step: typing a name
    // should not be twenty undos.
    const coalesce = this.past.length
      && label && label === this.present.label
      && at - this.present.at < this.coalesceMs;
    if (!coalesce) {
      this.past.push(this.present);
      this._bytes += this.present.state.length;
    }
    this._setPresent(state, label, at);
    this.future = [];                              // a new edit forks the future
    this._trim();
  }

  _setPresent(state, label, at = this.now()) {
    this.present = { state, label, at };
  }

  // Oldest first: history is a convenience, and the recent past is what people
  // reach for.
  _trim() {
    while (this.past.length
           && (this._bytes > this.maxBytes || this.past.length > this.maxEntries)) {
      this._bytes -= this.past.shift().state.length;
    }
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  // What the next undo/redo would reverse, for a button tooltip.
  get undoLabel() { return this.present ? this.present.label : ""; }
  get redoLabel() {
    return this.future.length ? this.future[this.future.length - 1].label : "";
  }

  undo() {
    if (!this.canUndo) return null;
    this.future.push(this.present);
    this.present = this.past.pop();
    this._bytes -= this.present.state.length;
    return this.present.state;
  }

  redo() {
    if (!this.canRedo) return null;
    this.past.push(this.present);
    this._bytes += this.present.state.length;
    this.present = this.future.pop();
    return this.present.state;
  }

  // Depth actually available, so the UI can be honest when a big network has
  // pushed older steps out.
  get depth() { return this.past.length; }
  get bytes() { return this._bytes; }

  clear() {
    this.past = [];
    this.future = [];
    this.present = null;
    this._bytes = 0;
  }
}
