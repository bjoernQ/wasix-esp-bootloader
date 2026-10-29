import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wasmer } from "@wasmer/sdk/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.resolve(here, "..", ".wasmer-cache");

function walk(dir, prefix = "") {
  const out = {};
  for (const name of readdirSync(dir)) {
    if (name === "build" || name === "__pycache__" || name.endsWith(".pyc")) continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = readFileSync(full);
  }
  return out;
}

const example = process.argv[2] ?? "hello_world";
const toolchain = walk(path.join(here, "public", "toolchain", "esp-idf"));
const project = walk(path.join(here, "public", "examples", example));
const files = {};
for (const [name, data] of Object.entries(toolchain)) files[`esp-idf/${name}`] = data;
for (const [name, data] of Object.entries(project)) files[`project/${name}`] = data;

const wasmer = new Wasmer({
  outputBytes: 2_000_000,
  cache: { directory: cache },
});
await wasmer.ready();
const [pythonPkg, bashPkg, coreutilsPkg] = await wasmer.packages.loadMany([
  "python/python@=3.13.20",
  "wasmer/bash@=1.0.25",
  "wasmer/coreutils@=1.0.27",
]);
const sandbox = await wasmer.sandboxes.create({
  packages: [pythonPkg, bashPkg, coreutilsPkg],
  files,
  env: { PYTHONUNBUFFERED: "1" },
  network: { mode: "disabled" },
  onPackageProgress(progress) {
    const percent = progress.download.percent;
    console.log(`packages ${progress.phase}${percent == null ? "" : ` ${percent}%`}`);
  },
});

try {
  const shell = await sandbox.command(bashPkg.command("bash"), ["-c", "echo wasix-shell && ls /workspace/esp-idf/tools"]).run();
  console.log(shell.stdout.text());
  const output = await sandbox
    .command(pythonPkg.command("python"), ["-u", "/workspace/esp-idf/tools/idf.py", "-C", "/workspace/project", "build"])
    .run({ outputBytes: 2_000_000, timeoutMs: 180_000 });
  console.log(output.stdout.text());
  console.log(output.stderr.text());
  const cmake = Buffer.from(project["CMakeLists.txt"]).toString("utf8");
  const name = cmake.match(/project\(([^)]+)\)/)?.[1]?.trim().split(/\s+/)[0];
  if (!name) throw new Error("project() missing");
  const bin = await sandbox.fs.readFile(`/workspace/project/build/${name}.bin`);
  if (bin[0] !== 0xe9) throw new Error(`bad magic ${bin[0]}`);
  console.log(`wasix image ${bin.length} bytes`);
} finally {
  await sandbox.close();
  await wasmer.close();
}
