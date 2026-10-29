#!/usr/bin/env python3
"""Build an ESP-IDF-shaped project into an ESP32 ROM image.

This is the driver the browser runs under WASIX Python. It reads the same
project layout `idf.py build` expects (CMakeLists.txt, main/, sdkconfig) and
compiles the C subset in ccomp.py. The image is ROM-bootable at 0x1000: it
replaces the second-stage bootloader, and a later esptool flash of ordinary
ESP-IDF firmware puts the chip back.
"""

from __future__ import annotations

import json
import os
import sys

import ccomp

HERE = os.path.dirname(os.path.abspath(__file__))
IDF_PATH = os.path.dirname(HERE)


def main(argv: list[str]) -> int:
    project = os.getcwd()
    args = argv[1:]
    while args and args[0] == "-C":
        if len(args) < 2:
            return _fail("idf.py -C needs a directory")
        project = args[1]
        args = args[2:]
    if not args or args[0] in ("-h", "--help"):
        print("usage: python idf.py -C <project> build")
        return 0 if args else 1
    if args[0] != "build":
        return _fail(f"only 'build' is implemented, got {args[0]!r}")
    try:
        built = build(project)
    except (ccomp.BuildError, OSError) as exc:
        return _fail(str(exc))
    print(f"Project: {built['project']}")
    print("Target: esp32")
    print("Toolchain: WASIX Python, Xtensa subset compiler (not xtensa-esp-elf GCC)")
    print("Image: ROM boot at 0x1000, DIO, 4MB, 40MHz. No SHA-256 digest.")
    print(f"Wrote {built['bin']} ({built['size']} bytes), entry 0x{built['entry']:08x}")
    return 0


def build(project: str) -> dict:
    project = os.path.abspath(project)
    target = _read_target(os.path.join(project, "sdkconfig"))
    if target != "esp32":
        raise ccomp.BuildError(f"sdkconfig target is {target!r}; this image format is ESP32")
    name = _project_name(os.path.join(project, "CMakeLists.txt"))
    sources = _main_sources(project)
    builtins = [
        os.path.join(IDF_PATH, "components", "newlib", "src", "fflush.c"),
        os.path.join(IDF_PATH, "components", "esp_wifi", "src", "esp_wifi_stub.c"),
    ]
    include_dirs = _include_dirs()
    print("Compiling:")
    for path in sources + builtins:
        print(f"  {os.path.relpath(path, project) if path.startswith(project) else path}")
    linked = ccomp.compile_files(sources + builtins, include_dirs)
    out_dir = os.path.join(project, "build")
    os.makedirs(out_dir, exist_ok=True)
    bin_name = f"{name}.bin"
    bin_path = os.path.join(out_dir, bin_name)
    with open(bin_path, "wb") as handle:
        handle.write(linked.image)
    flasher = {
        "flash_files": {"0x1000": bin_name},
        "flash_settings": {"flash_mode": "dio", "flash_size": "4MB", "flash_freq": "40m"},
        "extra": {"rom_boot": True, "offset": "0x1000", "chip": "esp32"},
    }
    with open(os.path.join(out_dir, "flasher_args.json"), "w", encoding="utf-8") as handle:
        json.dump(flasher, handle, indent=2)
        handle.write("\n")
    return {
        "project": name,
        "bin": bin_path,
        "size": len(linked.image),
        "entry": linked.entry,
        "image": linked.image,
        "linked": linked,
    }


def _include_dirs() -> list[str]:
    root = os.path.join(IDF_PATH, "components")
    found = []
    for name in sorted(os.listdir(root)):
        include = os.path.join(root, name, "include")
        if os.path.isdir(include):
            found.append(include)
    if not found:
        raise ccomp.BuildError(f"no component headers under {root}")
    return found


def _read_target(path: str) -> str:
    if not os.path.isfile(path):
        raise ccomp.BuildError("sdkconfig is missing (expected CONFIG_IDF_TARGET)")
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.split("#", 1)[0].strip()
            if line.startswith("CONFIG_IDF_TARGET="):
                return line.split("=", 1)[1].strip().strip('"')
    raise ccomp.BuildError("sdkconfig has no CONFIG_IDF_TARGET")


def _project_name(path: str) -> str:
    if not os.path.isfile(path):
        raise ccomp.BuildError("CMakeLists.txt is missing")
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    key = "project("
    at = text.find(key)
    if at < 0:
        raise ccomp.BuildError("CMakeLists.txt has no project()")
    rest = text[at + len(key) :]
    end = rest.find(")")
    if end < 0:
        raise ccomp.BuildError("project() is not closed")
    name = rest[:end].strip().split()[0]
    if not name:
        raise ccomp.BuildError("empty project name")
    return name


def _main_sources(project: str) -> list[str]:
    cmake = os.path.join(project, "main", "CMakeLists.txt")
    if not os.path.isfile(cmake):
        raise ccomp.BuildError("main/CMakeLists.txt is missing")
    with open(cmake, encoding="utf-8") as handle:
        text = handle.read()
    names = []
    i = 0
    while True:
        start = text.find('"', i)
        if start < 0:
            break
        end = text.find('"', start + 1)
        if end < 0:
            break
        quoted = text[start + 1 : end]
        i = end + 1
        if quoted.endswith(".c"):
            names.append(quoted)
    if not names:
        raise ccomp.BuildError("main/CMakeLists.txt lists no .c files")
    paths = []
    for name in names:
        path = name if os.path.isabs(name) else os.path.join(project, "main", name)
        if not os.path.isfile(path):
            raise ccomp.BuildError(f"missing source {name}")
        paths.append(path)
    return paths


def _fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
