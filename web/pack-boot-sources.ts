import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chips = new Set([
  "esp32", "esp32c2", "esp32c3", "esp32c5", "esp32c6", "esp32c61",
  "esp32h2", "esp32h21", "esp32h4", "esp32p4", "esp32s2", "esp32s3", "esp32s31",
]);

const dropFlag = /^(?:-Werror|-fdiagnostics-color=always|-ggdb|-gdwarf-4|-fstrict-volatile-bitfields|-fno-malloc-dce|-fzero-init-padding-bits(?:=.*)?|-Wunused-but-set-variable=1|-fmacro-prefix-map=.*|-specs=.*|@.*)$/;

type Job = {
  src: string;
  out: string;
  lib: string | null;
  member: string;
};

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
  secureBoot: PackedSource[];
  flashEncryption: PackedSource[];
};

function wsl(unix: string): string {
  return `\\\\wsl$\\Ubuntu${unix.replaceAll("/", "\\")}`;
}

function normalize(unix: string): string {
  return unix.replace(/\/\.$/, "").replace(/\/$/, "");
}

function guestOf(unix: string): string {
  const clean = normalize(unix);
  if (clean.startsWith("/opt/esp-idf/")) return `idf/${clean.slice("/opt/esp-idf/".length)}`;
  const marker = "/build/bootloader";
  const at = clean.indexOf(marker);
  if (clean.startsWith("/opt/idf-targets/") && at >= 0) {
    const rest = clean.slice(at + marker.length).replace(/^\//, "");
    return rest ? `build/${rest}` : "build";
  }
  throw new Error(`unexpected source path ${unix}`);
}

function walk(root: string, guest: string, into: Map<string, Buffer>): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (name === ".git" || name === "__pycache__") continue;
    const full = path.join(root, name);
    const rel = `${guest}/${name}`;
    if (statSync(full).isDirectory()) walk(full, rel, into);
    else into.set(rel.replaceAll("\\", "/"), readFileSync(full));
  }
}

function tokens(command: string): string[] {
  return command.match(/@?\"(?:\\.|[^\"])*\"|@?\S+/g) ?? [];
}

function unquote(token: string): string {
  if (token.startsWith("@")) return unquote(token.slice(1));
  if (token.startsWith("\"") && token.endsWith("\"")) return token.slice(1, -1).replaceAll("\\\"", "\"");
  return token;
}

function libraryOf(output: string): string | null {
  const match = output.replaceAll("\\", "/").match(/(?:^|\/)esp-idf\/([^/]+)\/CMakeFiles\//);
  return match ? `lib${match[1]}.a` : null;
}

function addNeighborHeaders(dir: string, into: Map<string, Buffer>): void {
  const host = wsl(dir);
  if (!existsSync(host)) return;
  const guest = guestOf(dir);
  for (const name of readdirSync(host)) {
    if (!name.endsWith(".h") && !name.endsWith(".hpp") && !name.endsWith(".inc")) continue;
    const full = path.join(host, name);
    if (statSync(full).isDirectory()) continue;
    into.set(`${guest}/${name}`, readFileSync(full));
  }
}

function covered(dir: string, dirs: string[]): boolean {
  const norm = dir.replace(/\/\.$/, "").replace(/\/$/, "");
  return dirs.some((other) => {
    const base = other.replace(/\/\.$/, "").replace(/\/$/, "");
    return base !== norm && norm.startsWith(`${base}/`);
  });
}

function recipeFor(chip: string): { recipe: Recipe; files: Map<string, Buffer> } {
  const build = `/opt/idf-targets/${chip}/build/bootloader`;
  const commandsPath = wsl(`${build}/compile_commands.json`);
  if (!existsSync(commandsPath)) {
    throw new Error(`No prepared bootloader sources for ${chip}. The page compiles those sources itself and does not run a host toolchain.`);
  }
  const commands = JSON.parse(readFileSync(commandsPath, "utf8")) as { directory: string; command: string; file: string }[];
  if (!commands.length) throw new Error("compile database is empty");
  const compiler = tokens(commands[0].command)[0] ?? "";
  const riscv = compiler.includes("riscv32");
  const files = new Map<string, Buffer>();
  const includes = new Set<string>();
  const defines = new Set<string>();
  const jobs: Job[] = [];
  const usedMembers = new Map<string, number>();

  for (const entry of commands) {
    const parts = tokens(entry.command).map(unquote);
    let output = "";
    for (let i = 1; i < parts.length; i += 1) {
      const part = parts[i];
      if (part === "-I" && parts[i + 1]) {
        includes.add(parts[i + 1]);
        i += 1;
        continue;
      }
      if (part.startsWith("-I")) includes.add(part.slice(2));
      else if (part.startsWith("-DIDF_VER=")) {
        const version = part.match(/[0-9a-f]{7,}/)?.[0] ?? "unknown";
        defines.add(`-DIDF_VER="${version}"`);
      } else if (part.startsWith("-D")) defines.add(part.replaceAll('\\"', '"'));
      else if (part === "-o" && parts[i + 1]) {
        output = parts[i + 1];
        i += 1;
      }
    }
    const src = guestOf(entry.file);
    const lib = libraryOf(output);
    const base = path.posix.basename(entry.file).replaceAll(/[^\w.+-]/g, "_");
    const slot = `${lib ?? "exe"}/${base}.o`;
    const seen = usedMembers.get(slot) ?? 0;
    usedMembers.set(slot, seen + 1);
    const member = seen === 0 ? `${base}.o` : `${seen}-${base}.o`;
    const out = `obj/${(lib ?? "exe").replaceAll(/[^\w.+-]/g, "_")}-${member}`;
    jobs.push({ src, out, lib, member });
    files.set(src, readFileSync(wsl(entry.file)));
    addNeighborHeaders(entry.file.slice(0, entry.file.lastIndexOf("/")), files);
  }

  const includeList = [...includes];
  for (const include of includeList) {
    if (covered(normalize(include), includeList.map(normalize))) continue;
    walk(wsl(normalize(include)), guestOf(include), files);
  }

  const sysroot = riscv
    ? "/opt/esp-clang/sysroots/riscv32-esp-elf"
    : "/opt/esp-clang/sysroots/xtensa-esp-elf";
  walk(wsl(`${sysroot}/picolibc/include`), "sysroot/include", files);
  walk(wsl("/opt/esp-clang/build-wasi/lib/clang/22/include"), "lib/clang/22/include", files);

  const cflags = existsSync(wsl(`${build}/toolchain/cflags`))
    ? readFileSync(wsl(`${build}/toolchain/cflags`), "utf8")
    : "";
  const march = cflags.match(/-march=\S+/)?.[0];
  const mabi = cflags.match(/-mabi=\S+/)?.[0];
  const mcpu = cflags.match(/-mcpu=\S+/)?.[0];
  const common = [
    `--target=${riscv ? "riscv32-esp-unknown-elf" : "xtensa-esp-unknown-elf"}`,
    "-resource-dir", "/workspace/lib/clang/22",
    "-nostdlibinc",
    "-isystem", "/workspace/sysroot/include",
    ...(march ? [march] : []),
    ...(mabi ? [mabi] : riscv ? ["-mabi=ilp32"] : []),
    ...(mcpu ? [mcpu] : []),
    "-D__PICOLIBC_ERRNO_FUNCTION=__errno",
    "-D__STDC_WANT_LIB_EXT1__=0",
    ...defines,
    "-std=gnu23",
    "-Oz",
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-jump-tables",
    "-fno-stack-protector",
    "-Wno-unknown-attributes",
    ...includeList.flatMap((include) => ["-I", `/workspace/${guestOf(include)}`]),
  ].filter((flag) => !dropFlag.test(flag));

  const ninja = readFileSync(wsl(`${build}/build.ninja`), "utf8");
  const linkAt = ninja.indexOf("\nbuild bootloader.elf:");
  if (linkAt < 0) throw new Error("bootloader link recipe is missing");
  const linkBlock = ninja.slice(linkAt, ninja.indexOf("\n\n", linkAt));
  const linkFlags = linkBlock.match(/^  LINK_FLAGS = (.*)$/m)?.[1] ?? "";
  const scripts: string[] = [];
  const ldFiles = [...linkBlock.matchAll(/(\/opt\/\S+?\.ld)\b/g)].map((match) => match[1]);
  const searchDirs = [...linkBlock.matchAll(/(?:^|\s)-L\s*(\/opt\/\S+)/g)].map((match) => match[1]);
  for (const name of [...linkFlags.matchAll(/(?:^|\s)-T\s+(\S+)/g)].map((match) => match[1])) {
    const found = ldFiles.find((file) => file.endsWith(`/${name}`))
      ?? searchDirs.map((dir) => `${dir.replace(/\/$/, "")}/${name}`).find((file) => existsSync(wsl(file)));
    if (!found) throw new Error(`linker script ${name} is missing`);
    const guest = guestOf(found);
    files.set(guest, readFileSync(wsl(found)));
    scripts.push(`/workspace/${guest}`);
  }
  const undefinedSymbols = [...linkFlags.matchAll(/(?:^|\s)-u\s+(\S+)/g)].map((match) => match[1]);
  if (!undefinedSymbols.length) {
    for (const symbol of [...linkBlock.matchAll(/-Wl,-u,(\S+)/g)].map((match) => match[1])) undefinedSymbols.push(symbol);
  }
  const rawUndefined = [...linkBlock.matchAll(/ -u (\S+)/g)].map((match) => match[1]);

  const mapPath = wsl(`${build}/bootloader.map`);
  const mapText = existsSync(mapPath) ? readFileSync(mapPath, "utf8") : "";
  const libc = mapText.match(/\/opt\/\S+\/libc\.a/)?.[0];
  const libgcc = mapText.match(/\/opt\/\S+\/libgcc\.a/)?.[0];
  if (!libc || !libgcc) throw new Error("picolibc and libgcc paths are missing from the bootloader map");
  files.set("sysroot/lib/libc.a", readFileSync(wsl(libc)));
  files.set("sysroot/lib/libgcc.a", readFileSync(wsl(libgcc)));

  const sdkconfig = "build/config/sdkconfig.h";
  if (!files.has(sdkconfig)) throw new Error("sdkconfig.h is missing");
  const security = securitySources(chip, files);

  return {
    files,
    recipe: {
      target: riscv ? "riscv32-esp-unknown-elf" : "xtensa-esp-unknown-elf",
      machine: riscv ? "elf32lriscv" : "elf32xtensa",
      common,
      jobs,
      direct: jobs.filter((job) => job.lib == null).map((job) => `/workspace/${job.out}`),
      scripts,
      undefined: rawUndefined.length ? rawUndefined : undefinedSymbols,
      libc: "/workspace/sysroot/lib/libc.a",
      libgcc: "/workspace/sysroot/lib/libgcc.a",
      sdkconfig,
      revisions: {
        min: revFlag(ninja, "min-rev", 0),
        minFull: revFlag(ninja, "min-rev-full", 0),
        maxFull: revFlag(ninja, "max-rev-full", 65535),
      },
      secureBoot: security.secureBoot,
      flashEncryption: security.flashEncryption,
    },
  };
}

function securitySources(chip: string, files: Map<string, Buffer>): { secureBoot: PackedSource[]; flashEncryption: PackedSource[] } {
  const idf = "/opt/esp-idf";
  const support = "libbootloader_support.a";
  const verify = "libesp_image_verify.a";
  const flashEncryption: PackedSource[] = [
    source(files, `${idf}/components/bootloader_support/src/flash_encryption/flash_encrypt.c`, support),
    source(
      files,
      chip === "esp32"
        ? `${idf}/components/bootloader_support/src/esp32/flash_encryption_secure_features.c`
        : `${idf}/components/bootloader_support/src/flash_encryption/flash_encryption_secure_features.c`,
      support,
    ),
  ];
  const secureBoot: PackedSource[] = chip === "esp32h4" ? [] : chip === "esp32" ? [
    source(files, `${idf}/components/esp_image_verify/src/secure_boot_v1/secure_boot.c`, verify),
    source(files, `${idf}/components/esp_image_verify/src/secure_boot_v1/secure_boot_signatures_bootloader.c`, verify),
    source(files, `${idf}/components/bootloader_support/src/esp32/secure_boot_secure_features.c`, support),
  ] : [
    source(files, `${idf}/components/esp_image_verify/src/secure_boot_v2/secure_boot.c`, verify),
    source(files, `${idf}/components/esp_image_verify/src/secure_boot_v2/secure_boot_signatures_bootloader.c`, verify),
    source(files, `${idf}/components/bootloader_support/src/secure_boot/secure_boot_secure_features.c`, support),
  ];
  return { secureBoot, flashEncryption };
}

function source(files: Map<string, Buffer>, unix: string, lib: string): PackedSource {
  const host = wsl(unix);
  if (!existsSync(host)) throw new Error(`security source is missing: ${unix}`);
  const src = guestOf(unix);
  files.set(src, readFileSync(host));
  addNeighborHeaders(unix.slice(0, unix.lastIndexOf("/")), files);
  return { src, lib };
}

function revFlag(text: string, name: string, fallback: number): number {
  const match = text.match(new RegExp(`--${name}(?!-)(?:=|\\s+)(\\d+)`));
  return match ? Number(match[1]) : fallback;
}

function pack(recipe: Recipe, files: Map<string, Buffer>): Buffer {
  const listed: { path: string; offset: number; size: number }[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  for (const [file, data] of files) {
    listed.push({ path: file, offset, size: data.length });
    parts.push(data);
    offset += data.length;
  }
  const head = Buffer.from(JSON.stringify({ ...recipe, files: listed }), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length, 0);
  return Buffer.concat([Buffer.from("ESPBOOT1"), len, head, ...parts]);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "public", "boot-sources");

function available(): string[] {
  const root = wsl("/opt/idf-targets");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) =>
    chips.has(name) && existsSync(wsl(`/opt/idf-targets/${name}/build/bootloader/compile_commands.json`)),
  );
}

const requested = process.argv.slice(2);
const chosen = requested.length ? requested : available();
if (!chosen.length) {
  console.error("No prepared bootloader directories under /opt/idf-targets.");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const written: string[] = [];
for (const chip of chosen) {
  if (!chips.has(chip)) {
    console.error(`unknown chip ${chip}`);
    process.exitCode = 1;
    continue;
  }
  const { recipe, files } = recipeFor(chip);
  const body = pack(recipe, files);
  writeFileSync(path.join(outDir, `${chip}.bin`), body);
  written.push(chip);
  console.log(`${chip} ${body.length}`);
}
const previous = existsSync(path.join(outDir, "index.json"))
  ? JSON.parse(readFileSync(path.join(outDir, "index.json"), "utf8")) as string[]
  : [];
const index = [...new Set([...previous, ...written])].filter((id) => existsSync(path.join(outDir, `${id}.bin`))).sort();
writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
