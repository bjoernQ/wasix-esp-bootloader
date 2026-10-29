import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wasmer } from "@wasmer/sdk/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cache = path.resolve(root, ".wasmer-cache");
const wsl = "\\\\wsl$\\Ubuntu\\opt\\esp-clang\\build-wasi\\bin";
const boot = path.join(root, "web", "public", "toolchain");

const chips = JSON.parse(readFileSync(path.join(boot, "bootloader", "chips.json"), "utf8"));
const only = process.argv[2];
const selected = only && only !== "all" ? chips.filter((item) => item.id === only) : chips;
const wasmer = new Wasmer({ outputBytes: 4_000_000, cache: { directory: cache } });
await wasmer.ready();
const python = await wasmer.packages.load("python/python");
const tools = await wasmer.packages.create({
  modules: {
    clang: readFileSync(path.join(wsl, "clang-22")),
    lld: readFileSync(path.join(wsl, "lld")),
  },
  commands: {
    clang: { module: "clang" },
    "ld.lld": { module: "lld" },
  },
});
const sandbox = await wasmer.sandboxes.create({
  packages: [python, tools],
  env: { PATH: "/bin:/usr/bin", PYTHONUNBUFFERED: "1" },
  files: {
    "bootloader/bootloader.c": readFileSync(path.join(boot, "bootloader", "bootloader.c")),
    "bootloader/chips.json": readFileSync(path.join(boot, "bootloader", "chips.json")),
    "esp-idf/tools/bootloader.py": readFileSync(path.join(boot, "esp-idf", "tools", "bootloader.py")),
  },
  network: { mode: "disabled" },
});

const outDir = path.resolve(root, "toolchain", "out", "bootloaders");
mkdirSync(outDir, { recursive: true });

async function build(extra) {
  const output = await sandbox.command(python.command("python"), [
    "-u", "/workspace/esp-idf/tools/bootloader.py",
    "--chips", "/workspace/bootloader/chips.json",
    "--source", "/workspace/bootloader/bootloader.c",
    "--out", "/workspace/bootloader.bin",
    ...extra,
  ]).run({ outputBytes: 4_000_000, timeoutMs: 180_000, check: false });
  const text = `${output.stdout.text()}${output.stderr.text()}`;
  if (!output.ok) {
    console.log(text);
    console.log("exit", output.exitCode);
    return null;
  }
  const bin = Buffer.from(await sandbox.fs.readFile("/workspace/bootloader.bin"));
  const entry = bin.readUInt32LE(4);
  const chipId = bin.readUInt16LE(12);
  console.log(text.trim());
  console.log(`image ${bin.length} magic ${bin[0].toString(16)} segs ${bin[1]} mode ${bin[2]} sizeFreq ${bin[3].toString(16)} chipId ${chipId} entry 0x${entry.toString(16)}`);
  return bin;
}

try {
  let failed = 0;
  for (const chip of selected) {
    const bin = await build(["--chip", chip.id, "--mode", "dio", "--freq", "40m", "--size", "4MB", "--log", "info"]);
    if (!bin || bin[0] !== 0xe9 || bin.readUInt16LE(12) !== chip.chipId) {
      failed++;
      console.log(`FAIL ${chip.id}`);
      continue;
    }
    const entry = bin.readUInt32LE(4);
    const iramEnd = chip.iramOrg + chip.iramLen;
    if (entry < chip.iramOrg || entry >= iramEnd) {
      failed++;
      console.log(`FAIL ${chip.id} entry 0x${entry.toString(16)} outside iram`);
      continue;
    }
    writeFileSync(path.join(outDir, `${chip.id}.bin`), bin);
    console.log(`OK ${chip.id}`);
  }
  if (!only || only === "esp32c3" || only === "all") {
    const changed = await build(["--chip", "esp32c3", "--mode", "qio", "--freq", "80m", "--size", "2MB", "--log", "error", "--rollback", "1", "--sha256", "1"]);
    if (!changed || changed[2] !== 0 || changed[3] !== ((1 << 4) | 0xf)) {
      failed++;
      console.log("FAIL option bytes");
    } else {
      console.log("OK option bytes");
    }
  }
  if (failed) process.exitCode = 1;
} finally {
  await sandbox.close();
  await wasmer.close();
}
