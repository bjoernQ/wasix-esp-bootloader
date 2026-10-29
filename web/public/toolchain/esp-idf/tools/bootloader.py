#!/usr/bin/env python3
"""Compile the second-stage bootloader with clang and ld.lld."""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import tempfile

MODES = {"qio": 0, "qout": 1, "dio": 2, "dout": 3}
FREQS = {"40m": 0, "26m": 1, "20m": 2, "80m": 0xF}
SIZES = {"1MB": 0, "2MB": 1, "4MB": 2, "8MB": 3, "16MB": 4, "32MB": 5, "64MB": 6, "128MB": 7}
LEVELS = {"none": 0, "error": 1, "warn": 2, "info": 3, "debug": 4, "verbose": 5}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chip", required=True)
    parser.add_argument("--mode", default="dio", choices=sorted(MODES))
    parser.add_argument("--freq", default="40m", choices=sorted(FREQS))
    parser.add_argument("--size", default="4MB", choices=sorted(SIZES))
    parser.add_argument("--log", default="info", choices=sorted(LEVELS))
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--rollback", type=int, default=0)
    parser.add_argument("--sha256", type=int, default=0)
    parser.add_argument("--reset-gpio", type=int, default=-1)
    parser.add_argument("--partition", default="0x8000")
    parser.add_argument("--chips", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--clang", default="clang")
    parser.add_argument("--ld", default="ld.lld")
    args = parser.parse_args(argv)
    chips = json.loads(open(args.chips, encoding="utf-8").read())
    chip = next((item for item in chips if item["id"] == args.chip), None)
    if chip is None:
        raise SystemExit(f"unknown chip {args.chip}")
    partition = int(args.partition, 0)
    image = build(chip, args, partition)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as handle:
        handle.write(image)
    print(f"chip {chip['label']} arch {chip['arch']}")
    print(f"flash {args.mode} {args.freq} {args.size} at 0x{chip['flashOffset']:x}")
    print(f"log {args.log} baud {args.baud} rollback {args.rollback} sha256 {args.sha256}")
    print(f"wrote {args.out} ({len(image)} bytes)")
    return 0


def build(chip: dict, args: argparse.Namespace, partition: int) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        obj = os.path.join(tmp, "bootloader.o")
        elf = os.path.join(tmp, "bootloader.elf")
        link = os.path.join(tmp, "bootloader.ld")
        config = os.path.join(tmp, "config.h")
        open(link, "w", encoding="utf-8").write(linker_script(chip))
        open(config, "w", encoding="utf-8").write(
            "\n".join([
                f"#define CONFIG_CHIP_LABEL \"{chip['label']}\"",
                f"#define CONFIG_LOG_LEVEL {LEVELS[args.log]}",
                f"#define CONFIG_FLASH_MODE \"{args.mode}\"",
                f"#define CONFIG_FLASH_FREQ \"{args.freq}\"",
                f"#define CONFIG_FLASH_SIZE \"{args.size}\"",
                f"#define CONFIG_BAUD {args.baud}",
                f"#define CONFIG_ROLLBACK {1 if args.rollback else 0}",
                f"#define CONFIG_REQUIRE_HASH {1 if args.sha256 else 0}",
                f"#define CONFIG_RESET_GPIO {args.reset_gpio}",
                f"#define CONFIG_PARTITION_OFFSET {partition}",
                "",
            ])
        )
        optimize = ["-Os", "-mllvm", "-global-isel"] if chip["arch"] == "riscv" else ["-O0"]
        compile_cmd = [args.clang, *target_flags(chip), "-ffreestanding", "-fno-builtin", "-fno-pic", *optimize, "-include", config, "-c", args.source, "-o", obj]
        run(compile_cmd)
        link_cmd = [args.ld, "-flavor", "gnu", *link_flags(chip), "-T", link, "-o", elf, obj]
        run(link_cmd)
        entry, segments = elf_segments(open(elf, "rb").read())
    if not segments:
        raise SystemExit("linker produced no loadable segments")
    return pack_image(entry, segments, chip["chipId"], MODES[args.mode], FREQS[args.freq], SIZES[args.size])


def target_flags(chip: dict) -> list[str]:
    if chip["arch"] == "xtensa":
        return ["--target=xtensa-esp-unknown-elf"]
    return ["--target=riscv32-esp-unknown-elf", "-march=rv32imc", "-mabi=ilp32"]


def link_flags(chip: dict) -> list[str]:
    if chip["arch"] == "riscv":
        return ["-m", "elf32lriscv"]
    return []


def linker_script(chip: dict) -> str:
    return f"""
ets_printf = 0x{chip['etsPrintf']:x};
esp_rom_spiflash_read = 0x{chip['spiRead']:x};
ENTRY(call_start_cpu0)
MEMORY {{
  iram_seg (RWX) : org = 0x{chip['iramOrg']:x}, len = 0x{chip['iramLen']:x}
  dram_seg (RW) : org = 0x{chip['dramOrg']:x}, len = 0x{chip['dramLen']:x}
}}
SECTIONS {{
  .text : {{
    *(.literal .literal.* .init.literal)
    *(.entry.text .text .text.* .init)
    *(.fini.literal .fini)
  }} > iram_seg
  .rodata : {{
    *(.rodata .rodata.* .sdata .sdata.*)
  }} > dram_seg
  .bss : {{
    *(.bss .bss.* COMMON)
  }} > dram_seg
}}
"""


def run(cmd: list[str]) -> None:
    print("$", " ".join(cmd), flush=True)
    done = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = done.stdout.decode("utf-8", "replace") if done.stdout else ""
    if text:
        print(text, end="" if text.endswith("\n") else "\n", flush=True)
    if done.returncode != 0:
        raise SystemExit(f"command failed ({done.returncode})")


def elf_segments(blob: bytes) -> tuple[int, list[tuple[int, bytes]]]:
    if blob[:4] != b"\x7fELF" or blob[4] != 1 or blob[5] != 1:
        raise SystemExit("expected a 32-bit little-endian ELF")
    entry = int.from_bytes(blob[24:28], "little")
    phoff = int.from_bytes(blob[28:32], "little")
    phentsize = int.from_bytes(blob[42:44], "little")
    phnum = int.from_bytes(blob[44:46], "little")
    segments = []
    for index in range(phnum):
        at = phoff + index * phentsize
        if int.from_bytes(blob[at:at + 4], "little") != 1:
            continue
        offset = int.from_bytes(blob[at + 4:at + 8], "little")
        vaddr = int.from_bytes(blob[at + 8:at + 12], "little")
        filesz = int.from_bytes(blob[at + 16:at + 20], "little")
        if filesz:
            segments.append((vaddr, blob[offset:offset + filesz]))
    return entry, segments


def pack_image(entry: int, segments: list[tuple[int, bytes]], chip_id: int, mode: int, freq: int, size: int) -> bytes:
    out = bytearray()
    out += struct.pack("<BBBBI", 0xE9, len(segments), mode, (size << 4) | freq, entry)
    out += struct.pack("<BBBBHBHH4sB", 0xEE, 0, 0, 0, chip_id, 0, 0, 0xFFFF, b"\x00\x00\x00\x00", 0)
    if len(out) != 24:
        raise SystemExit(f"image header is {len(out)} bytes")
    checksum = 0xEF
    for addr, data in segments:
        blob = data
        if len(blob) % 4:
            blob += b"\x00" * (4 - (len(blob) % 4))
        out += struct.pack("<II", addr, len(blob))
        out += blob
        for byte in blob:
            checksum ^= byte
    pad = (16 - 1) - (len(out) % 16)
    out += b"\x00" * pad
    out.append(checksum & 0xFF)
    return bytes(out)


if __name__ == "__main__":
    raise SystemExit(main())
