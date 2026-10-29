import { allFreqKconfig, chipById, flashFreq } from "./chips.ts";
import { logLevels, modes, parsePartition, sizes, type BootOptions } from "./options.ts";

const ecdsaV2 = new Set(["esp32c2", "esp32c61"]);
// ROM stores the verified image digest at the end of LP RAM. Kconfig reserves that many bytes only when secure boot is on.
const romFastWake = new Set(["esp32c5", "esp32c6", "esp32h2", "esp32h21", "esp32s31"]);

/** Rewrites the packed `sdkconfig.h` so it matches the options. */
export function patchConfig(text: string, options: BootOptions): string {
  const chip = chipById(options.chip);
  const freq = flashFreq(chip, options.freq);
  const level = logLevels.indexOf(options.logLevel as (typeof logLevels)[number]);
  text = choose(text, "CONFIG_ESPTOOLPY_FLASHMODE", options.mode.toUpperCase(), modes.map((mode) => mode.toUpperCase()), `"${options.mode}"`);
  text = choose(text, "CONFIG_ESPTOOLPY_FLASHFREQ", freq.kconfig, allFreqKconfig, `"${freq.esptool}"`);
  text = replaceIfDefined(text, "CONFIG_ESPTOOLPY_FLASHFREQ_VAL", String(Number.parseInt(freq.kconfig, 10)));
  text = choose(text, "CONFIG_ESPTOOLPY_FLASHSIZE", options.size, [...sizes], `"${options.size}"`);
  const levelName = options.logLevel.toUpperCase();
  const levelNames = logLevels.map((name) => name.toUpperCase());
  const levelValue = String(level < 0 ? 3 : level);
  text = choose(text, "CONFIG_BOOTLOADER_LOG_LEVEL", levelName, levelNames, levelValue);
  text = choose(text, "CONFIG_LOG_BOOTLOADER_LEVEL", levelName, levelNames, levelValue);
  text = setDefine(text, "CONFIG_ESP_CONSOLE_UART_BAUDRATE", String(options.baud));
  text = setDefine(text, "CONFIG_PARTITION_TABLE_OFFSET", `0x${parsePartition(options.partition).toString(16)}`);
  text = setBool(text, "CONFIG_BOOTLOADER_APP_ROLLBACK", options.rollback);
  text = setBool(text, "CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE", options.rollback);
  text = setBool(text, "CONFIG_BOOTLOADER_FACTORY_RESET", options.resetGpio >= 0);
  if (options.resetGpio >= 0) text = setDefine(text, "CONFIG_BOOTLOADER_NUM_PIN_FACTORY_RESET", String(options.resetGpio));
  text = setBool(text, "CONFIG_BOOTLOADER_SKIP_VALIDATE_ALWAYS", !options.sha256);
  return patchSecurity(text, options);
}

function patchSecurity(text: string, options: BootOptions): string {
  if (options.secureBoot) {
    if (!chipById(options.chip).secureBoot) throw new Error(`${options.chip} does not support secure boot.`);
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

function choose(text: string, prefix: string, selected: string, names: readonly string[], value: string): string {
  for (const name of names) text = setBool(text, `${prefix}_${name}`, name === selected);
  return setDefine(text, prefix, value);
}

function definePattern(name: string): RegExp {
  return new RegExp(`^#define ${name}(?![A-Za-z0-9_]).*$`, "m");
}

export function setBool(text: string, name: string, enabled: boolean): string {
  if (enabled) return setDefine(text, name, "1");
  return text.replace(definePattern(name), `/* ${name} unset */`);
}

export function setDefine(text: string, name: string, value: string): string {
  const line = `#define ${name} ${value}`;
  const pattern = definePattern(name);
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

function replaceIfDefined(text: string, name: string, value: string): string {
  return definePattern(name).test(text) ? setDefine(text, name, value) : text;
}
