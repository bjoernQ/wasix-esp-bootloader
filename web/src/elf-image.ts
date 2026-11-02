export type ImageOptions = {
  chip: string;
  mode: string;
  freq: string;
  size: string;
  sha256: boolean;
  minRev: number;
  minRevFull: number;
  maxRevFull: number;
  /** Pad with 0xFF to 4 KB so a Secure Boot V2 signature sector can be appended. */
  securePad: boolean;
};

const flashMode: Record<string, number> = { qio: 0, qout: 1, dio: 2, dout: 3 };
const flashFreq: Record<string, number> = { "40m": 0, "26m": 1, "20m": 2, "80m": 0xf };
const flashSize: Record<string, number> = { "1MB": 0, "2MB": 1, "4MB": 2, "8MB": 3, "16MB": 4, "32MB": 5, "64MB": 6, "128MB": 7 };

const progbits = new Set([1, 0x0e, 0x0f, 0x10]);

type Segment = { name: string; addr: number; data: Uint8Array };

export async function elfToImage(elf: Uint8Array, options: ImageOptions): Promise<Uint8Array> {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint32(0, true) !== 0x464c457f) throw new Error("clang did not write an ELF");
  const entry = view.getUint32(24, true);
  const sections = mergeAdjacent(loadSections(view, elf));
  if (!sections.length) throw new Error("bootloader ELF has no loadable sections");
  if (sections.length > 16) throw new Error(`bootloader ELF has ${sections.length} segments`);
  const segments = orderSegments(sections);
  const mode = flashMode[options.mode] ?? 2;
  const sizeFreq = ((flashSize[options.size] ?? 2) << 4) | (flashFreq[options.freq] ?? 0);
  const header = new Uint8Array(24);
  const head = new DataView(header.buffer);
  header[0] = 0xe9;
  header[1] = segments.length;
  header[2] = mode;
  header[3] = sizeFreq;
  head.setUint32(4, entry, true);
  header[8] = 0xee;
  head.setUint16(12, chipId(options.chip), true);
  header[14] = options.minRev & 0xff;
  head.setUint16(15, options.minRevFull, true);
  head.setUint16(17, options.maxRevFull, true);
  header[23] = options.sha256 ? 1 : 0;
  const body: Uint8Array[] = [header];
  let checksum = 0xef;
  for (const segment of segments) {
    const record = new Uint8Array(8 + segment.data.length);
    const rec = new DataView(record.buffer);
    rec.setUint32(0, segment.addr, true);
    rec.setUint32(4, segment.data.length, true);
    record.set(segment.data, 8);
    body.push(record);
    for (const byte of segment.data) checksum ^= byte;
  }
  let image = concat(body);
  const pad = new Uint8Array(15 - (image.length % 16));
  image = concat([image, pad, new Uint8Array([checksum & 0xff])]);
  if (options.sha256) {
    const bytes = new ArrayBuffer(image.byteLength);
    new Uint8Array(bytes).set(image);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    image = concat([image, digest]);
  }
  if (!options.securePad) return image;
  const extra = (4096 - (image.length % 4096)) % 4096;
  if (!extra) return image;
  const aligned = new Uint8Array(extra);
  aligned.fill(0xff);
  return concat([image, aligned]);
}

function loadSections(view: DataView, elf: Uint8Array): Segment[] {
  const shoff = view.getUint32(32, true);
  const shentsize = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  const shstrndx = view.getUint16(50, true);
  const names = section(view, elf, shoff, shentsize, shstrndx);
  const sections: Segment[] = [];
  for (let index = 0; index < shnum; index += 1) {
    const off = shoff + index * shentsize;
    const type = view.getUint32(off + 4, true);
    const addr = view.getUint32(off + 12, true);
    const offset = view.getUint32(off + 16, true);
    const size = view.getUint32(off + 20, true);
    if (!progbits.has(type) || addr === 0 || size === 0) continue;
    sections.push({
      name: cstring(names, view.getUint32(off, true)),
      addr,
      data: align(elf.slice(offset, offset + size), 4),
    });
  }
  return sections;
}

function mergeAdjacent(sections: Segment[]): Segment[] {
  if (!sections.length) return sections;
  const kept: Segment[] = [];
  for (let index = sections.length - 1; index > 0; index -= 1) {
    const elem = sections[index - 1];
    const next = sections[index];
    if (next.addr === elem.addr + elem.data.length) {
      const merged = new Uint8Array(elem.data.length + next.data.length);
      merged.set(elem.data);
      merged.set(next.data, elem.data.length);
      elem.data = merged;
    } else {
      kept.unshift(next);
    }
  }
  kept.unshift(sections[0]);
  return kept;
}

function orderSegments(sections: Segment[]): Segment[] {
  const sorted = [...sections].sort((a, b) => a.addr - b.addr);
  const index = sorted.findIndex((segment) => segment.name === ".dram0.bootdesc");
  if (index > 0) {
    const [boot] = sorted.splice(index, 1);
    sorted.unshift(boot);
  }
  return sorted;
}

function section(view: DataView, elf: Uint8Array, shoff: number, shentsize: number, index: number): Uint8Array {
  const off = shoff + index * shentsize;
  const offset = view.getUint32(off + 16, true);
  const size = view.getUint32(off + 20, true);
  return elf.slice(offset, offset + size);
}

function cstring(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function align(data: Uint8Array, boundary: number): Uint8Array {
  const extra = (boundary - (data.length % boundary)) % boundary;
  if (!extra) return data;
  const out = new Uint8Array(data.length + extra);
  out.set(data);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chipId(id: string): number {
  const ids: Record<string, number> = {
    esp32: 0, esp32s2: 2, esp32c3: 5, esp32s3: 9, esp32c2: 12, esp32c6: 13,
    esp32h2: 16, esp32p4: 18, esp32c61: 20, esp32c5: 23, esp32h21: 25, esp32h4: 28, esp32s31: 32,
  };
  return ids[id] ?? 0;
}
