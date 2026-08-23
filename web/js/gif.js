// A minimal animated-GIF encoder (GIF89a + LZW), so the static editor can
// export the phase animation the desktop tool builds with Pillow. Pure
// computation — no DOM — so it is node-testable like the rest of web/js.
//
// One GLOBAL palette is built from all frames together (median cut over a
// 5-bit-per-channel histogram) and every frame is indexed against it: frames
// then share colors exactly, which is what keeps a map animation from
// shimmering as it plays.

const MAX_COLORS = 256;

// Pack a color into the 15-bit histogram key used for median cut.
const key15 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

function histogram(frames) {
  const counts = new Map();       // key15 -> {n, r, g, b} (summed channels)
  for (const data of frames) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = key15(r, g, b);
      const e = counts.get(k);
      if (e) { e.n++; e.r += r; e.g += g; e.b += b; }
      else counts.set(k, { n: 1, r, g, b });
    }
  }
  return [...counts.values()];
}

// Median cut: repeatedly split the box with the widest channel range until we
// have `maxColors` boxes, then average each box.
function medianCut(entries, maxColors) {
  if (!entries.length) return [[0, 0, 0]];
  const boxOf = (items) => {
    let rlo = 255, rhi = 0, glo = 255, ghi = 0, blo = 255, bhi = 0, n = 0;
    for (const e of items) {
      const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
      if (r < rlo) rlo = r; if (r > rhi) rhi = r;
      if (g < glo) glo = g; if (g > ghi) ghi = g;
      if (b < blo) blo = b; if (b > bhi) bhi = b;
      n += e.n;
    }
    const ranges = [rhi - rlo, ghi - glo, bhi - blo];
    const channel = ranges.indexOf(Math.max(...ranges));
    return { items, n, range: Math.max(...ranges), channel };
  };

  let boxes = [boxOf(entries)];
  while (boxes.length < maxColors) {
    // Split the box that is both wide and populous; stop when none can split.
    let bi = -1, best = 0;
    boxes.forEach((b, i) => {
      if (b.items.length < 2) return;
      const score = b.range * Math.log2(b.n + 1);
      if (score > best) { best = score; bi = i; }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    const ch = box.channel;
    const val = (e) => (ch === 0 ? e.r : ch === 1 ? e.g : e.b) / e.n;
    const sorted = [...box.items].sort((a, b) => val(a) - val(b));
    // Split at the median by pixel count, not by entry count.
    const half = box.n / 2;
    let acc = 0, cut = 0;
    for (; cut < sorted.length - 1; cut++) {
      acc += sorted[cut].n;
      if (acc >= half) break;
    }
    boxes.splice(bi, 1, boxOf(sorted.slice(0, cut + 1)),
                        boxOf(sorted.slice(cut + 1)));
  }

  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const e of b.items) { r += e.r; g += e.g; bl += e.b; n += e.n; }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(bl / n)]
             : [0, 0, 0];
  });
}

function indexer(palette) {
  const cache = new Map();        // key15 -> palette index
  return (r, g, b) => {
    const k = key15(r, g, b);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(k, best);
    return best;
  };
}

// GIF's variable-width LZW, emitted least-significant-bit first and chopped
// into the 255-byte sub-blocks the format requires.
function lzwEncode(indices, minCodeSize) {
  const out = [];
  let cur = 0, curBits = 0;
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = eoiCode + 1;
  let dict = new Map();

  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };
  const reset = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    next = eoiCode + 1;
  };

  emit(clearCode);
  reset();
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = prefix * 4096 + k;
    const found = dict.get(combined);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(combined, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      reset();
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) out.push(cur & 0xff);

  // Sub-blocks: [length][up to 255 bytes] ... [0]
  const blocks = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return blocks;
}

/**
 * Encode frames into an animated GIF.
 *
 * @param {Array<Uint8ClampedArray|Uint8Array>} frames RGBA pixels, width*height*4 each.
 * @param {object} opts width, height, delays (ms, per frame), loop (0 = forever).
 * @returns {Uint8Array} the GIF bytes.
 */
export function encodeGif(frames, { width, height, delays = [], loop = 0 } = {}) {
  if (!frames.length) throw new Error("encodeGif: no frames");
  for (const f of frames) {
    if (f.length !== width * height * 4) {
      throw new Error("encodeGif: every frame must be width*height*4 RGBA bytes");
    }
  }

  const palette = medianCut(histogram(frames), MAX_COLORS);
  const toIndex = indexer(palette);
  const bytes = [];
  const push = (...v) => bytes.push(...v);
  const short = (v) => push(v & 0xff, (v >> 8) & 0xff);

  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);          // "GIF89a"
  short(width); short(height);
  // Global color table: 2^(n+1) entries, so pad the palette to a power of two.
  let tableBits = 1;
  while ((1 << (tableBits + 1)) < palette.length) tableBits++;
  const tableSize = 1 << (tableBits + 1);
  push(0x80 | tableBits, 0, 0);                      // GCT flag | size, bg, ratio
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    push(c[0], c[1], c[2]);
  }

  // NETSCAPE2.0 application extension = loop forever.
  push(0x21, 0xff, 0x0b);
  push(...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)));
  push(0x03, 0x01);
  short(loop);
  push(0x00);

  frames.forEach((data, i) => {
    const delayCs = Math.max(1, Math.round((delays[i] ?? 1000) / 10));
    push(0x21, 0xf9, 0x04, 0x00);                    // GCE, no transparency
    short(delayCs);
    push(0x00, 0x00);

    push(0x2c);                                      // image descriptor
    short(0); short(0); short(width); short(height);
    push(0x00);                                      // no local table, no interlace

    const indices = new Uint8Array(width * height);
    for (let p = 0, q = 0; q < data.length; p++, q += 4) {
      indices[p] = toIndex(data[q], data[q + 1], data[q + 2]);
    }
    push(0x08);                                      // LZW minimum code size
    push(...lzwEncode(indices, 8));
  });

  push(0x3b);                                        // trailer
  return Uint8Array.from(bytes);
}
