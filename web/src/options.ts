import { chipById, flashFreq } from "./chips.ts";

export const modes = ["qio", "qout", "dio", "dout"] as const;
export const sizes = ["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"] as const;
export const logLevels = ["none", "error", "warn", "info", "debug", "verbose"] as const;
export const encryptions = ["off", "development", "release"] as const;

export type BootOptions = {
  chip: string;
  mode: string;
  freq: string;
  size: string;
  logLevel: string;
  baud: number;
  rollback: boolean;
  sha256: boolean;
  resetGpio: number;
  partition: string;
  secureBoot: boolean;
  /** ESP32 Secure Boot V1 verification public key, hex. Unused on other chips. */
  verifyKey: string;
  encryption: (typeof encryptions)[number];
};

const maxGpio = 63;
const maxBaud = 5_000_000;

/** Partition table offset in bytes, or throws. Accepts decimal or 0x hex. */
export function parsePartition(text: string): number {
  const value = text.trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(value)) throw new Error("Partition offset must be a decimal or 0x hex number.");
  return Number(value);
}

/** Throws with a user-facing message when the options cannot produce a working bootloader. */
export function validateOptions(options: BootOptions): void {
  const chip = chipById(options.chip);
  if (!(modes as readonly string[]).includes(options.mode)) throw new Error(`Unknown flash mode ${options.mode}.`);
  if (!(sizes as readonly string[]).includes(options.size)) throw new Error(`Unknown flash size ${options.size}.`);
  if (!(logLevels as readonly string[]).includes(options.logLevel)) throw new Error(`Unknown log level ${options.logLevel}.`);
  if (!(encryptions as readonly string[]).includes(options.encryption)) throw new Error(`Unknown flash encryption mode ${options.encryption}.`);
  flashFreq(chip, options.freq);
  if (!Number.isInteger(options.baud) || options.baud < 1 || options.baud > maxBaud) {
    throw new Error(`Baud must be an integer from 1 to ${maxBaud}.`);
  }
  if (!Number.isInteger(options.resetGpio) || options.resetGpio < -1 || options.resetGpio > maxGpio) {
    throw new Error(`Reset GPIO must be -1 (unused) or a pin number from 0 to ${maxGpio}.`);
  }
  const partition = parsePartition(options.partition);
  if (partition % 0x1000 !== 0) throw new Error("Partition offset must be a multiple of 0x1000.");
  if (partition <= chip.flashOffset) {
    throw new Error(`Partition offset must be above 0x${chip.flashOffset.toString(16)}, where ${chip.label} loads the bootloader.`);
  }
  const flashBytes = Number.parseInt(options.size, 10) * 1024 * 1024;
  if (partition + 0x1000 > flashBytes) throw new Error(`Partition offset does not fit in ${options.size} of flash.`);
  if (options.secureBoot) {
    if (!chip.secureBoot) throw new Error(`${chip.label} does not support secure boot.`);
    if (!options.sha256) throw new Error("Secure boot needs the SHA-256 image check. Turn on Require SHA-256.");
    if (chip.id === "esp32") parseVerifyKey(options.verifyKey);
    if (chip.id === "esp32" && options.encryption !== "off") {
      throw new Error("ESP32 Secure Boot V1 and flash encryption together do not fit in the loader IRAM with this compiler. Build with one of them.");
    }
  }
}

/** ESP32 Secure Boot V1 verification key: 64 raw bytes (X, Y), or 65 bytes with a leading 0x04. */
export function parseVerifyKey(value: string): Uint8Array {
  const hex = value.replace(/0x/gi, "").replace(/[\s:,]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("The verification public key must be hex.");
  if (hex.length % 2 !== 0) throw new Error("The verification public key must be an even number of hex digits.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  if (bytes.length === 65 && bytes[0] === 0x04) return bytes.subarray(1);
  if (bytes.length !== 64) throw new Error("ESP32 Secure Boot V1 needs the 64-byte verification public key (raw X and Y, hex).");
  return bytes;
}
