import type { Package, Wasmer as WasmerClient } from "@wasmer/sdk";
import { elfToImage } from "./elf-image.ts";
import { parseVerifyKey, validateOptions, type BootOptions } from "./options.ts";
import { patchConfig } from "./sdkconfig.ts";

type ListedFile = { path: string; offset: number; size: number };
type Job = { src: string; out: string; lib: string | null; member: string };
type PackedSource = { src: string; lib: string };
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
  secureBoot?: PackedSource[];
  flashEncryption?: PackedSource[];
  files: ListedFile[];
};
type Sandbox = Awaited<ReturnType<WasmerClient["sandboxes"]["create"]>>;

/** Where the build gets its runtime and inputs. The page fetches them over HTTP; scripts read them from disk. */
export type BuildHost = {
  client: WasmerClient;
  loadSources(chip: string): Promise<Uint8Array>;
  loadCompiler(): Promise<{ clang: Uint8Array; lld: Uint8Array }>;
};

/**
 * Undefined symbols that may be linked as address 0, per chip. Anything else that is undefined fails the build.
 * esp32h21: the ROM linker script aliases esp_rom_usb_serial_putc to uart_tx_one_char3, which the H21 ROM does not
 * export. lld evaluates that PROVIDE even though the bootloader defines esp_rom_usb_serial_putc in C and never takes
 * the alias.
 */
const allowedStubs: Record<string, readonly string[]> = {
  esp32h21: ["uart_tx_one_char3"],
};

const compilers = new WeakMap<WasmerClient, Package>();

export async function compileIdfBootloader(options: BootOptions, host: BuildHost, log: (line: string) => void): Promise<Uint8Array> {
  validateOptions(options);
  log(`Loading the ESP-IDF bootloader sources for ${options.chip}…`);
  const packed = await host.loadSources(options.chip);
  const { recipe, files } = unpack(packed);
  const sdkconfig = files[recipe.sdkconfig];
  if (!sdkconfig) throw new Error("sdkconfig.h is missing from the source bundle");
  files[recipe.sdkconfig] = text(patchConfig(new TextDecoder().decode(sdkconfig), options));
  const jobs = configuredJobs(recipe, options);
  log(`Sources ${Math.round(packed.length / 1000000)} MB, ${jobs.length} files.`);

  const client = host.client;
  await client.ready();
  let compiler = compilers.get(client);
  if (!compiler) {
    log("Loading clang and ld.lld…");
    const { clang, lld } = await host.loadCompiler();
    compiler = await client.packages.create({
      modules: { clang, lld },
      commands: {
        clang: { module: "clang" },
        "ld.lld": { module: "lld" },
      },
    });
    compilers.set(client, compiler);
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
    const common = recipe.common.map((flag) => flag === "-O0" || flag === "-O1" || flag === "-O2" || flag === "-Os" ? "-Oz" : flag);
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      log(`clang ${index + 1}/${jobs.length} ${job.src}`);
      const object = job.src.endsWith(".S") || job.src.endsWith(".s")
        ? await assemble(sandbox, ready, recipe.target, common, job.src, `/workspace/${job.out}`)
        : await clang(sandbox, ready, [...common, "-c", `/workspace/${job.src}`, "-o", `/workspace/${job.out}`], job.src, log);
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
    if (options.secureBoot && options.chip === "esp32") {
      const key = parseVerifyKey(options.verifyKey);
      const bytes = [...key].map((value) => `0x${value.toString(16).padStart(2, "0")}`).join(",");
      const source = `const unsigned char _binary_signature_verification_key_bin_start[64] __attribute__((aligned(4), used)) = {${bytes}};\n`;
      await sandbox.fs.writeFile("/workspace/obj/signature_verification_key.c", text(source));
      log("clang verification public key");
      direct.push(await clang(
        sandbox,
        ready,
        [...common, "-c", "/workspace/obj/signature_verification_key.c", "-o", "/workspace/obj/signature_verification_key.o"],
        "signature_verification_key.c",
        log,
      ));
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
      ...(options.secureBoot && options.chip === "esp32"
        ? ["--defsym", "_binary_signature_verification_key_bin_end=_binary_signature_verification_key_bin_start+64"]
        : []),
      "--start-group",
      ...libArgs,
      recipe.libc,
      recipe.libgcc,
      "--end-group",
      "-o", "/workspace/bootloader.elf",
    ];
    await link(sandbox, ready, linkArgs, allowedStubs[options.chip] ?? [], log);
    const elf = await sandbox.fs.readFile("/workspace/bootloader.elf");
    assertDefined(elf, requiredSymbols(options));
    const securePad = options.secureBoot && options.chip !== "esp32";
    const image = await elfToImage(elf, {
      chip: options.chip,
      mode: options.mode,
      freq: options.freq,
      size: options.size,
      sha256: options.sha256,
      securePad,
      minRev: recipe.revisions.min,
      minRevFull: recipe.revisions.minFull,
      maxRevFull: recipe.revisions.maxFull,
    });
    if (securePad) log("Image padded to 4 KB for Secure Boot V2. Sign it with espsecure.py sign_data --version 2 before flashing.");
    if (options.secureBoot && options.chip === "esp32") log("ESP32 Secure Boot V1 image. Sign applications with the private key that matches the embedded verification key.");
    if (options.encryption !== "off") log(`Flash encryption is ${options.encryption}. The first boot burns the key into eFuse.`);
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

function configuredJobs(recipe: Recipe, options: BootOptions): Job[] {
  const jobs = [...recipe.jobs];
  const extras: PackedSource[] = [];
  if (options.encryption !== "off") {
    if (!recipe.flashEncryption?.length) throw new Error("This source bundle has no flash-encryption sources. Pack the boot sources again.");
    extras.push(...recipe.flashEncryption);
  }
  if (options.secureBoot) {
    if (!recipe.secureBoot?.length) throw new Error("This source bundle has no secure-boot sources. Pack the boot sources again.");
    extras.push(...recipe.secureBoot);
  }
  for (const extra of extras) jobs.push(extraJob(extra, jobs));
  return jobs;
}

function extraJob(extra: PackedSource, jobs: Job[]): Job {
  const file = extra.src.slice(extra.src.lastIndexOf("/") + 1);
  const stem = file.slice(0, file.lastIndexOf(".")) || file;
  const used = new Set(jobs.filter((job) => job.lib === extra.lib).map((job) => job.member));
  // Member names have to match the bootloader linker script globs (flash_encrypt.*, secure_boot.*).
  let member = `${file}.o`;
  let index = 0;
  while (used.has(member)) {
    index += 1;
    member = `${stem}.${index}.o`;
  }
  return {
    src: extra.src,
    lib: extra.lib,
    member,
    out: `obj/${extra.lib.replace(/[^\w.+-]/g, "_")}-${member}`,
  };
}

function requiredSymbols(options: BootOptions): string[] {
  const names: string[] = [];
  if (options.encryption !== "off") names.push("esp_flash_encrypt_init", "esp_flash_encryption_enable_secure_features");
  if (options.secureBoot) {
    names.push("esp_secure_boot_enable_secure_features");
    if (options.chip === "esp32") names.push("esp_secure_boot_generate_digest", "esp_secure_boot_permanently_enable", "_binary_signature_verification_key_bin_start");
    else names.push("esp_secure_boot_v2_permanently_enable");
  }
  return names;
}

function assertDefined(elf: Uint8Array, names: string[]): void {
  if (!names.length) return;
  const defined = symbolValues(elf);
  const missing = names.filter((name) => !defined.has(name));
  if (missing.length) throw new Error(`link is missing ${missing.join(", ")}`);
}

function symbolValues(elf: Uint8Array): Set<string> {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint32(0, true) !== 0x464c457f || elf[4] !== 1) return new Set();
  const shoff = view.getUint32(32, true);
  const shentsize = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  const defined = new Set<string>();
  for (let index = 0; index < shnum; index += 1) {
    const off = shoff + index * shentsize;
    if (view.getUint32(off + 4, true) !== 2) continue;
    const link = view.getUint32(off + 24, true);
    const symOff = view.getUint32(off + 16, true);
    const symSize = view.getUint32(off + 20, true);
    const strOff = shoff + link * shentsize;
    const strings = elf.subarray(view.getUint32(strOff + 16, true), view.getUint32(strOff + 16, true) + view.getUint32(strOff + 20, true));
    for (let at = symOff; at + 16 <= symOff + symSize; at += 16) {
      if (view.getUint16(at + 14, true) === 0) continue;
      const nameAt = view.getUint32(at, true);
      let end = nameAt;
      while (end < strings.length && strings[end] !== 0) end += 1;
      const name = new TextDecoder().decode(strings.subarray(nameAt, end));
      if (name && view.getUint32(at + 4, true) !== 0) defined.add(name);
    }
  }
  return defined;
}

async function assemble(sandbox: Sandbox, pkg: Package, triple: string, common: string[], src: string, out: string): Promise<Uint8Array> {
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

async function clang(sandbox: Sandbox, pkg: Package, args: string[], label: string, log: (line: string) => void): Promise<Uint8Array> {
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
      const fallback = args.filter((flag) => flag !== "-Oz" && flag !== "-Os" && flag !== "-O2" && flag !== "-mllvm" && flag !== "-global-isel");
      const at = fallback.indexOf("-c");
      fallback.splice(at, 0, "-O0");
      args.splice(0, args.length, ...fallback);
      log(`${label} hit a compiler backend error, so this file was rebuilt at -O0`);
      continue;
    }
    const unknown = text.match(/unknown argument[: ]+'([^']+)'/);
    if (!output.ok && unknown) {
      const flag = unknown[1];
      const index = args.indexOf(flag);
      if (index >= 0) {
        args.splice(index, 1);
        log(`${label}: clang does not know ${flag}, so it was dropped`);
        continue;
      }
    }
    if (!output.ok) throw new Error(`${label}\n${tail(text)}`);
    return sandbox.fs.readFile(args[args.length - 1] ?? "");
  }
  throw new Error(`${label}: too many unsupported compiler flags`);
}

async function link(sandbox: Sandbox, pkg: Package, args: string[], allowed: readonly string[], log: (line: string) => void): Promise<void> {
  const stubbed = new Set<string>();
  let grewLoader = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const extra = [...stubbed].flatMap((name) => ["--defsym", `${name}=0`]);
    const output = await sandbox.command(pkg.command("ld.lld"), [...args, ...extra]).run({
      timeoutMs: 180_000,
      outputBytes: 8_000_000,
      check: false,
    });
    const message = `${output.stdout.text()}${output.stderr.text()}`;
    if (output.ok) {
      if (stubbed.size) log(`Linked with ${[...stubbed].join(", ")} set to address 0. The bootloader never calls them.`);
      return;
    }
    const missing = [...new Set([...message.matchAll(/symbol not found: (\S+)/g)].map((match) => match[1]))];
    const added = missing.filter((name) => !stubbed.has(name));
    if (added.length) {
      const refused = added.filter((name) => !allowed.includes(name));
      if (refused.length) throw new Error(`link: undefined symbol${refused.length > 1 ? "s" : ""} ${refused.join(", ")}\n${tail(message)}`);
      for (const name of added) stubbed.add(name);
      continue;
    }
    const overflow = message.match(/region 'iram_loader_seg': overflowed by (\d+) bytes/);
    if (!grewLoader && overflow) {
      const bytes = Number(overflow[1]);
      const extraBytes = Math.ceil(bytes / 16) * 16;
      if (await growLoader(sandbox, args, extraBytes)) {
        grewLoader = true;
        log(`iram_loader_seg was ${bytes} bytes short. Moved ${extraBytes} bytes from bootloader DRAM into the loader, leaving its start address unchanged.`);
        continue;
      }
    }
    if (overflow) throw new Error(`This bootloader is ${overflow[1]} bytes too large for the chip's loader IRAM. Turn off some options and build again.\n${tail(message)}`);
    throw new Error(`link\n${tail(message)}`);
  }
  throw new Error("link: too many undefined symbols");
}

async function growLoader(sandbox: Sandbox, args: string[], extra: number): Promise<boolean> {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-T") continue;
    const path = args[index + 1];
    if (!path) continue;
    const source = new TextDecoder().decode(await sandbox.fs.readFile(path));
    if (!source.includes("iram_loader_seg")) continue;
    const next = resizeLoaderMemory(source, extra);
    if (!next) continue;
    await sandbox.fs.writeFile(path, text(next));
    return true;
  }
  return false;
}

// The loader and bootloader DRAM are adjacent. Applications are linked up to the loader's start, so only the DRAM side can move.
export function resizeLoaderMemory(source: string, extra: number): string | null {
  if (extra <= 0) return null;
  const loaderLen = source.match(/^bootloader_iram_loader_seg_len = (0x[0-9a-fA-F]+);/m);
  const dramLen = source.match(/^bootloader_dram_seg_len = (0x[0-9a-fA-F]+);/m);
  if (loaderLen?.[1] && dramLen?.[1]) {
    const loader = Number.parseInt(loaderLen[1], 16);
    const dram = Number.parseInt(dramLen[1], 16);
    if (dram - extra < 0x1000) return null;
    return source
      .replace(loaderLen[0], `bootloader_iram_loader_seg_len = 0x${(loader + extra).toString(16)};`)
      .replace(dramLen[0], `bootloader_dram_seg_len = 0x${(dram - extra).toString(16)};`);
  }
  const loader = source.match(/iram_loader_seg\s*\(RWX\)\s*:\s*org\s*=\s*(0x[0-9a-fA-F]+)\s*,\s*len\s*=\s*(0x[0-9a-fA-F]+)/);
  const dram = source.match(/dram_seg\s*\(RW\)\s*:\s*org\s*=\s*(0x[0-9a-fA-F]+)\s*,\s*len\s*=\s*(0x[0-9a-fA-F]+)/);
  if (!loader?.[1] || !loader[2] || !dram?.[1] || !dram[2]) return null;
  const loaderOrg = Number.parseInt(loader[1], 16);
  const loaderLength = Number.parseInt(loader[2], 16);
  const dramOrg = Number.parseInt(dram[1], 16);
  const dramLength = Number.parseInt(dram[2], 16);
  const loaderEnd = loaderOrg + loaderLength;
  const adjacent = dramOrg === loaderEnd || dramOrg + 0x70000 === loaderEnd;
  if (!adjacent || dramLength - extra < 0x1000) return null;
  return source
    .replace(loader[0], `iram_loader_seg (RWX) : org = 0x${loaderOrg.toString(16)}, len = 0x${(loaderLength + extra).toString(16)}`)
    .replace(dram[0], `dram_seg (RW) : org = 0x${(dramOrg + extra).toString(16)}, len = 0x${(dramLength - extra).toString(16)}`);
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-40).join("\n");
}

export function archive(members: { member: string; data: Uint8Array }[]): Uint8Array {
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
