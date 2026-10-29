#!/usr/bin/env python3
"""Build the per-chip bootloader table from a local ESP-IDF checkout."""
import json
import re
from pathlib import Path

IDF = Path("/opt/esp-idf/components")
OUT = Path("/mnt/d/projects/testing/wasix-test/web/public/toolchain/bootloader/chips.json")
XTENSA = {"esp32", "esp32s2", "esp32s3"}
# ESP32 mask ROM SPIRead. Current IDF maps omit the symbol; the ROM address is unchanged.
SPIREAD_FALLBACK = {"esp32": 0x40062ED8}
CHIP_ID = {
    "esp32": 0x0000,
    "esp32s2": 0x0002,
    "esp32c3": 0x0005,
    "esp32s3": 0x0009,
    "esp32c2": 0x000C,
    "esp32c6": 0x000D,
    "esp32h2": 0x0010,
    "esp32p4": 0x0012,
    "esp32c61": 0x0014,
    "esp32c5": 0x0017,
    "esp32h21": 0x0019,
    "esp32h4": 0x001C,
    "esp32s31": 0x0020,
}


def label_of(chip: str) -> str:
    if chip == "esp32":
        return "ESP32"
    return "ESP32-" + chip[5:].upper()


def eval_expr(expr: str, vals: dict[str, int]) -> int:
    def repl(match: re.Match[str]) -> str:
        name = match.group(0)
        if name not in vals:
            raise KeyError(name)
        return str(vals[name])

    folded = re.sub(r"\b[A-Za-z_]\w*\b", repl, expr.strip())
    if not re.fullmatch(r"[0-9a-fA-FxX+\-*/() ]+", folded):
        raise ValueError(folded)
    return int(eval(folded, {"__builtins__": {}}, {}))


def assignments(text: str) -> dict[str, int]:
    vals: dict[str, int] = {}
    for raw in text.splitlines():
        line = raw.split("/*", 1)[0].strip()
        match = re.match(r"(\w+)\s*=\s*(.+);", line)
        if not match or match.group(1) == "MEMORY":
            continue
        try:
            vals[match.group(1)] = eval_expr(match.group(2), vals)
        except (KeyError, ValueError):
            continue
    return vals


def region(text: str, name: str, vals: dict[str, int]) -> tuple[int, int]:
    match = re.search(
        rf"{name}\s*\(RWX?\)\s*:\s*org\s*=\s*([^,]+),\s*len\s*=\s*(\S+)",
        text,
    )
    if not match:
        raise SystemExit(f"no {name} region")
    return eval_expr(match.group(1), vals), eval_expr(match.group(2), vals)


def symbol(text: str, name: str) -> int | None:
    match = re.search(
        rf"(?:PROVIDE\s*\(\s*)?{name}\s*=\s*(0x[0-9a-fA-F]+)",
        text,
    )
    return int(match.group(1), 16) if match else None


def main() -> None:
    chips = []
    for caps in sorted(IDF.glob("esp_rom/*/esp_rom_caps.h")):
        chip = caps.parent.name
        if chip in ("include", "linux"):
            continue
        memory = IDF / "bootloader/subproject/main/ld" / chip / "bootloader.memory.ld.in"
        rom = IDF / "esp_rom" / chip / "ld" / f"{chip}.rom.ld"
        if not memory.is_file() or not rom.is_file():
            raise SystemExit(f"missing map for {chip}")
        mem_text = memory.read_text(encoding="utf-8", errors="replace")
        vals = assignments(mem_text)
        iram_org, iram_len = region(mem_text, "iram_seg", vals)
        dram_org, dram_len = region(mem_text, "dram_seg", vals)
        rom_text = rom.read_text(encoding="utf-8", errors="replace")
        legacy = IDF / "esp_rom" / chip / "ld" / f"{chip}.rom.spiflash_legacy.ld"
        if legacy.is_file():
            rom_text += "\n" + legacy.read_text(encoding="utf-8", errors="replace")
        printf = symbol(rom_text, "ets_printf")
        spi = symbol(rom_text, "esp_rom_spiflash_read") or symbol(rom_text, "SPIRead")
        if spi is None and chip in SPIREAD_FALLBACK:
            spi = SPIREAD_FALLBACK[chip]
        offset = re.search(r"ESP_ROM_BOOTLOADER_OFFSET_FLASH\s+\((0x[0-9a-fA-F]+)\)", caps.read_text())
        if printf is None or spi is None or offset is None or chip not in CHIP_ID:
            raise SystemExit(f"incomplete {chip}: printf={printf} spi={spi} offset={offset}")
        chips.append({
            "id": chip,
            "label": label_of(chip),
            "arch": "xtensa" if chip in XTENSA else "riscv",
            "chipId": CHIP_ID[chip],
            "flashOffset": int(offset.group(1), 16),
            "iramOrg": iram_org,
            "iramLen": iram_len,
            "dramOrg": dram_org,
            "dramLen": dram_len,
            "etsPrintf": printf,
            "spiRead": spi,
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(chips, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(chips)} chips to {OUT}")


if __name__ == "__main__":
    main()
