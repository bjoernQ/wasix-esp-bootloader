/* Second-stage bootloader. ROM supplies ets_printf and esp_rom_spiflash_read. */
typedef unsigned uint32_t;
typedef unsigned short uint16_t;
typedef unsigned char uint8_t;

int ets_printf(const char *fmt, ...);
int esp_rom_spiflash_read(uint32_t src, uint32_t *dest, int len);

enum {
  PART_MAGIC = 0x50AA,
  APP_TYPE = 0x00,
  DATA_TYPE = 0x01,
  FACTORY = 0x00,
  OTA_0 = 0x10,
  OTA_1 = 0x11,
  OTA_DATA = 0x00
};

struct part {
  uint16_t magic;
  uint8_t type;
  uint8_t subtype;
  uint32_t offset;
  uint32_t size;
  char name[16];
  uint32_t flags;
};

struct image_hdr {
  uint8_t magic;
  uint8_t segments;
  uint8_t mode;
  uint8_t size_freq;
  uint32_t entry;
  uint8_t rest[16];
};

static uint32_t read_part(uint32_t addr, struct part *out) {
  uint32_t raw[8];
  if (esp_rom_spiflash_read(addr, raw, (int)sizeof(raw)) != 0) return 0;
  out->magic = (uint16_t)(raw[0] & 0xffff);
  out->type = (uint8_t)((raw[0] >> 16) & 0xff);
  out->subtype = (uint8_t)((raw[0] >> 24) & 0xff);
  out->offset = raw[1];
  out->size = raw[2];
  return out->magic;
}

static int name_eq(const char *value, const char *expect) {
  for (int i = 0; i < 16; i++) {
    char left = ((const char *)value)[i];
    char right = expect[i];
    if (left != right) return 0;
    if (left == 0) return 1;
  }
  return 1;
}

void call_start_cpu0(void) {
  struct part chosen;
  chosen.offset = 0;
  chosen.size = 0;
  chosen.subtype = 0xff;
  uint32_t ota_seq = 0;
  int have_ota = 0;
  struct part factory;
  factory.offset = 0;
  struct part ota0;
  ota0.offset = 0;
  struct part ota1;
  ota1.offset = 0;
  int saw = 0;

#if CONFIG_LOG_LEVEL >= 3
  ets_printf("\n2nd stage bootloader\n");
  ets_printf("chip %s\n", CONFIG_CHIP_LABEL);
  ets_printf("flash %s %s %s\n", CONFIG_FLASH_MODE, CONFIG_FLASH_FREQ, CONFIG_FLASH_SIZE);
  ets_printf("baud %u\n", (unsigned)CONFIG_BAUD);
  ets_printf("partition table 0x%x\n", (unsigned)CONFIG_PARTITION_OFFSET);
#if CONFIG_ROLLBACK
  ets_printf("app rollback on\n");
#else
  ets_printf("app rollback off\n");
#endif
#if CONFIG_REQUIRE_HASH
  ets_printf("app image must include sha256\n");
#endif
#if CONFIG_RESET_GPIO >= 0
  ets_printf("factory reset gpio %u\n", (unsigned)CONFIG_RESET_GPIO);
#endif
#endif

  for (uint32_t slot = 0; slot < 96; slot++) {
    struct part part;
    uint32_t magic = read_part(CONFIG_PARTITION_OFFSET + (slot << 5), &part);
    if (magic == 0xffff || magic == 0) break;
    if (magic != PART_MAGIC) break;
    saw++;
    if (part.type == APP_TYPE && part.subtype == FACTORY) factory = part;
    if (part.type == APP_TYPE && part.subtype == OTA_0) ota0 = part;
    if (part.type == APP_TYPE && part.subtype == OTA_1) ota1 = part;
    if (part.type == DATA_TYPE && part.subtype == OTA_DATA) {
      uint32_t seq[8];
      if (esp_rom_spiflash_read(part.offset, seq, 32) == 0) {
        ota_seq = seq[0];
        have_ota = 1;
      }
    }
#if CONFIG_LOG_LEVEL >= 4
    ets_printf("part %u type %u subtype %u off 0x%x\n", slot, part.type, part.subtype, part.offset);
#endif
    (void)name_eq;
  }

#if CONFIG_ROLLBACK
  if (have_ota && (ota_seq & 1u) == 0 && ota0.offset) chosen = ota0;
  else if (have_ota && ota1.offset) chosen = ota1;
  else if (ota0.offset) chosen = ota0;
  else chosen = factory;
#else
  chosen = factory.offset ? factory : ota0;
#endif
  (void)have_ota;
  (void)ota_seq;

#if CONFIG_LOG_LEVEL >= 2
  if (!saw) ets_printf("no partition table\n");
#endif
  if (!chosen.offset) {
#if CONFIG_LOG_LEVEL >= 1
    ets_printf("no application partition\n");
#endif
    for (;;) {}
  }

  struct image_hdr image;
  uint32_t words[6];
  if (esp_rom_spiflash_read(chosen.offset, words, 24) != 0) {
#if CONFIG_LOG_LEVEL >= 1
    ets_printf("app header read failed\n");
#endif
    for (;;) {}
  }
  image.magic = (uint8_t)(words[0] & 0xff);
  image.segments = (uint8_t)((words[0] >> 8) & 0xff);
  image.entry = words[1];
  image.rest[15] = (uint8_t)((words[5] >> 24) & 0xff);
#if CONFIG_LOG_LEVEL >= 3
  ets_printf("app off 0x%x magic 0x%x entry 0x%x\n", chosen.offset, image.magic, image.entry);
#endif
  if (image.magic != 0xe9) {
#if CONFIG_LOG_LEVEL >= 1
    ets_printf("app image magic is not 0xe9\n");
#endif
    for (;;) {}
  }
#if CONFIG_REQUIRE_HASH
  if (image.rest[15] != 1) {
#if CONFIG_LOG_LEVEL >= 1
    ets_printf("rejected app without sha256\n");
#endif
    for (;;) {}
  }
#endif
#if CONFIG_LOG_LEVEL >= 3
  ets_printf("bootloader checked the application and stopped\n");
  ets_printf("reflash the IDF bootloader to map and jump to XIP code\n");
#endif
  for (;;) {}
}
