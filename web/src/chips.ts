/**
 * Flash frequencies per chip. `kconfig` is the ESP-IDF `CONFIG_ESPTOOLPY_FLASHFREQ_*` choice
 * (components/spi_flash/<chip>/Kconfig.flash_freq), `esptool` is the string ESP-IDF passes to
 * esptool for it (components/esptool_py/Kconfig.projbuild), and `header` is the image header
 * nibble esptool writes for that string (esptool/targets/<chip>.py, esptool 5.6).
 * 120 MHz is left out: ESP-IDF only allows it together with extra timing-tuning options.
 */
export type FlashFreq = { id: string; kconfig: string; esptool: string; header: number };

export type Chip = {
  id: string;
  label: string;
  arch: "xtensa" | "riscv";
  /** Image header chip id (esptool IMAGE_CHIP_ID). */
  chipId: number;
  /** Where the ROM loads the second-stage bootloader from (ESP_ROM_BOOTLOADER_OFFSET_FLASH). */
  flashOffset: number;
  freqs: readonly FlashFreq[];
  defaultFreq: string;
  secureBoot: boolean;
};

const esp32Freqs: FlashFreq[] = [
  { id: "80m", kconfig: "80M", esptool: "80m", header: 0xf },
  { id: "40m", kconfig: "40M", esptool: "40m", header: 0x0 },
  { id: "26m", kconfig: "26M", esptool: "26m", header: 0x1 },
  { id: "20m", kconfig: "20M", esptool: "20m", header: 0x2 },
];
const noTwentySix = esp32Freqs.filter((freq) => freq.id !== "26m");
const c2Freqs: FlashFreq[] = [
  { id: "60m", kconfig: "60M", esptool: "60m", header: 0xf },
  { id: "30m", kconfig: "30M", esptool: "30m", header: 0x0 },
  { id: "20m", kconfig: "20M", esptool: "20m", header: 0x1 },
  { id: "15m", kconfig: "15M", esptool: "15m", header: 0x2 },
];
// esptool writes 0 for 80 MHz on the C6 to work around a wrong MSPI divider in ROM.
const c6Freqs: FlashFreq[] = [
  { id: "80m", kconfig: "80M", esptool: "80m", header: 0x0 },
  { id: "40m", kconfig: "40M", esptool: "40m", header: 0x0 },
  { id: "20m", kconfig: "20M", esptool: "20m", header: 0x2 },
];
const h2Freqs: FlashFreq[] = [
  { id: "64m", kconfig: "64M", esptool: "48m", header: 0xf },
  { id: "32m", kconfig: "32M", esptool: "24m", header: 0x0 },
  { id: "16m", kconfig: "16M", esptool: "12m", header: 0x2 },
];
const h21Freqs = h2Freqs.filter((freq) => freq.id !== "16m");

export const chips: readonly Chip[] = [
  { id: "esp32", label: "ESP32", arch: "xtensa", chipId: 0, flashOffset: 0x1000, freqs: esp32Freqs, defaultFreq: "40m", secureBoot: true },
  { id: "esp32c2", label: "ESP32-C2", arch: "riscv", chipId: 12, flashOffset: 0x0, freqs: c2Freqs, defaultFreq: "60m", secureBoot: true },
  { id: "esp32c3", label: "ESP32-C3", arch: "riscv", chipId: 5, flashOffset: 0x0, freqs: esp32Freqs, defaultFreq: "40m", secureBoot: true },
  { id: "esp32c5", label: "ESP32-C5", arch: "riscv", chipId: 23, flashOffset: 0x2000, freqs: noTwentySix, defaultFreq: "40m", secureBoot: true },
  { id: "esp32c6", label: "ESP32-C6", arch: "riscv", chipId: 13, flashOffset: 0x0, freqs: c6Freqs, defaultFreq: "40m", secureBoot: true },
  { id: "esp32c61", label: "ESP32-C61", arch: "riscv", chipId: 20, flashOffset: 0x0, freqs: noTwentySix, defaultFreq: "40m", secureBoot: true },
  { id: "esp32h2", label: "ESP32-H2", arch: "riscv", chipId: 16, flashOffset: 0x0, freqs: h2Freqs, defaultFreq: "64m", secureBoot: true },
  { id: "esp32h21", label: "ESP32-H21", arch: "riscv", chipId: 25, flashOffset: 0x0, freqs: h21Freqs, defaultFreq: "64m", secureBoot: true },
  { id: "esp32h4", label: "ESP32-H4", arch: "riscv", chipId: 28, flashOffset: 0x2000, freqs: h21Freqs, defaultFreq: "64m", secureBoot: false },
  { id: "esp32p4", label: "ESP32-P4", arch: "riscv", chipId: 18, flashOffset: 0x2000, freqs: noTwentySix, defaultFreq: "40m", secureBoot: true },
  { id: "esp32s2", label: "ESP32-S2", arch: "xtensa", chipId: 2, flashOffset: 0x1000, freqs: esp32Freqs, defaultFreq: "40m", secureBoot: true },
  { id: "esp32s3", label: "ESP32-S3", arch: "xtensa", chipId: 9, flashOffset: 0x0, freqs: noTwentySix, defaultFreq: "40m", secureBoot: true },
  { id: "esp32s31", label: "ESP32-S31", arch: "riscv", chipId: 32, flashOffset: 0x2000, freqs: noTwentySix, defaultFreq: "40m", secureBoot: true },
];

export const chipIds = chips.map((chip) => chip.id);

export function chipById(id: string): Chip {
  const chip = chips.find((item) => item.id === id);
  if (!chip) throw new Error(`unknown chip ${id}`);
  return chip;
}

export function flashFreq(chip: Chip, id: string): FlashFreq {
  const freq = chip.freqs.find((item) => item.id === id);
  if (!freq) throw new Error(`${chip.label} does not support a ${id} flash clock. Choose ${chip.freqs.map((item) => item.id).join(", ")}.`);
  return freq;
}

/** Every `CONFIG_ESPTOOLPY_FLASHFREQ_*` suffix any chip uses, so a patch can clear the ones not chosen. */
export const allFreqKconfig = ["120M", "80M", "64M", "60M", "48M", "40M", "32M", "30M", "26M", "24M", "20M", "16M", "15M"];
