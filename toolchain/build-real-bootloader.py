#!/usr/bin/env python3
"""Build the ESP-IDF second-stage bootloader for one chip."""

from __future__ import annotations

import argparse
import fcntl
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

CHIPS = [
    "esp32", "esp32c2", "esp32c3", "esp32c5", "esp32c6", "esp32c61",
    "esp32h2", "esp32h21", "esp32h4", "esp32p4", "esp32s2", "esp32s3", "esp32s31",
]
MODES = ["qio", "qout", "dio", "dout"]
FREQS = ["80m", "40m", "26m", "20m"]
SIZES = ["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"]
LOGS = {"none": 0, "error": 1, "warn": 2, "info": 3, "debug": 4, "verbose": 5}

IDF = Path("/opt/esp-idf")
HELLO = IDF / "examples" / "get-started" / "hello_world"
ROOT = Path("/opt/idf-targets")
PY = "/opt/idf-venv/bin/python"
IDF_PY = str(IDF / "tools" / "idf.py")


def environment() -> dict[str, str]:
    env = os.environ.copy()
    env["IDF_PATH"] = str(IDF)
    env["IDF_PYTHON_ENV_PATH"] = "/opt/idf-venv"
    env["ESP_IDF_VERSION"] = "6.2.0"
    env["PYTHONUNBUFFERED"] = "1"
    prefix = ":".join([
        "/opt/idf-venv/bin",
        "/opt/esp-clang/sysroots/riscv32-esp-elf/bin",
        "/opt/esp-clang/sysroots/xtensa-esp-elf/bin",
    ])
    env["PATH"] = prefix + ":" + env.get("PATH", "/usr/bin:/bin")
    return env


def run(args: list[str], cwd: Path) -> None:
    print("$", " ".join(args), flush=True)
    proc = subprocess.Popen(
        args,
        cwd=cwd,
        env=environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line, end="", flush=True)
    code = proc.wait()
    if code != 0:
        raise SystemExit(code)


def set_line(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf"^(?:# )?{re.escape(key)}(?:=.*| is not set)$", re.M)
    replacement = f"{key}={value}"
    if pattern.search(text):
        return pattern.sub(replacement, text)
    return text.rstrip() + f"\n{replacement}\n"


def set_bool(text: str, key: str, enabled: bool) -> str:
    if enabled:
        return set_line(text, key, "y")
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.M)
    if pattern.search(text):
        return pattern.sub(f"# {key} is not set", text)
    return text


def set_choice(text: str, selected: str, options: list[str]) -> str:
    for name in options:
        text = set_bool(text, name, name == selected)
    return text


def defaults_text(args: argparse.Namespace) -> str:
    mode = f"CONFIG_ESPTOOLPY_FLASHMODE_{args.mode.upper()}"
    freq = f"CONFIG_ESPTOOLPY_FLASHFREQ_{args.freq.upper()}"
    size = f"CONFIG_ESPTOOLPY_FLASHSIZE_{args.size}"
    level = f"CONFIG_BOOTLOADER_LOG_LEVEL_{args.log.upper()}"
    lines = [
        f"{mode}=y",
        f'CONFIG_ESPTOOLPY_FLASHMODE="{args.mode}"',
        f"{freq}=y",
        f'CONFIG_ESPTOOLPY_FLASHFREQ="{args.freq}"',
        f"{size}=y",
        f'CONFIG_ESPTOOLPY_FLASHSIZE="{args.size}"',
        f"{level}=y",
        f"CONFIG_BOOTLOADER_LOG_LEVEL={LOGS[args.log]}",
        f"CONFIG_ESP_CONSOLE_UART_BAUDRATE={args.baud}",
        f"CONFIG_PARTITION_TABLE_OFFSET={args.partition}",
    ]
    if args.rollback:
        lines.append("CONFIG_BOOTLOADER_APP_ROLLBACK=y")
    if args.reset_gpio >= 0:
        lines.append("CONFIG_BOOTLOADER_FACTORY_RESET=y")
        lines.append(f"CONFIG_BOOTLOADER_NUM_PIN_FACTORY_RESET={args.reset_gpio}")
    if not args.sha256:
        lines.append("CONFIG_BOOTLOADER_SKIP_VALIDATE_ALWAYS=y")
    return "\n".join(lines) + "\n"


def patch(text: str, args: argparse.Namespace) -> str:
    text = set_choice(text, f"CONFIG_ESPTOOLPY_FLASHMODE_{args.mode.upper()}", [f"CONFIG_ESPTOOLPY_FLASHMODE_{m.upper()}" for m in MODES])
    text = set_line(text, "CONFIG_ESPTOOLPY_FLASHMODE", f'"{args.mode}"')
    text = set_choice(text, f"CONFIG_ESPTOOLPY_FLASHFREQ_{args.freq.upper()}", [f"CONFIG_ESPTOOLPY_FLASHFREQ_{f.upper()}" for f in FREQS])
    text = set_line(text, "CONFIG_ESPTOOLPY_FLASHFREQ", f'"{args.freq}"')
    text = set_choice(text, f"CONFIG_ESPTOOLPY_FLASHSIZE_{args.size}", [f"CONFIG_ESPTOOLPY_FLASHSIZE_{s}" for s in SIZES])
    text = set_line(text, "CONFIG_ESPTOOLPY_FLASHSIZE", f'"{args.size}"')
    text = set_choice(text, f"CONFIG_BOOTLOADER_LOG_LEVEL_{args.log.upper()}", [f"CONFIG_BOOTLOADER_LOG_LEVEL_{name.upper()}" for name in LOGS])
    text = set_line(text, "CONFIG_BOOTLOADER_LOG_LEVEL", str(LOGS[args.log]))
    text = set_choice(text, f"CONFIG_LOG_BOOTLOADER_LEVEL_{args.log.upper()}", [f"CONFIG_LOG_BOOTLOADER_LEVEL_{name.upper()}" for name in LOGS])
    text = set_line(text, "CONFIG_LOG_BOOTLOADER_LEVEL", str(LOGS[args.log]))
    text = set_choice(text, f"CONFIG_FLASHMODE_{args.mode.upper()}", [f"CONFIG_FLASHMODE_{m.upper()}" for m in MODES])
    text = set_line(text, "CONFIG_ESP_CONSOLE_UART_BAUDRATE", str(args.baud))
    text = set_line(text, "CONFIG_PARTITION_TABLE_OFFSET", args.partition)
    text = set_bool(text, "CONFIG_BOOTLOADER_APP_ROLLBACK", args.rollback)
    text = set_bool(text, "CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE", args.rollback)
    text = set_bool(text, "CONFIG_BOOTLOADER_FACTORY_RESET", args.reset_gpio >= 0)
    if args.reset_gpio >= 0:
        text = set_line(text, "CONFIG_BOOTLOADER_NUM_PIN_FACTORY_RESET", str(args.reset_gpio))
    text = set_bool(text, "CONFIG_BOOTLOADER_SKIP_VALIDATE_ALWAYS", not args.sha256)
    return text


def ensure_project(chip: str) -> Path:
    dest = ROOT / chip
    if not (dest / "CMakeLists.txt").exists():
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(
            HELLO,
            dest,
            ignore=shutil.ignore_patterns("build", "sdkconfig", "sdkconfig.old", "dependencies.lock", "managed_components"),
        )
    return dest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chip", required=True, choices=CHIPS)
    parser.add_argument("--mode", required=True, choices=MODES)
    parser.add_argument("--freq", required=True, choices=FREQS)
    parser.add_argument("--size", required=True, choices=SIZES)
    parser.add_argument("--log", required=True, choices=sorted(LOGS))
    parser.add_argument("--baud", type=int, required=True)
    parser.add_argument("--rollback", type=int, choices=(0, 1), required=True)
    parser.add_argument("--sha256", type=int, choices=(0, 1), required=True)
    parser.add_argument("--reset-gpio", type=int, required=True)
    parser.add_argument("--partition", required=True)
    args = parser.parse_args()
    args.rollback = bool(args.rollback)
    args.sha256 = bool(args.sha256)
    if args.baud < 1 or args.baud > 5_000_000:
        raise SystemExit("baud is out of range")
    if args.reset_gpio < -1 or args.reset_gpio > 62:
        raise SystemExit("reset gpio is out of range")
    if not re.fullmatch(r"0x[0-9a-fA-F]+|\d+", args.partition):
        raise SystemExit("partition offset must be decimal or 0x hex")
    if args.partition.isdigit():
        args.partition = hex(int(args.partition))

    ROOT.mkdir(parents=True, exist_ok=True)
    lock_file = open(ROOT / ".lock", "w")
    fcntl.flock(lock_file, fcntl.LOCK_EX)
    project = ensure_project(args.chip)
    (project / "sdkconfig.defaults").write_text(defaults_text(args), encoding="utf-8")
    if not (project / "sdkconfig").exists():
        print(f"Configuring the ESP-IDF bootloader for {args.chip}", flush=True)
        run([PY, IDF_PY, "-C", str(project), "set-target", args.chip], project)
    sdkconfig = project / "sdkconfig"
    sdkconfig.write_text(patch(sdkconfig.read_text(encoding="utf-8"), args), encoding="utf-8")
    print(f"Building the ESP-IDF bootloader for {args.chip}", flush=True)
    run([PY, IDF_PY, "-C", str(project), "bootloader"], project)
    image = project / "build" / "bootloader" / "bootloader.bin"
    data = image.read_bytes()
    if len(data) < 8000 or data[0] != 0xE9:
        raise SystemExit(f"refusing {image} ({len(data)} bytes), it is not an ESP-IDF bootloader image")
    print(f"ESP-IDF bootloader {len(data)} bytes, chip id {int.from_bytes(data[12:14], 'little')}", flush=True)
    print(f"IMAGE /api/bootloader-image?chip={args.chip}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as error:
        print(f"ERROR {error}", flush=True)
        sys.exit(1)
