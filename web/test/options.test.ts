import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVerifyKey, validateOptions, type BootOptions } from "../src/options.ts";

function options(overrides: Partial<BootOptions> = {}): BootOptions {
  return {
    chip: "esp32c3",
    mode: "dio",
    freq: "40m",
    size: "4MB",
    logLevel: "info",
    baud: 115200,
    rollback: false,
    sha256: true,
    resetGpio: -1,
    partition: "0x8000",
    secureBoot: false,
    verifyKey: "",
    encryption: "off",
    ...overrides,
  };
}

test("defaults are valid for every chip at its default clock", async () => {
  const { chips } = await import("../src/chips.ts");
  for (const chip of chips) validateOptions(options({ chip: chip.id, freq: chip.defaultFreq }));
});

test("partition offsets are checked", () => {
  validateOptions(options({ partition: "36864" }));
  assert.throws(() => validateOptions(options({ partition: "abc" })), /decimal or 0x hex/);
  assert.throws(() => validateOptions(options({ partition: "0x8800" })), /multiple of 0x1000/);
  assert.throws(() => validateOptions(options({ chip: "esp32", partition: "0x1000" })), /above 0x1000/);
  assert.throws(() => validateOptions(options({ size: "1MB", partition: "0x100000" })), /does not fit/);
});

test("baud and reset GPIO are range-checked", () => {
  assert.throws(() => validateOptions(options({ baud: 0 })), /Baud/);
  assert.throws(() => validateOptions(options({ baud: 1.5 })), /Baud/);
  assert.throws(() => validateOptions(options({ resetGpio: -2 })), /Reset GPIO/);
  assert.throws(() => validateOptions(options({ resetGpio: Number.NaN })), /Reset GPIO/);
  validateOptions(options({ resetGpio: 9 }));
});

test("flash clocks are per chip", () => {
  assert.throws(() => validateOptions(options({ chip: "esp32h2", freq: "40m" })), /ESP32-H2 does not support a 40m/);
  assert.throws(() => validateOptions(options({ chip: "esp32s3", freq: "26m" })), /26m/);
  validateOptions(options({ chip: "esp32c2", freq: "60m" }));
});

test("secure boot rules", () => {
  assert.throws(() => validateOptions(options({ chip: "esp32h4", freq: "64m", secureBoot: true })), /does not support secure boot/);
  assert.throws(() => validateOptions(options({ secureBoot: true, sha256: false })), /SHA-256/);
  assert.throws(() => validateOptions(options({ chip: "esp32", secureBoot: true })), /64-byte/);
  validateOptions(options({ chip: "esp32", secureBoot: true, verifyKey: "ab".repeat(64) }));
  assert.throws(
    () => validateOptions(options({ chip: "esp32", secureBoot: true, verifyKey: "ab".repeat(64), encryption: "development" })),
    /do not fit/,
  );
  validateOptions(options({ chip: "esp32", encryption: "release" }));
});

test("verification keys", () => {
  assert.equal(parseVerifyKey("ab".repeat(64)).length, 64);
  assert.equal(parseVerifyKey(`04${"cd".repeat(64)}`)[0], 0xcd);
  assert.equal(parseVerifyKey(`0x${"ab:".repeat(64)}`).length, 64);
  assert.throws(() => parseVerifyKey("zz".repeat(64)), /must be hex/);
  assert.throws(() => parseVerifyKey("abc"), /even number/);
  assert.throws(() => parseVerifyKey("ab".repeat(32)), /64-byte/);
});
