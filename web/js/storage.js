// Where the network is kept between visits.
//
// localStorage was fine for one town and stops being fine for a region: at
// ~2.1 KB per feature, a 100-town metro network is around 6 MB against a
// typical ~5 MB quota, and the failure mode is a thrown QuotaExceededError in
// the middle of an autosave (V2_PLAN.md §9, M5).
//
// So the primary store is IndexedDB, which has no practical size limit here.
// localStorage stays for one job it is uniquely good at: a SYNCHRONOUS write
// during page teardown. IndexedDB cannot do that — its transactions do not
// complete once the tab is gone — so `pagehide` writes a small journal to
// localStorage and the next load prefers it if it is newer. A network too big
// for the journal simply skips it and relies on the debounced save, which is
// the same exposure the tool has always had.

const DB_NAME = "bike-network-builder";
const STORE = "state";
const JOURNAL_SUFFIX = "::journal";

export function idbAvailable() {
  try { return typeof indexedDB !== "undefined" && indexedDB !== null; }
  catch { return false; }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * A localStorage-shaped adapter (getItem/setItem) backed by IndexedDB, with a
 * synchronous localStorage journal for the teardown case.
 *
 * getItem/setItem return promises. `store.js` awaits them, and awaiting a
 * plain value is harmless, so a synchronous localStorage still works wherever
 * this is swapped in.
 */
export class IdbStorage {
  constructor({ local = globalThis.localStorage, journalMaxBytes = 2_000_000 } = {}) {
    this.local = local;
    this.journalMaxBytes = journalMaxBytes;
    this._db = null;
  }

  async _open() {
    if (!this._db) this._db = await openDb();
    return this._db;
  }

  async getItem(key) {
    let stored = null;
    try {
      stored = await idbRequest(await this._open(), "readonly", (s) => s.get(key));
    } catch { stored = null; }

    // A journal entry only exists when the tab went away mid-edit, and it is
    // by definition newer than what IndexedDB managed to write.
    const journal = this._readJournal(key);
    if (journal) {
      // Adopt it, then clear it, so a later crash-free session doesn't keep
      // resurrecting an old journal.
      try { await this.setItem(key, journal); } catch { /* keep going */ }
      this._clearJournal(key);
      return journal;
    }
    return stored ?? null;
  }

  async setItem(key, value) {
    const text = String(value);
    await idbRequest(await this._open(), "readwrite", (s) => s.put(text, key));
    this._clearJournal(key);
    return true;
  }

  // Synchronous, for `pagehide`. Best effort: a network too big for the
  // journal is skipped rather than throwing during teardown.
  writeJournal(key, value) {
    if (!this.local) return false;
    const text = String(value);
    if (text.length > this.journalMaxBytes) return false;
    try {
      this.local.setItem(key + JOURNAL_SUFFIX, text);
      return true;
    } catch { return false; }
  }

  _readJournal(key) {
    try { return this.local ? this.local.getItem(key + JOURNAL_SUFFIX) : null; }
    catch { return null; }
  }

  _clearJournal(key) {
    try { if (this.local) this.local.removeItem(key + JOURNAL_SUFFIX); }
    catch { /* nothing to do */ }
  }
}

/** A localStorage adapter with the same shape, for the fallback path. */
export class LocalStorageAdapter {
  constructor(local = globalThis.localStorage) { this.local = local; }
  getItem(key) { return this.local.getItem(key); }
  setItem(key, value) { return this.local.setItem(key, String(value)); }
  writeJournal(key, value) {
    try { this.local.setItem(key, String(value)); return true; }
    catch { return false; }
  }
}

// IndexedDB where it exists, localStorage otherwise — a private window with
// storage disabled still gets a working (if forgetful) editor.
export function pickStorage(opts = {}) {
  return idbAvailable() ? new IdbStorage(opts)
    : new LocalStorageAdapter(opts.local ?? globalThis.localStorage);
}
