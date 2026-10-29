import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { elfToImage, type ImageOptions } from "../src/elf-image.ts";

type Section = { name: string; type: number; addr: number; data: number[] };

/** Minimal little-endian ELF32 with section headers only. */
function elf(entry: number, sections: Section[]): Uint8Array {
  const names = ["", ".shstrtab", ...sections.map((section) => section.name)];
  let strtab = "";
  const nameOffsets = names.map((name) => {
    const at = strtab.length;
    strtab += `${name}\0`;
    return at;
  });
  const strBytes = new TextEncoder().encode(strtab);
  const bodies = [strBytes, ...sections.map((section) => Uint8Array.from(section.data))];
  let offset = 52;
  const offsets = bodies.map((body) => {
    const at = offset;
    offset += body.length;
    return at;
  });
  const shoff = (offset + 3) & ~3;
  const shnum = names.length;
  const out = new Uint8Array(shoff + shnum * 40);
  const view = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  view.setUint16(16, 2, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, entry, true);
  view.setUint32(32, shoff, true);
  view.setUint16(40, 52, true);
  view.setUint16(46, 40, true);
  view.setUint16(48, shnum, true);
  view.setUint16(50, 1, true);
  bodies.forEach((body, index) => out.set(body, offsets[index]));
  const header = (index: number, type: number, addr: number, at: number, size: number) => {
    const base = shoff + index * 40;
    view.setUint32(base, nameOffsets[index] ?? 0, true);
    view.setUint32(base + 4, type, true);
    view.setUint32(base + 12, addr, true);
    view.setUint32(base + 16, at, true);
    view.setUint32(base + 20, size, true);
  };
  header(1, 3, 0, offsets[0] ?? 0, strBytes.length);
  sections.forEach((section, index) => header(index + 2, section.type, section.addr, offsets[index + 1] ?? 0, section.data.length));
  return out;
}

const sample = elf(0x40380010, [
  { name: ".iram_loader.text", type: 1, addr: 0x40380000, data: [1, 2, 3, 4, 5, 6] },
  { name: ".bss", type: 8, addr: 0x3fcd8000, data: [] },
  { name: ".dram0.bootdesc", type: 1, addr: 0x3fcd0000, data: [9, 9, 9, 9, 7, 7, 7, 7] },
  { name: ".dram0.data", type: 1, addr: 0x3fcd0008, data: [0xaa, 0xbb, 0xcc, 0xdd] },
]);

function options(overrides: Partial<ImageOptions> = {}): ImageOptions {
  return { chip: "esp32c3", mode: "dio", freq: "40m", size: "4MB", sha256: true, minRev: 3, minRevFull: 3, maxRevFull: 199, securePad: false, ...overrides };
}

test("header, segments, checksum and digest", async () => {
  const image = await elfToImage(sample, options());
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  assert.equal(image[0], 0xe9);
  assert.equal(image[1], 2, "adjacent bootdesc and data merge, bss is dropped");
  assert.equal(image[2], 2);
  assert.equal(image[3], (2 << 4) | 0x0);
  assert.equal(view.getUint32(4, true), 0x40380010);
  assert.equal(image[8], 0xee);
  assert.equal(view.getUint16(12, true), 5);
  assert.equal(image[14], 3);
  assert.equal(view.getUint16(15, true), 3);
  assert.equal(view.getUint16(17, true), 199);
  assert.equal(image[23], 1);
  assert.equal(view.getUint32(24, true), 0x3fcd0000, "bootdesc comes first");
  assert.equal(view.getUint32(28, true), 12);
  const body = image.subarray(0, image.length - 32);
  assert.equal(body.length % 16, 0);
  let checksum = 0xef;
  for (const byte of [9, 9, 9, 9, 7, 7, 7, 7, 0xaa, 0xbb, 0xcc, 0xdd, 1, 2, 3, 4, 5, 6, 0, 0]) checksum ^= byte;
  assert.equal(body[body.length - 1], checksum);
  assert.deepEqual(Buffer.from(image.subarray(image.length - 32)), createHash("sha256").update(body).digest());
});

test("flash clock nibble follows esptool per chip", async () => {
  const nibble = async (chip: string, freq: string) => ((await elfToImage(sample, options({ chip, freq })))[3] ?? 0) & 0xf;
  assert.equal(await nibble("esp32", "80m"), 0xf);
  assert.equal(await nibble("esp32", "26m"), 0x1);
  assert.equal(await nibble("esp32c6", "80m"), 0x0);
  assert.equal(await nibble("esp32c2", "60m"), 0xf);
  assert.equal(await nibble("esp32c2", "20m"), 0x1);
  assert.equal(await nibble("esp32h2", "64m"), 0xf);
  assert.equal(await nibble("esp32h2", "16m"), 0x2);
  await assert.rejects(elfToImage(sample, options({ chip: "esp32h2", freq: "40m" })), /does not support/);
});

test("no digest without SHA-256, secure padding to 4 KB", async () => {
  const plain = await elfToImage(sample, options({ sha256: false }));
  assert.equal(plain[23], 0);
  assert.equal(plain.length % 16, 0);
  const padded = await elfToImage(sample, options({ securePad: true }));
  assert.equal(padded.length, 4096);
  assert.equal(padded[padded.length - 1], 0xff);
});
