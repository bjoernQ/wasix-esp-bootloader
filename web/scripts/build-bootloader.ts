// Builds a bootloader from the command line with the same pipeline the page runs.
// npm run build-bootloader -- --chip esp32c3 [--freq 80m --size 8MB ... --out esp32c3.bin]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Wasmer } from "@wasmer/sdk/node";
import { chipById } from "../src/chips.ts";
import { compileIdfBootloader, type BuildHost } from "../src/compile-boot.ts";
import type { BootOptions } from "../src/options.ts";
import { defaultState } from "../src/query.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

const { values } = parseArgs({
  options: {
    chip: { type: "string", default: "esp32c6" },
    mode: { type: "string" },
    freq: { type: "string" },
    size: { type: "string" },
    log: { type: "string" },
    baud: { type: "string" },
    partition: { type: "string" },
    gpio: { type: "string" },
    rollback: { type: "boolean", default: false },
    "no-sha256": { type: "boolean", default: false },
    secure: { type: "boolean", default: false },
    key: { type: "string", default: "" },
    encryption: { type: "string", default: "off" },
    out: { type: "string" },
  },
});

const chip = chipById(values.chip);
const defaults = defaultState(chip.id);
const options: BootOptions = {
  chip: chip.id,
  mode: values.mode ?? defaults.mode,
  freq: values.freq ?? defaults.freq,
  size: values.size ?? defaults.size,
  logLevel: values.log ?? defaults.log,
  baud: Number(values.baud ?? defaults.baud),
  rollback: values.rollback,
  sha256: !values["no-sha256"],
  resetGpio: Number(values.gpio ?? defaults.gpio),
  partition: values.partition ?? defaults.partition,
  secureBoot: values.secure,
  verifyKey: values.key,
  encryption: values.encryption as BootOptions["encryption"],
};

const client = new Wasmer({ outputBytes: 8_000_000, cache: { directory: path.join(here, "..", ".wasmer-cache") } });
const host: BuildHost = {
  client: client as unknown as BuildHost["client"],
  loadSources: async (id) => readFileSync(path.join(publicDir, "boot-sources", `${id}.bin`)),
  loadCompiler: async () => ({
    clang: readFileSync(path.join(publicDir, "toolchain", "bin", "clang")),
    lld: readFileSync(path.join(publicDir, "toolchain", "bin", "lld")),
  }),
};

try {
  const started = Date.now();
  const image = await compileIdfBootloader(options, host, (line) => console.log(line));
  const out = values.out ?? `${chip.id}-bootloader.bin`;
  writeFileSync(out, image);
  console.log(`wrote ${out} (${image.length} bytes) in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await client.close();
}
