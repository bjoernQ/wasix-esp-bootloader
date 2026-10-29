import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wasmer } from "@wasmer/sdk/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.resolve(here, "..", ".wasmer-cache");
const binary = readFileSync("\\\\wsl$\\Ubuntu\\opt\\esp-clang\\build-wasi\\bin\\clang-22");

const wasmer = new Wasmer({
  outputBytes: 4_000_000,
  cache: { directory: cache },
});
await wasmer.ready();
const clang = await wasmer.packages.load(binary);
console.log("commands", clang.commands, "entrypoint", clang.entrypoint);
const sandbox = await wasmer.sandboxes.create({
  packages: [clang],
  files: {
    "hello.c": new TextEncoder().encode("int add(int a, int b) { return a + b; }\n"),
  },
  network: { mode: "disabled" },
});

async function run(args) {
  const output = await sandbox.command(clang.command("main"), args).run({
    timeoutMs: 180_000,
    outputBytes: 4_000_000,
    check: false,
  });
  const text = `${output.stdout.text()}${output.stderr.text()}`;
  console.log(`\n$ clang ${args.join(" ")}\nexit ${output.exitCode} ${output.reason}\n${text}`);
  if (!output.ok) throw new Error(`clang failed: ${args.join(" ")}`);
  return text;
}

try {
  await run(["--version"]);
  const targets = await run(["-print-targets"]);
  if (!targets.includes("xtensa") || !targets.includes("riscv32")) {
    throw new Error("print-targets is missing xtensa or riscv32");
  }
  await run([
    "--target=riscv32-esp-unknown-elf",
    "-ffreestanding",
    "-nostdinc",
    "-c",
    "/workspace/hello.c",
    "-o",
    "/workspace/hello-rv.o",
  ]);
  await run([
    "--target=xtensa-esp-unknown-elf",
    "-ffreestanding",
    "-nostdinc",
    "-c",
    "/workspace/hello.c",
    "-o",
    "/workspace/hello-xt.o",
  ]);
  for (const name of ["hello-rv.o", "hello-xt.o"]) {
    const bytes = await sandbox.fs.readFile(`/workspace/${name}`);
    const machine = bytes[18] | (bytes[19] << 8);
    console.log(`${name} ${bytes.length} bytes e_machine ${machine}`);
  }
} finally {
  await sandbox.close();
  await wasmer.close();
}
