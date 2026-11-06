import { Wasmer, type Package, type Wasmer as WasmerClient } from "@wasmer/sdk";
import { elfToImage } from "./elf-image";
import type { BootOptions } from "./wasix";

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

const modes = ["QIO", "QOUT", "DIO", "DOUT"];
const freqs = ["80M", "40M", "26M", "20M"];
const sizes = ["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"];
const logs = ["NONE", "ERROR", "WARN", "INFO", "DEBUG", "VERBOSE"];
const logLevel: Record<string, number> = { none: 0, error: 1, warn: 2, info: 3, debug: 4, verbose: 5 };
const ecdsaV2 = new Set(["esp32c2", "esp32c61"]);
// ROM stores the verified image digest at the end of LP RAM. Kconfig reserves that many bytes only when secure boot is on.
const romFastWake = new Set(["esp32c5", "esp32c6", "esp32h2", "esp32h21", "esp32s31"]);

let client: WasmerClient | null = null;
let compiler: Package | null = null;

export async function compileIdfBootloader(options: BootOptions, log: (line: string) => void): Promise<Uint8Array> {
  if (options.secureBoot && options.chip === "esp32h4") throw new Error("ESP32-H4 does not support secure boot.");
  if (options.secureBoot && options.chip === "esp32") parseVerifyKey(options.verifyKey);
  if (!crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the compiler cannot start. Open it over HTTP and let the page reload once.");
  }
  log(`Loading the ESP-IDF bootloader sources for ${options.chip}…`);
  const bundle = await fetch(`${import.meta.env.BASE_URL}boot-sources/${encodeURIComponent(options.chip)}.bin`);
  if (!bundle.ok) throw new Error(`No packed sources for ${options.chip}. This site only includes chips written into boot-sources/.`);
  const packed = new Uint8Array(await bundle.arrayBuffer());
  const { recipe, files } = unpack(packed);
  patchConfig(files, recipe.sdkconfig, options);
  const jobs = configuredJobs(recipe, options);
  log(`Sources ${Math.round(packed.length / 1000000)} MB, ${jobs.length} files.`);

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
    await link(sandbox, ready, linkArgs, log);
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
  text = patchSecurity(text, options);
  files[sdkconfig] = new TextEncoder().encode(text);
}

function patchSecurity(text: string, options: BootOptions): string {
  if (options.secureBoot) {
    if (options.chip === "esp32h4") throw new Error("ESP32-H4 does not support secure boot.");
    text = setBool(text, "CONFIG_SECURE_BOOT", true);
    text = setBool(text, "CONFIG_SECURE_SIGNED_ON_BOOT", true);
    text = setBool(text, "CONFIG_SECURE_SIGNED_ON_UPDATE", true);
    text = setBool(text, "CONFIG_SECURE_SIGNED_APPS", true);
    text = setBool(text, "CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES", false);
    if (options.chip === "esp32") {
      text = setBool(text, "CONFIG_SECURE_BOOT_V1_ENABLED", true);
      text = setBool(text, "CONFIG_SECURE_SIGNED_APPS_ECDSA_SCHEME", true);
      text = setBool(text, "CONFIG_SECURE_BOOTLOADER_ONE_TIME_FLASH", true);
    } else {
      text = setBool(text, "CONFIG_SECURE_BOOT_V2_ENABLED", true);
      if (ecdsaV2.has(options.chip)) {
        text = setBool(text, "CONFIG_SECURE_SIGNED_APPS_ECDSA_V2_SCHEME", true);
        text = setBool(text, "CONFIG_SECURE_BOOT_ECDSA_KEY_LEN_256_BITS", true);
        text = setBool(text, "CONFIG_SECURE_BOOT_V2_ECDSA_ENABLED", true);
      } else {
        text = setBool(text, "CONFIG_SECURE_SIGNED_APPS_RSA_SCHEME", true);
        text = setBool(text, "CONFIG_SECURE_BOOT_V2_RSA_ENABLED", true);
      }
    }
    if (romFastWake.has(options.chip)) {
      text = setDefine(text, "CONFIG_SECURE_BOOT_IMAGE_DIGEST_LEN", "32");
      text = setDefine(text, "CONFIG_SECURE_BOOT_ROM_FAST_WAKE_RESERVE_SIZE", "32");
    }
  }
  if (options.encryption !== "off") {
    const release = options.encryption === "release";
    const derived = options.chip === "esp32c2" && options.secureBoot;
    text = setBool(text, "CONFIG_SECURE_FLASH_ENC_ENABLED", true);
    text = setBool(text, "CONFIG_SECURE_FLASH_ENCRYPTION_KEY_SOURCE_EFUSES", true);
    text = setBool(text, "CONFIG_SPI_FLASH_ENABLE_ENCRYPTED_READ_WRITE", true);
    if (options.chip !== "esp32") {
      text = setBool(text, derived ? "CONFIG_SECURE_FLASH_ENCRYPTION_AES128_DERIVED" : "CONFIG_SECURE_FLASH_ENCRYPTION_AES128", true);
    }
    text = setBool(text, "CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE", release);
    text = setBool(text, "CONFIG_SECURE_FLASH_ENCRYPTION_MODE_DEVELOPMENT", !release);
    text = setBool(text, "CONFIG_SECURE_FLASH_UART_BOOTLOADER_ALLOW_ENC", !release);
    if (release) text = setBool(text, "CONFIG_PARTITION_TABLE_MD5", true);
    if (derived) text = setBool(text, "CONFIG_SECURE_BOOT_FLASH_ENC_KEYS_BURN_TOGETHER", true);
  }
  return text;
}

function configuredJobs(recipe: Recipe, options: BootOptions): Job[] {
  const jobs = [...recipe.jobs];
  const extras: PackedSource[] = [];
  if (options.encryption !== "off") {
    if (!recipe.flashEncryption?.length) throw new Error("This source bundle has no flash-encryption sources. Pack the boot sources again.");
    extras.push(...recipe.flashEncryption);
  }
  if (options.secureBoot && options.chip !== "esp32h4") {
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

function parseVerifyKey(value: string): Uint8Array {
  const hex = value.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (hex.length % 2 !== 0) throw new Error("The verification public key must be an even number of hex digits.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  if (bytes.length === 65 && bytes[0] === 0x04) return bytes.subarray(1);
  if (bytes.length !== 64) throw new Error("ESP32 Secure Boot V1 needs the 64-byte verification public key (raw X and Y, hex).");
  return bytes;
}

function requiredSymbols(options: BootOptions): string[] {
  const names: string[] = [];
  if (options.encryption !== "off") names.push("esp_flash_encrypt_init", "esp_flash_encryption_enable_secure_features");
  if (options.secureBoot && options.chip !== "esp32h4") {
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

async function clang(sandbox: Awaited<ReturnType<WasmerClient["sandboxes"]["create"]>>, pkg: Package, args: string[], label: string, log: (line: string) => void): Promise<Uint8Array> {
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
        continue;
      }
    }
    if (!output.ok) throw new Error(`${label}\n${tail(text)}`);
    return sandbox.fs.readFile(args[args.length - 1] ?? "");
  }
  throw new Error(`${label}: too many unsupported compiler flags`);
}

async function link(sandbox: Awaited<ReturnType<WasmerClient["sandboxes"]["create"]>>, pkg: Package, args: string[], log: (line: string) => void): Promise<void> {
  const defined = new Set<string>();
  let grewLoader = false;
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
    if (added.length) {
      for (const name of added) defined.add(name);
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
    throw new Error(`link\n${tail(message)}`);
  }
  throw new Error("link: too many undefined ROM symbols");
}

async function growLoader(sandbox: Awaited<ReturnType<WasmerClient["sandboxes"]["create"]>>, args: string[], extra: number): Promise<boolean> {
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
function resizeLoaderMemory(source: string, extra: number): string | null {
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

