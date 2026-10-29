import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wasmer } from "@wasmer/sdk/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.resolve(here, "..", ".wasmer-cache");
const wsl = "\\\\wsl$\\Ubuntu\\opt\\esp-clang";

function file(rel, bytesPath) {
  return { [rel]: readFileSync(bytesPath) };
}

const hello = new TextEncoder().encode(`int puts(const char *);
int main(void) {
  return puts("hi");
}
`);

const rvRoot = `${wsl}\\sysroots\\riscv32-esp-elf`;
const xtRoot = `${wsl}\\sysroots\\xtensa-esp-elf`;
const files = {
  "hello.c": hello,
  "xtensa.ld": new TextEncoder().encode(`SECTIONS {
  .text : {
    *(.literal .literal.*)
    *(.init.literal .init)
    *(.text .text.*)
    *(.fini.literal .fini)
  }
  .data : { *(.data .data.* .rodata .rodata.*) }
  .bss : {
    *(.bss .bss.*)
    *(COMMON)
  }
  PROVIDE(end = .);
  PROVIDE(_end = .);
}
`),
  ...file("rv/lib/crt0.o", `${rvRoot}\\riscv32-esp-elf\\lib\\crt0.o`),
  ...file("rv/lib/crtbegin.o", `${rvRoot}\\lib\\gcc\\riscv32-esp-elf\\16.1.0\\crtbegin.o`),
  ...file("rv/lib/crtend.o", `${rvRoot}\\lib\\gcc\\riscv32-esp-elf\\16.1.0\\crtend.o`),
  ...file("rv/lib/libc.a", `${rvRoot}\\riscv32-esp-elf\\lib\\libc.a`),
  ...file("rv/lib/libgcc.a", `${rvRoot}\\lib\\gcc\\riscv32-esp-elf\\16.1.0\\libgcc.a`),
  ...file("rv/lib/libnosys.a", `${rvRoot}\\riscv32-esp-elf\\lib\\libnosys.a`),
  ...file("xt/lib/crt0.o", `${xtRoot}\\xtensa-esp-elf\\lib\\esp32\\crt0.o`),
  ...file("xt/lib/crti.o", `${xtRoot}\\lib\\gcc\\xtensa-esp-elf\\16.1.0\\esp32\\crti.o`),
  ...file("xt/lib/crtn.o", `${xtRoot}\\lib\\gcc\\xtensa-esp-elf\\16.1.0\\esp32\\crtn.o`),
  ...file("xt/lib/crtbegin.o", `${xtRoot}\\lib\\gcc\\xtensa-esp-elf\\16.1.0\\esp32\\crtbegin.o`),
  ...file("xt/lib/crtend.o", `${xtRoot}\\lib\\gcc\\xtensa-esp-elf\\16.1.0\\esp32\\crtend.o`),
  ...file("xt/lib/libc.a", `${xtRoot}\\xtensa-esp-elf\\lib\\esp32\\libc.a`),
  ...file("xt/lib/libgcc.a", `${xtRoot}\\lib\\gcc\\xtensa-esp-elf\\16.1.0\\esp32\\libgcc.a`),
  ...file("xt/lib/libnosys.a", `${xtRoot}\\xtensa-esp-elf\\lib\\esp32\\libnosys.a`),
};

const wasmer = new Wasmer({
  outputBytes: 8_000_000,
  cache: { directory: cache },
});
await wasmer.ready();
const clang = await wasmer.packages.load(readFileSync(`${wsl}\\build-wasi\\bin\\clang-22`));
const lld = await wasmer.packages.load(readFileSync(`${wsl}\\build-wasi\\bin\\lld`));
const sandbox = await wasmer.sandboxes.create({
  packages: [clang, lld],
  files,
  network: { mode: "disabled" },
});

async function run(pkg, label, args) {
  const output = await sandbox.command(pkg.command("main"), args).run({
    timeoutMs: 180_000,
    outputBytes: 8_000_000,
    check: false,
  });
  const text = `${output.stdout.text()}${output.stderr.text()}`;
  console.log(`\n$ ${label} ${args.join(" ")}\nexit ${output.exitCode}\n${text}`);
  if (!output.ok) throw new Error(`${label} failed`);
  return text;
}

const march = "rv32imafdc_zicsr_zifencei_zmmul_zaamo_zalrsc_zca_zcd_zcf";

try {
  await run(clang, "clang", [
    "--target=riscv32-esp-unknown-elf",
    `-march=${march}`,
    "-mabi=ilp32",
    "-ffreestanding",
    "-c", "/workspace/hello.c",
    "-o", "/workspace/rv/hello.o",
  ]);
  await run(lld, "ld.lld", [
    "-flavor", "gnu",
    "-m", "elf32lriscv",
    "-o", "/workspace/hello-rv.elf",
    "/workspace/rv/lib/crt0.o",
    "/workspace/rv/lib/crtbegin.o",
    "/workspace/rv/hello.o",
    "-L/workspace/rv/lib",
    "-lgcc", "-lc", "-lnosys", "-lc", "-lgcc",
    "/workspace/rv/lib/crtend.o",
  ]);
  await run(clang, "clang", [
    "--target=xtensa-esp-unknown-elf",
    "-ffreestanding",
    "-c", "/workspace/hello.c",
    "-o", "/workspace/xt/hello.o",
  ]);
  try {
  await run(lld, "ld.lld", [
    "-flavor", "gnu",
    "-T", "/workspace/xtensa.ld",
    "-o", "/workspace/hello-xt.elf",
    "/workspace/xt/lib/crt0.o",
    "/workspace/xt/lib/crti.o",
    "/workspace/xt/lib/crtbegin.o",
    "/workspace/xt/hello.o",
    "-L/workspace/xt/lib",
    "-lgcc", "-lc", "-lnosys", "-lc", "-lgcc",
    "/workspace/xt/lib/crtend.o",
    "/workspace/xt/lib/crtn.o",
  ]);
  } catch (error) {
    console.log(String(error));
  }

  const outDir = path.resolve(here, "..", "toolchain", "out");
  mkdirSync(outDir, { recursive: true });
  for (const name of ["hello-rv.elf", "hello-xt.elf"]) {
    let bytes;
    try {
      bytes = await sandbox.fs.readFile(`/workspace/${name}`);
    } catch {
      console.log(`${name} was not written`);
      continue;
    }
    const machine = bytes[18] | (bytes[19] << 8);
    const entry = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16) | (bytes[27] << 24);
    writeFileSync(path.join(outDir, name), bytes);
    console.log(`${name} ${bytes.length} bytes e_machine ${machine} entry 0x${entry.toString(16)}`);
  }
} finally {
  await sandbox.close();
  await wasmer.close();
}
