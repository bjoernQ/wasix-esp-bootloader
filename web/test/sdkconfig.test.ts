import assert from "node:assert/strict";
import { test } from "node:test";
import type { BootOptions } from "../src/options.ts";
import { patchConfig } from "../src/sdkconfig.ts";

const h2Config = `/* sdkconfig.h */
#define CONFIG_IDF_TARGET "esp32h2"
#define CONFIG_ESPTOOLPY_FLASHMODE_DIO 1
#define CONFIG_ESPTOOLPY_FLASHMODE "dio"
#define CONFIG_ESPTOOLPY_FLASHFREQ_64M 1
#define CONFIG_ESPTOOLPY_FLASHFREQ "48m"
#define CONFIG_ESPTOOLPY_FLASHSIZE_2MB 1
#define CONFIG_ESPTOOLPY_FLASHSIZE "2MB"
#define CONFIG_BOOTLOADER_LOG_LEVEL_INFO 1
#define CONFIG_BOOTLOADER_LOG_LEVEL 3
#define CONFIG_ESP_CONSOLE_UART_BAUDRATE 115200
#define CONFIG_PARTITION_TABLE_OFFSET 0x8000
`;

function options(overrides: Partial<BootOptions> = {}): BootOptions {
  return {
    chip: "esp32h2",
    mode: "qio",
    freq: "32m",
    size: "8MB",
    logLevel: "debug",
    baud: 921600,
    rollback: true,
    sha256: true,
    resetGpio: 9,
    partition: "40960",
    secureBoot: false,
    verifyKey: "",
    encryption: "off",
    ...overrides,
  };
}

function defined(text: string, name: string): string | undefined {
  return text.match(new RegExp(`^#define ${name} (.*)$`, "m"))?.[1];
}

test("basic options replace the packed choices", () => {
  const text = patchConfig(h2Config, options());
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHMODE_QIO"), "1");
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHMODE_DIO"), undefined);
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHMODE"), '"qio"');
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHSIZE_8MB"), "1");
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHSIZE_2MB"), undefined);
  assert.equal(defined(text, "CONFIG_BOOTLOADER_LOG_LEVEL"), "4");
  assert.equal(defined(text, "CONFIG_BOOTLOADER_LOG_LEVEL_DEBUG"), "1");
  assert.equal(defined(text, "CONFIG_BOOTLOADER_LOG_LEVEL_INFO"), undefined);
  assert.equal(defined(text, "CONFIG_ESP_CONSOLE_UART_BAUDRATE"), "921600");
  assert.equal(defined(text, "CONFIG_PARTITION_TABLE_OFFSET"), "0xa000");
  assert.equal(defined(text, "CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE"), "1");
  assert.equal(defined(text, "CONFIG_BOOTLOADER_FACTORY_RESET"), "1");
  assert.equal(defined(text, "CONFIG_BOOTLOADER_NUM_PIN_FACTORY_RESET"), "9");
  assert.equal(defined(text, "CONFIG_BOOTLOADER_SKIP_VALIDATE_ALWAYS"), undefined);
});

test("the H2 flash clock clears the packed 64M choice and uses the esptool name", () => {
  const text = patchConfig(h2Config, options({ freq: "32m" }));
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHFREQ_32M"), "1");
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHFREQ_64M"), undefined);
  assert.equal(defined(text, "CONFIG_ESPTOOLPY_FLASHFREQ"), '"24m"');
});

test("FLASHFREQ_VAL is updated only where the chip defines it", () => {
  const p4 = `${h2Config.replace("esp32h2", "esp32p4")}#define CONFIG_ESPTOOLPY_FLASHFREQ_VAL 80\n`;
  assert.equal(defined(patchConfig(p4, options({ chip: "esp32p4", freq: "40m" })), "CONFIG_ESPTOOLPY_FLASHFREQ_VAL"), "40");
  assert.equal(defined(patchConfig(h2Config, options()), "CONFIG_ESPTOOLPY_FLASHFREQ_VAL"), undefined);
});

test("secure boot V2 and release flash encryption", () => {
  const text = patchConfig(h2Config, options({ secureBoot: true, encryption: "release" }));
  assert.equal(defined(text, "CONFIG_SECURE_BOOT_V2_ENABLED"), "1");
  assert.equal(defined(text, "CONFIG_SECURE_BOOT_V2_RSA_ENABLED"), "1");
  assert.equal(defined(text, "CONFIG_SECURE_BOOT_V1_ENABLED"), undefined);
  assert.equal(defined(text, "CONFIG_SECURE_BOOT_ROM_FAST_WAKE_RESERVE_SIZE"), "32");
  assert.equal(defined(text, "CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE"), "1");
  assert.equal(defined(text, "CONFIG_SECURE_FLASH_ENCRYPTION_MODE_DEVELOPMENT"), undefined);
  assert.equal(defined(text, "CONFIG_SECURE_FLASH_UART_BOOTLOADER_ALLOW_ENC"), undefined);
  assert.equal(defined(text, "CONFIG_PARTITION_TABLE_MD5"), "1");
});

test("ESP32 uses Secure Boot V1 and ESP32-C2 uses ECDSA", () => {
  const esp32 = patchConfig(h2Config, options({ chip: "esp32", freq: "40m", secureBoot: true }));
  assert.equal(defined(esp32, "CONFIG_SECURE_BOOT_V1_ENABLED"), "1");
  assert.equal(defined(esp32, "CONFIG_SECURE_BOOT_V2_ENABLED"), undefined);
  const c2 = patchConfig(h2Config, options({ chip: "esp32c2", freq: "60m", secureBoot: true, encryption: "development" }));
  assert.equal(defined(c2, "CONFIG_SECURE_BOOT_V2_ECDSA_ENABLED"), "1");
  assert.equal(defined(c2, "CONFIG_SECURE_FLASH_ENCRYPTION_AES128_DERIVED"), "1");
  assert.equal(defined(c2, "CONFIG_SECURE_BOOT_FLASH_ENC_KEYS_BURN_TOGETHER"), "1");
});

test("turning off SHA-256 skips app validation", () => {
  const text = patchConfig(h2Config, options({ sha256: false }));
  assert.equal(defined(text, "CONFIG_BOOTLOADER_SKIP_VALIDATE_ALWAYS"), "1");
});
