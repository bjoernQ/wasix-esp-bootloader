/** Link query: chip, mode, freq, size, log, baud, partition, gpio, rollback, sha256, secure, key, encryption. */
import { chipById, chipIds } from "./chips.ts";
import { encryptions, logLevels, modes, sizes } from "./options.ts";

export type LinkState = {
  chip: string;
  mode: string;
  freq: string;
  size: string;
  log: string;
  baud: string;
  partition: string;
  gpio: string;
  rollback: boolean;
  sha256: boolean;
  secure: boolean;
  key: string;
  encryption: string;
};

const aliases: Record<string, string[]> = {
  chip: ["chip"],
  mode: ["mode"],
  freq: ["freq", "frequency"],
  size: ["size"],
  log: ["log", "log-level"],
  baud: ["baud"],
  partition: ["partition"],
  gpio: ["gpio", "reset-gpio"],
  rollback: ["rollback"],
  sha256: ["sha256", "sha-256"],
  secure: ["secure", "secure-boot"],
  key: ["key", "verify-key"],
  encryption: ["encryption", "flash-encryption"],
};

export const defaultChip = "esp32c6";

export function readLink(search: string): { state: LinkState; warnings: string[] } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const warnings: string[] = [];

  const chip = matchChoice(params, "chip", chipIds, warnings);
  const state = defaultState(chip ?? defaultChip);
  const mode = matchChoice(params, "mode", modes, warnings);
  if (mode) state.mode = mode;
  const freq = matchChoice(params, "freq", chipById(state.chip).freqs.map((item) => item.id), warnings);
  if (freq) state.freq = freq;
  const size = matchChoice(params, "size", sizes, warnings);
  if (size) state.size = size;
  const log = matchChoice(params, "log", logLevels, warnings);
  if (log) state.log = log;
  const encryption = matchChoice(params, "encryption", encryptions, warnings);
  if (encryption) state.encryption = encryption;

  const baud = matchInt(params, "baud", warnings, (value) => value >= 1);
  if (baud !== null) state.baud = baud;
  const gpio = matchInt(params, "gpio", warnings, (value) => value >= -1);
  if (gpio !== null) state.gpio = gpio;

  const partition = param(params, "partition");
  if (partition !== null) {
    const text = partition.trim().replace(/^0x/i, "0x");
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) {
      state.partition = text.toLowerCase() === state.partition.toLowerCase() ? state.partition : text;
    } else {
      warnings.push(`Ignored partition "${clip(partition)}".`);
    }
  }

  const rollback = matchBool(params, "rollback", warnings);
  if (rollback !== null) state.rollback = rollback;
  const sha256 = matchBool(params, "sha256", warnings);
  if (sha256 !== null) state.sha256 = sha256;
  const secure = matchBool(params, "secure", warnings);
  if (secure !== null) state.secure = secure;

  const key = param(params, "key");
  if (key !== null) state.key = key.trim();

  const chipInfo = chipById(state.chip);
  if (!chipInfo.secureBoot && state.secure) {
    state.secure = false;
    warnings.push(`Secure boot was left off. ${chipInfo.label} does not support it.`);
  }
  if (state.secure && !state.sha256) {
    state.sha256 = true;
    warnings.push("Require SHA-256 was turned on. Secure boot needs it.");
  }

  return { state, warnings };
}

export function writeLink(state: LinkState): string {
  const base = defaultState(state.chip);
  const params = new URLSearchParams();
  params.set("chip", state.chip);
  if (state.mode !== base.mode) params.set("mode", state.mode);
  if (state.freq !== base.freq) params.set("freq", state.freq);
  if (state.size !== base.size) params.set("size", state.size);
  if (state.log !== base.log) params.set("log", state.log);
  const baud = state.baud.trim();
  if (baud !== base.baud) params.set("baud", baud);
  const partition = state.partition.trim();
  if (partition.toLowerCase() !== base.partition.toLowerCase()) params.set("partition", partition);
  const gpio = state.gpio.trim();
  if (gpio !== base.gpio) params.set("gpio", gpio);
  if (state.rollback !== base.rollback) params.set("rollback", state.rollback ? "1" : "0");
  if (state.sha256 !== base.sha256) params.set("sha256", state.sha256 ? "1" : "0");
  const secure = chipById(state.chip).secureBoot && state.secure;
  if (secure !== base.secure) params.set("secure", secure ? "1" : "0");
  const key = state.key.trim();
  if (key) params.set("key", key);
  if (state.encryption !== base.encryption) params.set("encryption", state.encryption);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function defaultState(chip: string): LinkState {
  return {
    chip,
    mode: "dio",
    freq: chipById(chip).defaultFreq,
    size: "4MB",
    log: "info",
    baud: "115200",
    partition: "0x8000",
    gpio: "-1",
    rollback: false,
    sha256: true,
    secure: false,
    key: "",
    encryption: "off",
  };
}

function param(params: URLSearchParams, name: string): string | null {
  const names = aliases[name] ?? [name];
  const entries = [...params.entries()];
  for (const alias of names) {
    const found = entries.find(([key]) => key.toLowerCase() === alias);
    if (found) return found[1];
  }
  return null;
}

function matchChoice(params: URLSearchParams, name: string, allowed: readonly string[], warnings: string[]): string | null {
  const raw = param(params, name);
  if (raw === null) return null;
  const match = allowed.find((value) => value.toLowerCase() === raw.trim().toLowerCase());
  if (match) return match;
  warnings.push(`Ignored ${name} "${clip(raw)}".`);
  return null;
}

function matchInt(params: URLSearchParams, name: string, warnings: string[], accept: (value: number) => boolean): string | null {
  const raw = param(params, name);
  if (raw === null) return null;
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) {
    warnings.push(`Ignored ${name} "${clip(raw)}".`);
    return null;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || !accept(value)) {
    warnings.push(`Ignored ${name} "${clip(raw)}".`);
    return null;
  }
  return String(value);
}

function matchBool(params: URLSearchParams, name: string, warnings: string[]): boolean | null {
  const raw = param(params, name);
  if (raw === null) return null;
  if (raw.trim() === "") return true;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      warnings.push(`Ignored ${name} "${clip(raw)}".`);
      return null;
  }
}

function clip(raw: string): string {
  const text = raw.trim();
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}
