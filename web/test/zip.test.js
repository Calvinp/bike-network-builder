// Tests for the dependency-free zip writer/reader.
import test from "node:test";
import assert from "node:assert/strict";
import { crc32, zipCreate, zipRead } from "../js/zip.js";

test("crc32 of known vector", () => {
  // CRC-32 of ASCII "123456789" is the classic check value 0xCBF43926.
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xCBF43926);
});

test("zip roundtrip preserves names and contents", async () => {
  const bytes = await zipCreate([
    { name: "network.yaml", data: "format: malden-bike-network\n" },
    { name: "nested/data.bin", data: new Uint8Array([0, 1, 2, 255]) },
    { name: "unicode – name.txt", data: "héllo ➤" },
  ]);
  assert.equal(bytes[0], 0x50); // "PK"
  assert.equal(bytes[1], 0x4B);
  const entries = await zipRead(bytes);
  assert.deepEqual(entries.map((e) => e.name).sort(),
    ["nested/data.bin", "network.yaml", "unicode – name.txt"]);
  const yaml = entries.find((e) => e.name === "network.yaml");
  assert.equal(yaml.text(), "format: malden-bike-network\n");
  const bin = entries.find((e) => e.name === "nested/data.bin");
  assert.deepEqual([...bin.bytes], [0, 1, 2, 255]);
  const uni = entries.find((e) => e.name === "unicode – name.txt");
  assert.equal(uni.text(), "héllo ➤");
});

test("zip roundtrip compresses compressible payloads", async () => {
  const big = "corridor ".repeat(10_000);
  const bytes = await zipCreate([{ name: "big.txt", data: big }]);
  assert.ok(bytes.length < big.length / 4, `zip is ${bytes.length} bytes`);
  const [entry] = await zipRead(bytes);
  assert.equal(entry.text(), big);
});

test("zipRead rejects non-zip bytes", async () => {
  await assert.rejects(() => zipRead(new TextEncoder().encode("not a zip at all")));
});
