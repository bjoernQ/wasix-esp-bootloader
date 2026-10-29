import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultChip, defaultState, readLink, writeLink } from "../src/query.ts";

test("an empty query gives the defaults", () => {
  const { state, warnings } = readLink("");
  assert.deepEqual(state, defaultState(defaultChip));
  assert.deepEqual(warnings, []);
});

test("a full link round-trips", () => {
  const search = "?chip=esp32s3&mode=qio&freq=80m&size=8MB&log=debug&partition=0x9000&gpio=0&rollback=1&encryption=development";
  const { state, warnings } = readLink(search);
  assert.deepEqual(warnings, []);
  assert.equal(state.chip, "esp32s3");
  assert.equal(state.freq, "80m");
  assert.equal(state.rollback, true);
  assert.equal(writeLink(state), search);
});

test("names, aliases and choices match without case", () => {
  const { state } = readLink("?CHIP=ESP32C3&Frequency=26M&Log-Level=WARN&flash-encryption=Release&rollback");
  assert.equal(state.chip, "esp32c3");
  assert.equal(state.freq, "26m");
  assert.equal(state.log, "warn");
  assert.equal(state.encryption, "release");
  assert.equal(state.rollback, true);
});

test("the frequency is checked against the chip", () => {
  const h2 = readLink("?chip=esp32h2&freq=40m");
  assert.equal(h2.state.freq, "64m");
  assert.deepEqual(h2.warnings, ['Ignored freq "40m".']);
  assert.equal(readLink("?chip=esp32c2&freq=15m").state.freq, "15m");
  assert.equal(readLink("?chip=esp32s3&freq=26m").state.freq, "40m");
});

test("bad values are ignored with a warning", () => {
  const { state, warnings } = readLink("?chip=esp99&baud=fast&gpio=-2&partition=here&rollback=maybe");
  assert.equal(state.chip, defaultChip);
  assert.equal(state.baud, "115200");
  assert.equal(state.gpio, "-1");
  assert.equal(state.partition, "0x8000");
  assert.equal(state.rollback, false);
  assert.equal(warnings.length, 5);
});

test("secure boot is dropped where the chip lacks it and forces SHA-256", () => {
  const h4 = readLink("?chip=esp32h4&secure=1");
  assert.equal(h4.state.secure, false);
  assert.match(h4.warnings[0] ?? "", /ESP32-H4 does not support/);
  const c3 = readLink("?chip=esp32c3&secure=1&sha256=0");
  assert.equal(c3.state.secure, true);
  assert.equal(c3.state.sha256, true);
});

test("the link always names the chip and leaves out defaults", () => {
  assert.equal(writeLink(defaultState("esp32")), "?chip=esp32");
  assert.equal(writeLink(defaultState("esp32h2")), "?chip=esp32h2");
});
