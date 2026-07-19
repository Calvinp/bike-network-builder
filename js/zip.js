// Minimal zip writer/reader with no dependencies: DEFLATE via the browser's
// (and Node's) native CompressionStream / DecompressionStream, falling back to
// STORE when unavailable. Enough for the export bundle and for importing
// arbitrary everyday zips (central-directory driven; no encryption, no zip64).

const te = new TextEncoder();
const td = new TextDecoder();

/* ------------------------------- CRC32 ---------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------- (de)compression seams ------------------------ */
async function pipeThrough(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  const buf = await new Response(out).arrayBuffer();
  return new Uint8Array(buf);
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined") return null; // caller stores
  return pipeThrough(bytes, new CompressionStream("deflate-raw"));
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("this browser can't decompress zip entries");
  }
  return pipeThrough(bytes, new DecompressionStream("deflate-raw"));
}

/* -------------------------------- writer -------------------------------- */
class ByteSink {
  constructor() { this.parts = []; this.length = 0; }
  push(bytes) { this.parts.push(bytes); this.length += bytes.length; }
  pushU16(v) { this.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF])); }
  pushU32(v) {
    this.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF,
                              (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]));
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

// entries: [{name, data: Uint8Array | string}]. Returns the zip as Uint8Array.
export async function zipCreate(entries) {
  const sink = new ByteSink();
  const central = [];
  for (const entry of entries) {
    const data = typeof entry.data === "string" ? te.encode(entry.data) : entry.data;
    const name = te.encode(entry.name);
    const crc = crc32(data);
    let method = 8;
    let comp = await deflateRaw(data);
    if (!comp || comp.length >= data.length) { method = 0; comp = data; }
    const offset = sink.length;
    sink.pushU32(0x04034B50);          // local file header
    sink.pushU16(20); sink.pushU16(0x0800); sink.pushU16(method);
    sink.pushU16(0); sink.pushU16(0);  // dos time/date: zero
    sink.pushU32(crc); sink.pushU32(comp.length); sink.pushU32(data.length);
    sink.pushU16(name.length); sink.pushU16(0);
    sink.push(name); sink.push(comp);
    central.push({ name, method, crc, compLen: comp.length,
                   rawLen: data.length, offset });
  }
  const cdStart = sink.length;
  for (const c of central) {
    sink.pushU32(0x02014B50);          // central directory header
    sink.pushU16(20); sink.pushU16(20); sink.pushU16(0x0800); sink.pushU16(c.method);
    sink.pushU16(0); sink.pushU16(0);
    sink.pushU32(c.crc); sink.pushU32(c.compLen); sink.pushU32(c.rawLen);
    sink.pushU16(c.name.length); sink.pushU16(0); sink.pushU16(0);
    sink.pushU16(0); sink.pushU16(0); sink.pushU32(0);
    sink.pushU32(c.offset);
    sink.push(c.name);
  }
  const cdLen = sink.length - cdStart;
  sink.pushU32(0x06054B50);            // end of central directory
  sink.pushU16(0); sink.pushU16(0);
  sink.pushU16(central.length); sink.pushU16(central.length);
  sink.pushU32(cdLen); sink.pushU32(cdStart);
  sink.pushU16(0);
  return sink.bytes();
}

/* -------------------------------- reader -------------------------------- */
// Returns [{name, bytes: Uint8Array, text()}] for every file entry.
export async function zipRead(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the end-of-central-directory record (search backwards; the comment
  // can push it up to 64 KB from the end).
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory)");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);

  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014B50) {
      throw new Error("corrupt zip central directory");
    }
    const method = dv.getUint16(off + 10, true);
    const compLen = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = td.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    // The local header repeats name/extra with possibly different extra length.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compLen);
    if (!name.endsWith("/")) {
      let raw;
      if (method === 0) raw = comp;
      else if (method === 8) raw = await inflateRaw(comp);
      else throw new Error(`unsupported zip compression method ${method} in ${name}`);
      entries.push({ name, bytes: raw, text: () => td.decode(raw) });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
