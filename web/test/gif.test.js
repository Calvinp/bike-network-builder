// Tests for the animated-GIF encoder. These decode the bytes back (header,
// palette, LZW) and compare pixels — a structural check alone would miss the
// bit-packing and dictionary-reset bugs LZW is prone to.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeGif } from "../js/gif.js";

/* ------------------------- a minimal GIF reader ------------------------- */

function decodeGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => { const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; };

  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), "GIF89a");
  p = 6;
  const width = u16(), height = u16();
  const packed = u8();
  u8(); u8();                                   // background, aspect ratio
  assert.ok(packed & 0x80, "expected a global color table");
  const tableSize = 1 << ((packed & 0x07) + 1);
  const palette = [];
  for (let i = 0; i < tableSize; i++) palette.push([u8(), u8(), u8()]);

  const readSubBlocks = () => {
    const out = [];
    for (;;) {
      const n = u8();
      if (!n) break;
      for (let i = 0; i < n; i++) out.push(u8());
    }
    return out;
  };

  const frames = [];
  let loop = null;
  let delay = null;
  for (;;) {
    const sep = u8();
    if (sep === 0x3b) break;                    // trailer
    if (sep === 0x21) {                         // extension
      const label = u8();
      if (label === 0xf9) {                     // graphic control
        assert.equal(u8(), 4);
        u8();
        delay = u16() * 10;                     // centiseconds -> ms
        u8(); u8();
      } else if (label === 0xff) {              // application
        const n = u8();
        const name = String.fromCharCode(...bytes.slice(p, p + n));
        p += n;
        const sub = readSubBlocks();
        if (name === "NETSCAPE2.0") loop = sub[1] | (sub[2] << 8);
      } else {
        readSubBlocks();
      }
      continue;
    }
    assert.equal(sep, 0x2c, "expected an image descriptor");
    u16(); u16();                               // left, top
    const fw = u16(), fh = u16();
    assert.equal(u8() & 0x80, 0, "did not expect a local color table");
    const minCodeSize = u8();
    const data = readSubBlocks();
    frames.push({ width: fw, height: fh, delay,
                  indices: lzwDecode(data, minCodeSize, fw * fh) });
  }
  return { width, height, palette, frames, loop };
}

function lzwDecode(bytes, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let dict = [];
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push(null, null);                      // clear, EOI placeholders
  };
  resetDict();

  let codeSize = minCodeSize + 1;
  let bit = 0;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = bytes[bit >> 3];
      if (byte === undefined) return eoiCode;
      code |= ((byte >> (bit & 7)) & 1) << i;
      bit++;
    }
    return code;
  };

  const out = [];
  let prev = null;
  for (;;) {
    const code = readCode();
    if (code === eoiCode) break;
    if (code === clearCode) {
      resetDict();
      codeSize = minCodeSize + 1;
      prev = null;
      continue;
    }
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error("bad LZW stream");
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
    if (out.length >= pixelCount) break;
  }
  return out;
}

/* -------------------------------- tests --------------------------------- */

function solidFrame(w, h, [r, g, b]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return data;
}

test("encodes a header, a loop extension and one image per frame", () => {
  const bytes = encodeGif(
    [solidFrame(4, 3, [255, 0, 0]), solidFrame(4, 3, [0, 0, 255])],
    { width: 4, height: 3, delays: [500, 1500] });
  const gif = decodeGif(bytes);
  assert.equal(gif.width, 4);
  assert.equal(gif.height, 3);
  assert.equal(gif.frames.length, 2);
  assert.equal(gif.loop, 0);                    // loop forever
  assert.equal(bytes[bytes.length - 1], 0x3b);  // trailer
});

test("round-trips solid frames to the right colors", () => {
  const red = [255, 0, 0], blue = [0, 0, 255];
  const bytes = encodeGif([solidFrame(8, 8, red), solidFrame(8, 8, blue)],
                          { width: 8, height: 8, delays: [100, 100] });
  const gif = decodeGif(bytes);
  for (const [i, want] of [[0, red], [1, blue]]) {
    const idx = gif.frames[i].indices;
    assert.equal(idx.length, 64);
    assert.ok(idx.every((v) => v === idx[0]), "a solid frame is one index");
    assert.deepEqual(gif.palette[idx[0]], want);
  }
});

test("per-frame delays survive as centiseconds", () => {
  const bytes = encodeGif([solidFrame(2, 2, [1, 2, 3]), solidFrame(2, 2, [4, 5, 6])],
                          { width: 2, height: 2, delays: [2000, 3000] });
  const gif = decodeGif(bytes);
  assert.deepEqual(gif.frames.map((f) => f.delay), [2000, 3000]);
});

test("many-colored frames stay close after quantization", () => {
  // A gradient has far more than 256 colors, so this exercises median cut and
  // the nearest-color mapping, not just the happy path.
  const w = 64, h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x * 4; data[i + 1] = y * 4; data[i + 2] = 128; data[i + 3] = 255;
    }
  }
  const gif = decodeGif(encodeGif([data], { width: w, height: h, delays: [100] }));
  const idx = gif.frames[0].indices;
  assert.equal(idx.length, w * h);
  let worst = 0;
  for (let p = 0; p < idx.length; p++) {
    const got = gif.palette[idx[p]];
    const q = p * 4;
    worst = Math.max(worst, Math.abs(got[0] - data[q]),
                     Math.abs(got[1] - data[q + 1]),
                     Math.abs(got[2] - data[q + 2]));
  }
  assert.ok(worst <= 16, `quantization error too large: ${worst}`);
});

test("rejects frames whose size does not match", () => {
  assert.throws(() => encodeGif([new Uint8ClampedArray(3)], { width: 2, height: 2 }),
                /width\*height\*4/);
});
