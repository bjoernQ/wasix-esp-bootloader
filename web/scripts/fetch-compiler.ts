// Downloads the WebAssembly clang and ld.lld into public/toolchain/bin and checks their SHA-256.
// The binaries are built by toolchain/build-esp-clang.sh and published as GitHub release assets.
// COMPILER_BASE_URL overrides where they are downloaded from.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const release = "https://github.com/bjoernQ/wasix-esp-bootloader/releases/download/compiler-v1";
const files: Record<string, string> = {
  clang: "485f0aa0126c022db9e96e81510a954102b44623fbbcb01462ee990fc71de2d3",
  lld: "6262ac239622de9f1ebb446e7180485da8e47230a6634158f2bcf6b340cb420d",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(here, "..", "public", "toolchain", "bin");
const baseUrl = (process.env.COMPILER_BASE_URL ?? release).replace(/\/$/, "");

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

mkdirSync(binDir, { recursive: true });
for (const [name, expected] of Object.entries(files)) {
  const target = path.join(binDir, name);
  if (existsSync(target) && (await sha256File(target)) === expected) {
    console.log(`${name} is up to date`);
    continue;
  }
  const url = `${baseUrl}/${name}`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`${name}: SHA-256 is ${actual}, expected ${expected}`);
  const partial = `${target}.partial`;
  await writeFile(partial, data);
  rmSync(target, { force: true });
  renameSync(partial, target);
  console.log(`${name} ${data.length} bytes, SHA-256 ok`);
}
