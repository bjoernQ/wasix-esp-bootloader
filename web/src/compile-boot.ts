import { Wasmer, type Package, type Wasmer as WasmerClient } from "@wasmer/sdk";
import { elfToImage } from "./elf-image";
import type { BootOptions } from "./wasix";

type ListedFile = { path: string; offset: number; size: number };
type Job = { src: string; out: string; lib: string | null; member: string };
type Recipe = {
  target: string;
  machine: string;
  common: string[];
  jobs: Job[];
  direct: string[];
  scripts: string[];
  undefined: string[];
  libc: string;
  libgcc: string;
  sdkconfig: string;
  revisions: { min: number; minFull: number; maxFull: number };
  files: ListedFile[];
};

const modes = ["QIO", "QOUT", "DIO", "DOUT"];
const freqs = ["80M", "40M", "26M", "20M"];
const sizes = ["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"];
const logs = ["NONE", "ERROR", "WARN", "INFO", "DEBUG", "VERBOSE"];
const logLevel: Record<string, number> = { none: 0, error: 1, warn: 2, info: 3, debug: 4, verbose: 5 };

let client: WasmerClient | null = null;
let compiler: Package | null = null;

export async function compileIdfBootloader(options: BootOptions, log: (line: string) => void): Promise<Uint8Array> {
  if (!crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the compiler cannot start. Open it over HTTP and let the page reload once.");
  }
  log(`Loading the ESP-IDF bootloader sources for ${options.chip}…`);
  const bundle = await fetch(`${import.meta.env.BASE_URL}boot-sources/${encodeURIComponent(options.chip)}.bin`);
  if (!bundle.ok) throw new Error(`No packed sources for ${options.chip}. This site only includes chips written into boot-sources/.`);
  const packed = new Uint8Array(await bundle.arrayBuffer());
  const { recipe, files } = unpack(packed);
  patchConfig(files, recipe.sdkconfig, options);
  log(`Sources ${Math.round(packed.length / 1000000)} MB, ${recipe.jobs.length} files.`);

  client ??= new Wasmer({ outputBytes: 8_000_000 });
  await client.ready();
  if (!compiler) {
    log("Loading clang and ld.lld…");
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
  const ready = compiler;
  const sandbox = await client.sandboxes.create({
    packages: [ready],
    files,
    env: { PATH: "/bin:/usr/bin" },
    network: { mode: "disabled" },
  });

  try {
    await sandbox.fs.mkdir("/workspace/obj", { recursive: true });
    await sandbox.fs.mkdir("/workspace/libs", { recursive: true });
    const objects = new Map<string, { member: string; data: Uint8Array }[]>();
    const direct: Uint8Array[] = [];
    for (let index = 0; index < recipe.jobs.length; index += 1) {
      const job = recipe.jobs[index];
      log(`clang ${index + 1}/${recipe.jobs.length} ${job.src}`);
      const common = recipe.common.map((flag) => flag === "-O0" && recipe.target.startsWith("xtensa") ? "-Os" : flag);
      const object = job.src.endsWith(".S") || job.src.endsWith(".s")
        ? await assemble(sandbox, ready, recipe.target, common, job.src, `/workspace/${job.out}`)
        : await clang(sandbox, ready, [...common, "-c", `/workspace/${job.src}`, "-o", `/workspace/${job.out}`], job.src);
      if (job.lib) {
        const list = objects.get(job.lib) ?? [];
        list.push({ member: job.member, data: object });
        objects.set(job.lib, list);
      } else {
        direct.push(object);
        await sandbox.fs.writeFile(`/workspace/${job.out}`, object);
      }
    }
    const libArgs: string[] = [];
    for (const [name, members] of objects) {
      const guest = `/workspace/libs/${name}`;
      await sandbox.fs.writeFile(guest, archive(members));
      libArgs.push(guest);
    }
    for (let index = 0; index < direct.length; index += 1) {
      await sandbox.fs.writeFile(`/workspace/direct-${index}.o`, direct[index]);
    }
    log("ld.lld bootloader.elf");
    const linkArgs = [
      "-flavor", "gnu",
      ...(recipe.machine === "elf32xtensa" ? [] : ["-m", recipe.machine]),
      "--gc-sections",
      "-nostdlib",
      ...recipe.undefined.flatMap((symbol) => ["-u", symbol]),
      ...recipe.scripts.flatMap((script) => ["-T", script]),
      ...direct.map((_, index) => `/workspace/direct-${index}.o`),
      "--start-group",
      ...libArgs,
      recipe.libc,
      recipe.libgcc,
      "--end-group",
      "-o", "/workspace/bootloader.elf",
    ];
    await link(sandbox, ready, linkArgs);
    const elf = await sandbox.fs.readFile("/workspace/bootloader.elf");
    const image = await elfToImage(elf, {
      chip: options.chip,
      mode: options.mode,
      freq: options.freq,
      size: options.size,
      sha256: options.sha256,
      minRev: recipe.revisions.min,
      minRevFull: recipe.revisions.minFull,
      maxRevFull: recipe.revisions.maxFull,
    });
    log(`ESP-IDF bootloader ${image.length} bytes.`);
    return image;
  } finally {
    await sandbox.close();
  }
}

function unpack(packed: Uint8Array): { recipe: Recipe; files: Record<string, Uint8Array> } {
  const magic = new TextDecoder().decode(packed.subarray(0, 8));
  if (magic !== "ESPBOOT1") throw new Error("source bundle is not a bootloader package");
  const length = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(8, true);
  const recipe = JSON.parse(new TextDecoder().decode(packed.subarray(12, 12 + length))) as Recipe;
  const files: Record<string, Uint8Array> = {};
  const base = 12 + length;
  for (const file of recipe.files) {
    files[file.path] = packed.slice(base + file.offset, base + file.offset + file.size);
  }
  return { recipe, files };
}

function patchConfig(files: Record<string, Uint8Array>, sdkconfig: string, options: BootOptions): void {
  const current = files[sdkconfig];
  if (!current) throw new Error("sdkconfig.h is missing from the source bundle");
  let text = new TextDecoder().decode(current);
  text = choose(text, "CONFIG_ESPTOOLPY_FLASHMODE", options.mode.toUpperCase(), modes, `"${options.mode}"`);
  text = choose(text, "CONFIG_ESPTOOLPY_FLASHFREQ", options.freq.toUpperCase(), freqs, `"${options.freq}"`);
  text = choose(text, "CONFIG_ESPTOOLPY_FLASHSIZE", options.size, sizes, `"${options.size}"`);
  text = choose(text, "CONFIG_BOOTLOADER_LOG_LEVEL", options.logLevel.toUpperCase(), logs, String(logLevel[options.logLevel] ?? 3));
  text = choose(text, "CONFIG_LOG_BOOTLOADER_LEVEL", options.logLevel.toUpperCase(), logs, String(logLevel[options.logLevel] ?? 3));
  text = setDefine(text, "CONFIG_ESP_CONSOLE_UART_BAUDRATE", String(options.baud));
  text = setDefine(text, "CONFIG_PARTITION_TABLE_OFFSET", hex(options.partition));
  text = setBool(text, "CONFIG_BOOTLOADER_APP_ROLLBACK", options.rollback);
  text = setBool(text, "CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE", options.rollback);
  text = setBool(text, "CONFIG_BOOTLOADER_FACTORY_RESET", options.resetGpio >= 0);
  if (options.resetGpio >= 0) text = setDefine(text, "CONFIG_BOOTLOADER_NUM_PIN_FACTORY_RESET", String(options.resetGpio));
  text = setBool(text, "CONFIG_BOOTLOADER_SKIP_VALIDATE_ALWAYS", !options.sha256);
  files[sdkconfig] = new TextEncoder().encode(text);
}

function choose(text: string, prefix: string, selected: string, names: string[], value: string): string {
  for (const name of names) text = setBool(text, `${prefix}_${name}`, name === selected);
  return setDefine(text, prefix, value);
}

function definePattern(name: string): RegExp {
  return new RegExp(`^#define ${name}(?![A-Za-z0-9_]).*$`, "m");
}

function setBool(text: string, name: string, enabled: boolean): string {
  if (enabled) return setDefine(text, name, "1");
  return text.replace(definePattern(name), `/* ${name} unset */`);
}

function setDefine(text: string, name: string, value: string): string {
  const line = `#define ${name} ${value}`;
  const pattern = definePattern(name);
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

function hex(value: string): string {
  if (value.startsWith("0x") || value.startsWith("0X")) return value;
  return `0x${Number(value).toString(16)}`;
}

async function assemble(sandbox: Awaited<ReturnType<WasmerClient["sandboxes"]["create"]>>, pkg: Package, triple: string, common: string[], src: string, out: string): Promise<Uint8Array> {
  const pre = await sandbox.command(pkg.command("clang"), ["-E", ...common, "-x", "assembler-with-cpp", `/workspace/${src}`]).run({
    timeoutMs: 180_000,
    outputBytes: 8_000_000,
    check: false,
  });
  const preText = `${pre.stdout.text()}${pre.stderr.text()}`;
  if (!pre.ok) throw new Error(`${src}\n${tail(preText)}`);
  const temporary = `${out}.s`;
  await sandbox.fs.writeFile(temporary, text(pre.stdout.text()));
  const args = [
    "-cc1as", "-triple", triple, "-filetype", "obj",
    "-main-file-name", src.slice(src.lastIndexOf("/") + 1),
    "-mrelocation-model", "static",
    ...(triple.startsWith("xtensa") ? ["-target-feature", "+windowed"] : []),
    "-o", out, temporary,
  ];
  const assembled = await sandbox.command(pkg.command("clang"), args).run({
    timeoutMs: 180_000,
    outputBytes: 8_000_000,
    check: false,
  });
  if (!assembled.ok) {
    const message = `${assembled.stdout.text()}${assembled.stderr.text()}`;
    throw new Error(`${src}\n${tail(message)}`);
  }
  return sandbox.fs.readFile(out);
}

async function clang(sandbox: Awaited<ReturnType<WasmerClient["sandboxes"]["create"]>>, pkg: Package, args: string[], label: string): Promise<Uint8Array> {
  let retriedBackend = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let output;
    try {
      output = await sandbox.command(pkg.command("clang"), args).run({
        timeoutMs: 180_000,
        outputBytes: 8_000_000,
        check: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}: compiler crashed (${message.split("\n")[0]})`);
    }
    const text = `${output.stdout.text()}${output.stderr.text()}`;
    if (!output.ok && text.includes("error in backend") && !retriedBackend) {
      retriedBackend = true;
      const fallback = args.filter((flag) => flag !== "-Os" && flag !== "-O2" && flag !== "-mllvm" && flag !== "-global-isel");
      const at = fallback.indexOf("-c");
      fallback.splice(at, 0, "-O0");
      args.splice(0, args.length, ...fallback);
      continue;
    }
    const unknown = text.match(/unknown argument[: ]+'([^']+)'/);
    if (!output.ok && unknown) {
      const flag = unknown[1];
      const index = args.indexOf(flag);
      if (index >= 0) {
        args.splice(index, 1);
        continue;
      }
    }
    if (!output.ok) throw new Error(`${label}\n${tail(text)}`);
    return sandbox.fs.readFile(args[args.length - 1] ?? "");
  }
  throw new Error(`${label}: too many unsupported compiler flags`);
}

async function link(sandbox: Awaited<ReturnType<WasmerClient["sandboxes"]["create"]>>, pkg: Package, args: string[]): Promise<void> {
  const defined = new Set<string>();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const extra = [...defined].flatMap((name) => ["--defsym", `${name}=0`]);
    const output = await sandbox.command(pkg.command("ld.lld"), [...args, ...extra]).run({
      timeoutMs: 180_000,
      outputBytes: 8_000_000,
      check: false,
    });
    const message = `${output.stdout.text()}${output.stderr.text()}`;
    if (output.ok) return;
    const missing = [...message.matchAll(/symbol not found: (\S+)/g)].map((match) => match[1]);
    const added = missing.filter((name) => !defined.has(name));
    if (!added.length) throw new Error(`link\n${tail(message)}`);
    for (const name of added) defined.add(name);
  }
  throw new Error("link: too many undefined ROM symbols");
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-40).join("\n");
}

function archive(members: { member: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [text("!<arch>\n")];
  let table = "";
  const pending: { name: string; data: Uint8Array }[] = [];
  for (const member of members) {
    const sysv = `${member.member}/`;
    if (sysv.length <= 16) {
      chunks.push(header(sysv.padEnd(16, " "), member.data.length), even(member.data));
    } else {
      pending.push({ name: `/${table.length}`.padEnd(16, " "), data: member.data });
      table += `${member.member}/\n`;
    }
  }
  if (table) {
    const bytes = text(table);
    chunks.splice(1, 0, header("//".padEnd(16, " "), bytes.length), even(bytes));
  }
  for (const member of pending) chunks.push(header(member.name, member.data.length), even(member.data));
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function header(name: string, size: number): Uint8Array {
  const line = `${name}${"0".padStart(12, " ")}${"0".padStart(6, " ")}${"0".padStart(6, " ")}${"100644".padStart(8, " ")}${String(size).padStart(10, "0")}\`\n`;
  if (line.length !== 60) throw new Error(`archive header is ${line.length} bytes`);
  return text(line);
}

function even(data: Uint8Array): Uint8Array {
  if (data.length % 2 === 0) return data;
  const out = new Uint8Array(data.length + 1);
  out.set(data);
  out[data.length] = 0x0a;
  return out;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function fetchBytes(url: string, log: (line: string) => void): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
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

