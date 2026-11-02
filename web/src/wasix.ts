import { Wasmer, type Package, type Wasmer as WasmerClient } from "@wasmer/sdk";
import { bootloader, examples, toolchain } from "virtual:project-files";

const PACKAGES = [
  "python/python@=3.13.20",
  "wasmer/bash@=1.0.25",
  "wasmer/coreutils@=1.0.27",
];

let client: WasmerClient | null = null;
let runtime: Package[] | null = null;

export function exampleFiles(exampleId: string): Record<string, string> {
  const prefix = `${exampleId}/`;
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(examples)) {
    if (name.startsWith(prefix) && !name.includes("/build/")) {
      files[name.slice(prefix.length)] = text;
    }
  }
  if (!files["CMakeLists.txt"]) throw new Error(`example ${exampleId} is missing`);
  return files;
}

export function projectName(files: Record<string, string>): string {
  const cmake = files["CMakeLists.txt"] ?? "";
  const match = cmake.match(/project\(([^)]+)\)/);
  const name = match?.[1]?.trim().split(/\s+/)[0];
  if (!name) throw new Error("CMakeLists.txt has no project()");
  return name;
}

export async function buildInWasix(
  project: Record<string, string>,
  log: (line: string) => void,
): Promise<Uint8Array> {
  if (!crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the WASIX runtime cannot start. Use the dev server or vite preview.");
  }
  client ??= new Wasmer({ outputBytes: 4_000_000 });
  await client.ready();
  runtime ??= await client.packages.loadMany(PACKAGES);
  const [pythonPkg, bashPkg, coreutilsPkg] = runtime;
  if (!pythonPkg || !bashPkg || !coreutilsPkg) throw new Error("WASIX packages did not load");
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(toolchain)) files[`esp-idf/${name}`] = text;
  for (const [name, text] of Object.entries(project)) files[`project/${name}`] = text;
  log("Opening the WASIX sandbox (Python, Bash, coreutils)…");
  let lastProgress = "";
  const sandbox = await client.sandboxes.create({
    packages: [pythonPkg, bashPkg, coreutilsPkg],
    files,
    env: { PYTHONUNBUFFERED: "1" },
    network: { mode: "disabled" },
    onPackageProgress(progress) {
      const percent = progress.download.percent;
      const line = `packages ${progress.phase}${percent == null ? "" : ` ${percent}%`}`;
      if (line !== lastProgress) {
        lastProgress = line;
        log(line);
      }
    },
  });
  try {
    const shell = await sandbox.command(bashPkg.command("bash"), ["-c", "echo wasix-shell"]).run();
    log(shell.stdout.text().trim());
    log("python idf.py -C project build");
    const output = await sandbox
      .command(pythonPkg.command("python"), ["-u", "/workspace/esp-idf/tools/idf.py", "-C", "/workspace/project", "build"])
      .run({ outputBytes: 2_000_000, timeoutMs: 180_000 });
    const stdout = output.stdout.text();
    const stderr = output.stderr.text();
    if (stdout) log(stdout.trimEnd());
    if (stderr) log(stderr.trimEnd());
    const name = projectName(project);
    const bin = await sandbox.fs.readFile(`/workspace/project/build/${name}.bin`);
    if (bin[0] !== 0xe9) throw new Error("build did not write an ESP32 image");
    log(`Image ${bin.length} bytes, flash at 0x1000.`);
    return bin;
  } finally {
    await sandbox.close();
  }
}

export type BootOptions = {
  chip: string;
  mode: string;
  freq: string;
  size: string;
  logLevel: string;
  baud: number;
  rollback: boolean;
  sha256: boolean;
  resetGpio: number;
  partition: string;
  secureBoot: boolean;
  /** ESP32 Secure Boot V1 verification public key, hex. Unused on other chips. */
  verifyKey: string;
  encryption: "off" | "development" | "release";
};

let compiler: Package | null = null;
let pythonPkgCache: Package | null = null;

export async function buildBootloader(options: BootOptions, log: (line: string) => void): Promise<Uint8Array> {
  if (!crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the WASIX runtime cannot start. Use the dev server or vite preview.");
  }
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(options.partition)) {
    throw new Error("Partition offset must be a decimal or 0x hex number.");
  }
  client ??= new Wasmer({ outputBytes: 4_000_000 });
  await client.ready();
  pythonPkgCache ??= await client.packages.load("python/python@=3.13.20");
  const pythonPkg = pythonPkgCache;
  if (!compiler) {
    log("Loading clang and ld.lld (about 180 MB, kept for this session)…");
    const [clang, lld] = await Promise.all([
      fetchBytes("/toolchain/bin/clang", log),
      fetchBytes("/toolchain/bin/lld", log),
    ]);
    compiler = await client.packages.create({
      modules: { clang, lld },
      commands: {
        clang: { module: "clang" },
        "ld.lld": { module: "lld" },
      },
    });
  }
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(toolchain)) files[`esp-idf/${name}`] = text;
  for (const [name, text] of Object.entries(bootloader)) files[`bootloader/${name}`] = text;
  const sandbox = await client.sandboxes.create({
    packages: [pythonPkg, compiler],
    files,
    env: { PATH: "/bin:/usr/bin", PYTHONUNBUFFERED: "1" },
    network: { mode: "disabled" },
  });
  try {
    const args = [
      "-u", "/workspace/esp-idf/tools/bootloader.py",
      "--chip", options.chip,
      "--mode", options.mode,
      "--freq", options.freq,
      "--size", options.size,
      "--log", options.logLevel,
      "--baud", String(options.baud),
      "--rollback", options.rollback ? "1" : "0",
      "--sha256", options.sha256 ? "1" : "0",
      "--reset-gpio", String(options.resetGpio),
      "--partition", options.partition,
      "--chips", "/workspace/bootloader/chips.json",
      "--source", "/workspace/bootloader/bootloader.c",
      "--out", "/workspace/bootloader.bin",
    ];
    log(`python ${args.slice(1).join(" ")}`);
    const output = await sandbox.command(pythonPkg.command("python"), args).run({
      outputBytes: 4_000_000,
      timeoutMs: 180_000,
      check: false,
    });
    const stdout = output.stdout.text();
    const stderr = output.stderr.text();
    if (stdout) log(stdout.trimEnd());
    if (stderr) log(stderr.trimEnd());
    if (!output.ok) throw new Error(`build failed (${output.exitCode})`);
    const bin = await sandbox.fs.readFile("/workspace/bootloader.bin");
    if (bin[0] !== 0xe9) throw new Error("build did not write an ESP image");
    return bin;
  } finally {
    await sandbox.close();
  }
}

async function fetchBytes(url: string, log: (line: string) => void): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url} (${response.status}). The compiler files belong in web/public/toolchain/bin/.`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  let reported = -1;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.length;
    const percent = length > 0 ? Math.floor((received / length) * 100) : received;
    if (percent >= reported + 10) {
      reported = percent;
      log(length > 0 ? `${url} ${percent}%` : `${url} ${received} bytes`);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
