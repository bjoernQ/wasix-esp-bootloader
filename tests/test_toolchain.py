"""Behavioral tests for the Xtensa subset compiler and ESP32 image packer."""

from __future__ import annotations

import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "web" / "public" / "toolchain" / "esp-idf" / "tools"
EXAMPLES = ROOT / "web" / "public" / "examples"
AS = ROOT / ".tools" / "xtensa-esp32-elf" / "bin" / "xtensa-esp32-elf-as.exe"
OBJDUMP = ROOT / ".tools" / "xtensa-esp32-elf" / "bin" / "xtensa-esp32-elf-objdump.exe"
sys.path.insert(0, str(TOOLS))

import ccomp  # noqa: E402
import idf  # noqa: E402
import xtensa  # noqa: E402


def test_encodings_match_constants() -> None:
    assert xtensa.enc_entry(1, 32) == 0x004136
    assert xtensa.enc_addi(2, 3, 40) == 0x28C322
    assert xtensa.enc_addi(2, 2, -2) == 0xFEC222
    assert xtensa.enc_movi(10, 2047) == 0xFFA7A2
    assert xtensa.enc_or(10, 2, 2) == 0x20A220
    assert xtensa.enc_callx8(8) == 0x0008E0
    assert xtensa.RETW_N == 0xF01D
    assert xtensa.NOP_N == 0xF03D
    assert xtensa.MEMW == 0x0020C0
    assert xtensa.enc_sub(2, 3, 4) == 0xC02340
    assert xtensa.enc_and(2, 3, 4) == 0x102340
    assert xtensa.enc_xor(2, 3, 4) == 0x302340
    assert xtensa.enc_neg(2, 3) == 0x602030
    assert xtensa.enc_ssl(3) == 0x401300
    assert xtensa.enc_sll(2, 4) == 0xA12400
    assert xtensa.enc_srl(2, 4) == 0x912040
    assert xtensa.enc_l32i(3, 1, 16) == 0x102132
    assert xtensa.enc_s32i(3, 1, 16) == 0x106132
    assert xtensa.enc_l8ui(4, 2, 0) == 0x000242
    assert xtensa.enc_addn(10, 11, 12) == 0xABCA
    assert xtensa.enc_l32r(8, 0x40080404, 0x40080400) == 0xFFFF81


def test_assembler_bytes() -> None:
    if not AS.is_file() or not OBJDUMP.is_file():
        return
    source = """
        .text
        .align 4
        .global _start
        _start:
            entry a1, 32
            addi a2, a3, 40
            addi a2, a2, -2
            movi a10, 2047
            or a10, a2, a3
            callx8 a8
            memw
            sub a2, a3, a4
            and a2, a3, a4
            xor a2, a3, a4
            neg a2, a3
            ssl a3
            sll a2, a4
            srl a2, a4
            l32i a3, a1, 64
            s32i a3, a1, 64
            l8ui a4, a2, 0
            add a10, a11, a12
            nop.n
            retw.n
    """
    expected = [
        xtensa.enc_entry(1, 32),
        xtensa.enc_addi(2, 3, 40),
        xtensa.enc_addi(2, 2, -2),
        xtensa.enc_movi(10, 2047),
        xtensa.enc_or(10, 2, 3),
        xtensa.enc_callx8(8),
        xtensa.MEMW,
        xtensa.enc_sub(2, 3, 4),
        xtensa.enc_and(2, 3, 4),
        xtensa.enc_xor(2, 3, 4),
        xtensa.enc_neg(2, 3),
        xtensa.enc_ssl(3),
        xtensa.enc_sll(2, 4),
        xtensa.enc_srl(2, 4),
        xtensa.enc_l32i(3, 1, 16),
        xtensa.enc_s32i(3, 1, 16),
        xtensa.enc_l8ui(4, 2, 0),
        xtensa.enc_addn(10, 11, 12),
        xtensa.NOP_N,
        xtensa.RETW_N,
    ]
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        asm = directory / "t.s"
        obj = directory / "t.o"
        asm.write_text(source, encoding="utf-8")
        subprocess.check_call([str(AS), str(asm), "-o", str(obj)], stdout=subprocess.DEVNULL)
        dump = subprocess.check_output([str(OBJDUMP), "-d", str(obj)], text=True)
    words = []
    for line in dump.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[0].endswith(":") and all(c in "0123456789abcdef" for c in parts[1]):
            words.append(int(parts[1], 16))
    assert words == expected, (words, expected)


def test_call_and_branch() -> None:
    program = xtensa.Program()
    program.func("add1")
    program.use_slots(1)
    program.addi(2, 2, 1)
    program.ret()
    program.func("go")
    program.use_slots(2)
    program.s32i(2, 1, 0)
    program.movi(10, 41)
    program.call("add1")
    program.s32i(10, 1, 1)
    program.l32i(2, 1, 0)
    program.l32i(3, 1, 1)
    program.ret()
    linked = program.link(entry_name="go")
    machine = xtensa.Machine(linked)
    machine.run(entry="go", a2=7)
    assert machine.halted == "return", _debug(machine)
    assert machine.regs[2] == 7
    assert machine.regs[3] == 42

    flag = xtensa.Program()
    flag.func("go")
    flag.use_slots(1)
    flag.movi(2, 0)
    flag.beqz(2, "yes")
    flag.movi(2, 1)
    flag.j("end")
    flag.label("yes")
    flag.movi(2, 42)
    flag.label("end")
    flag.ret()
    linked = flag.link(entry_name="go")
    machine = xtensa.Machine(linked)
    machine.run(entry="go")
    assert machine.halted == "return", _debug(machine)
    assert machine.regs[2] == 42


def test_l32r_constant() -> None:
    program = xtensa.Program()
    program.func("go")
    program.use_slots(1)
    program.l32r_imm(2, 0x12345678)
    program.ret()
    linked = program.link(entry_name="go")
    machine = xtensa.Machine(linked)
    machine.run(entry="go")
    assert machine.halted == "return", _debug(machine)
    assert machine.regs[2] == 0x12345678


def test_arithmetic_program() -> None:
    source = r"""
        int printf(const char *fmt, ...);
        void app_main(void) {
            int a = 1000;
            int b = 10;
            int n = -10;
            int d = 3;
            int e = -3;
            int t = 20;
            int u = 30;
            printf("%d\n", a / b);
            printf("%d\n", n / d);
            printf("%d\n", b / e);
            printf("%d\n", n / e);
            printf("%d\n", n % d);
            printf("%d\n", t * u);
        }
    """
    linked = ccomp.compile_units([("arith.c", source)], [])
    machine = xtensa.Machine(linked)
    machine.run()
    assert machine.halted == "restart", _debug(machine)
    assert machine.uart == b"100\r\n-3\r\n-3\r\n3\r\n-1\r\n600\r\n", machine.uart


def test_examples_boot_and_image() -> None:
    hello = idf.build(str(EXAMPLES / "hello_world"))
    assert hello["image"][0] == 0xE9
    machine = xtensa.Machine(hello["linked"])
    machine.run(max_steps=2_000_000)
    text = machine.uart.decode()
    assert machine.halted == "restart", (machine.halted, text[-200:], _debug(machine))
    assert "Hello world!\r\n" in text
    assert "Restarting in 10 seconds...\r\n" in text
    assert "Restarting in 0 seconds...\r\n" in text
    assert "Restarting now.\r\n" in text

    button = idf.build(str(EXAMPLES / "button"))
    assert button["image"][0] == 0xE9
    assert b"Press BOOT to toggle the LED" in button["image"]
    wifi = idf.build(str(EXAMPLES / "wifi_scan"))
    assert wifi["image"][0] == 0xE9
    assert b"Wi-Fi PHY is not in this image" in wifi["image"]
    machine = xtensa.Machine(wifi["linked"])
    machine.run()
    wifi_text = machine.uart.decode()
    assert "Wi-Fi PHY is not in this image" in wifi_text, wifi_text
    assert "scan status: -1" in wifi_text, wifi_text
    assert machine.halted == "restart"

    _load_with_esptool(hello["image"])


def _load_with_esptool(image: bytes) -> None:
    try:
        from esptool.bin_image import ESP32FirmwareImage
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "esptool==4.8.1"])
        import importlib

        importlib.invalidate_caches()
        from esptool.bin_image import ESP32FirmwareImage
    from io import BytesIO

    loaded = ESP32FirmwareImage(BytesIO(image))
    assert loaded.segments
    assert loaded.checksum == loaded.calculate_checksum()
    assert loaded.append_digest is False


def _debug(machine: xtensa.Machine) -> str:
    recent = " ".join(f"0x{pc:08x}" for pc in machine.trace)
    return f"halted={machine.halted} steps={machine.steps} uart={bytes(machine.uart)!r} trace={recent}"


if __name__ == "__main__":
    test_encodings_match_constants()
    print("encodings ok")
    test_assembler_bytes()
    print("assembler ok")
    test_call_and_branch()
    print("call ok")
    test_l32r_constant()
    print("l32r ok")
    test_arithmetic_program()
    print("arith ok")
    test_examples_boot_and_image()
    print("examples ok")
