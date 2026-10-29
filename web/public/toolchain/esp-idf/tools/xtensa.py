"""Xtensa LX6 assembler, ESP32 ROM image packer, runtime, and interpreter.

Instruction encodings follow the forms used by GNU `as` for xtensa-esp32-elf
(verified against Espressif's crosstool-NG 2021r2 binutils). The interpreter
implements the windowed call8 ABI those encodings use, so a program that
prints the right UART bytes here uses the same machine code a DevKitC runs.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

IRAM_BASE = 0x40080400
DRAM_BASE = 0x3FFF0000
STACK_TOP = 0x3FFFE000

UART_TX_ONE_CHAR = 0x40009200
ETS_DELAY_US = 0x40008534
SOFTWARE_RESET = 0x4000824C
GPIO_PAD_SELECT_GPIO = 0x40009FDC
GPIO_PAD_PULLUP = 0x4000A22C

GPIO_OUT_W1TS = 0x3FF44008
GPIO_OUT_W1TC = 0x3FF4400C
GPIO_ENABLE_W1TS = 0x3FF44024
GPIO_ENABLE_W1TC = 0x3FF44028
GPIO_IN_REG = 0x3FF4403C

RETW_N = 0xF01D
NOP_N = 0xF03D


class LinkError(Exception):
    pass


def enc_rrr(op0: int, op1: int, op2: int, r: int, s: int, t: int) -> int:
    return (
        ((op2 & 0xF) << 20)
        | ((op1 & 0xF) << 16)
        | ((r & 0xF) << 12)
        | ((s & 0xF) << 8)
        | ((t & 0xF) << 4)
        | (op0 & 0xF)
    )


def enc_rri8(op0: int, r: int, s: int, t: int, imm8: int) -> int:
    return (
        ((imm8 & 0xFF) << 16)
        | ((r & 0xF) << 12)
        | ((s & 0xF) << 8)
        | ((t & 0xF) << 4)
        | (op0 & 0xF)
    )


def enc_bri12(op0: int, s: int, m: int, n: int, imm12: int) -> int:
    return (
        ((imm12 & 0xFFF) << 12)
        | ((s & 0xF) << 8)
        | ((m & 0x3) << 6)
        | ((n & 0x3) << 4)
        | (op0 & 0xF)
    )


def enc_entry(reg: int, nbytes: int) -> int:
    if nbytes % 8 or not 0 <= nbytes < 8 * 4096:
        raise LinkError(f"entry frame {nbytes} is not a legal size")
    return enc_bri12(6, reg, 0, 3, nbytes // 8)


def enc_movi(reg: int, imm: int) -> int:
    if not -2048 <= imm <= 2047:
        raise LinkError(f"movi immediate {imm} out of range")
    return enc_rri8(2, 10, (imm >> 8) & 0xF, reg, imm & 0xFF)


def enc_addi(rd: int, rs: int, imm: int) -> int:
    if not -128 <= imm <= 127:
        raise LinkError(f"addi immediate {imm} out of range")
    return enc_rri8(2, 12, rs, rd, imm & 0xFF)


def enc_l32i(rd: int, base: int, word_off: int) -> int:
    if not 0 <= word_off <= 255:
        raise LinkError(f"l32i offset {word_off}")
    return enc_rri8(2, 2, base, rd, word_off)


def enc_s32i(rs: int, base: int, word_off: int) -> int:
    if not 0 <= word_off <= 255:
        raise LinkError(f"s32i offset {word_off}")
    return enc_rri8(2, 6, base, rs, word_off)


def enc_l8ui(rd: int, base: int, off: int) -> int:
    if not 0 <= off <= 255:
        raise LinkError(f"l8ui offset {off}")
    return enc_rri8(2, 0, base, rd, off)


def enc_or(rd: int, rs: int, rt: int) -> int:
    return enc_rrr(0, 0, 2, rd, rs, rt)


def enc_and(rd: int, rs: int, rt: int) -> int:
    return enc_rrr(0, 0, 1, rd, rs, rt)


def enc_xor(rd: int, rs: int, rt: int) -> int:
    return enc_rrr(0, 0, 3, rd, rs, rt)


def enc_sub(rd: int, rs: int, rt: int) -> int:
    return enc_rrr(0, 0, 12, rd, rs, rt)


def enc_neg(rd: int, rs: int) -> int:
    return enc_rrr(0, 0, 6, rd, 0, rs)


def enc_addn(rd: int, rs: int, rt: int) -> int:
    return ((rd & 0xF) << 12) | ((rs & 0xF) << 8) | ((rt & 0xF) << 4) | 10


def enc_ssl(reg: int) -> int:
    return enc_rrr(0, 0, 4, 1, reg, 0)


def enc_ssr(reg: int) -> int:
    return enc_rrr(0, 0, 4, 0, reg, 0)


def enc_sll(rd: int, rs: int) -> int:
    return enc_rrr(0, 1, 10, rd, rs, 0)


def enc_srl(rd: int, rs: int) -> int:
    return enc_rrr(0, 1, 9, rd, 0, rs)


def enc_callx8(reg: int) -> int:
    return ((reg & 0xF) << 8) | 0xE0


def enc_l32r(reg: int, pc: int, lit_addr: int) -> int:
    aligned = (pc + 3) & ~3
    imm16 = ((lit_addr - aligned) >> 2) & 0xFFFF
    return (imm16 << 8) | ((reg & 0xF) << 4) | 1


def enc_j(rel: int) -> int:
    if not -0x20000 <= rel < 0x20000:
        raise LinkError(f"jump offset {rel} out of range")
    return ((rel & 0x3FFFF) << 6) | 6


def enc_bcc(cond: int, ra: int, rb: int, rel: int) -> int:
    return enc_rri8(7, cond, ra, rb, rel & 0xFF)


def enc_bccz(cond: int, reg: int, rel: int) -> int:
    return enc_bri12(6, reg, cond, 1, rel & 0xFFF)


MEMW = 0x0020C0


def frame_size(nslots: int) -> int:
    need = max(0, nslots) * 4
    aligned = (need + 7) & ~7
    return max(32, aligned)


def align_padding(pc: int) -> bytes:
    rem = pc % 4
    nopn = struct.pack("<H", NOP_N)
    nopw = struct.pack("<I", enc_or(1, 1, 1))[:3]
    if rem == 0:
        return b""
    if rem == 1:
        return nopw
    if rem == 2:
        return nopn
    return nopn + nopw


def op_size(op: tuple) -> int:
    kind = op[0]
    if kind == "label":
        return 0
    if kind in ("add", "retw"):
        return 2
    if kind in ("beq", "bne", "blt", "bge", "beqz", "bnez", "bltz", "bgez", "call"):
        return 6
    return 3


@dataclass
class Func:
    name: str
    ops: list = field(default_factory=list)
    nslots: int = 0
    address: int = 0
    frame: int = 32


@dataclass
class LinkResult:
    image: bytes
    entry: int
    entry_name: str
    iram: bytes
    iram_base: int
    dram: bytes
    dram_base: int
    symbols: dict


class Program:
    def __init__(self) -> None:
        self.funcs: list[Func] = []
        self.cur: Func | None = None
        self.lits: list = []
        self.dram = bytearray()
        self._names: set[str] = set()

    def func(self, name: str) -> None:
        if name in self._names:
            raise LinkError(f"duplicate symbol {name}")
        self._names.add(name)
        self.cur = Func(name)
        self.funcs.append(self.cur)

    def use_slots(self, n: int) -> None:
        assert self.cur is not None
        self.cur.nslots = max(self.cur.nslots, n)

    def emit(self, op: tuple) -> None:
        assert self.cur is not None
        self.cur.ops.append(op)

    def label(self, name: str) -> None:
        self.emit(("label", f"{self.cur.name}.{name}"))

    def j(self, name: str) -> None:
        self.emit(("j", f"{self.cur.name}.{name}"))

    def _br(self, kind: str, name: str, *regs: int) -> None:
        self.emit((kind, *regs, f"{self.cur.name}.{name}"))

    def beq(self, ra: int, rb: int, name: str) -> None:
        self._br("beq", name, ra, rb)

    def bne(self, ra: int, rb: int, name: str) -> None:
        self._br("bne", name, ra, rb)

    def blt(self, ra: int, rb: int, name: str) -> None:
        self._br("blt", name, ra, rb)

    def bge(self, ra: int, rb: int, name: str) -> None:
        self._br("bge", name, ra, rb)

    def beqz(self, reg: int, name: str) -> None:
        self._br("beqz", name, reg)

    def bnez(self, reg: int, name: str) -> None:
        self._br("bnez", name, reg)

    def bltz(self, reg: int, name: str) -> None:
        self._br("bltz", name, reg)

    def bgez(self, reg: int, name: str) -> None:
        self._br("bgez", name, reg)

    def movi(self, rd: int, imm: int) -> None:
        if -2048 <= imm <= 2047:
            self.emit(("movi", rd, imm))
        else:
            self.l32r_imm(rd, imm & 0xFFFFFFFF)

    def move(self, rd: int, rs: int) -> None:
        self.emit(("or", rd, rs, rs))

    def l32r_imm(self, rd: int, value: int) -> None:
        self.emit(("l32r", rd, self._lit(value & 0xFFFFFFFF)))

    def load_string(self, rd: int, text: str) -> None:
        addr = DRAM_BASE + len(self.dram)
        raw = text.encode("utf-8") + b"\0"
        self.dram += raw
        while len(self.dram) % 4:
            self.dram.append(0)
        self.l32r_imm(rd, addr)

    def _lit(self, value) -> int:
        self.lits.append(value)
        return len(self.lits) - 1

    def l32i(self, rd: int, base: int, word_off: int) -> None:
        self.emit(("l32i", rd, base, word_off))

    def s32i(self, rs: int, base: int, word_off: int) -> None:
        self.emit(("s32i", rs, base, word_off))

    def l8ui(self, rd: int, base: int, off: int) -> None:
        self.emit(("l8ui", rd, base, off))

    def addi(self, rd: int, rs: int, imm: int) -> None:
        self.emit(("addi", rd, rs, imm))

    def add(self, rd: int, rs: int, rt: int) -> None:
        self.emit(("add", rd, rs, rt))

    def sub(self, rd: int, rs: int, rt: int) -> None:
        self.emit(("sub", rd, rs, rt))

    def neg(self, rd: int, rs: int) -> None:
        self.emit(("neg", rd, rs))

    def or_(self, rd: int, rs: int, rt: int) -> None:
        self.emit(("or", rd, rs, rt))

    def and_(self, rd: int, rs: int, rt: int) -> None:
        self.emit(("and", rd, rs, rt))

    def xor(self, rd: int, rs: int, rt: int) -> None:
        self.emit(("xor", rd, rs, rt))

    def ssl(self, reg: int) -> None:
        self.emit(("ssl", reg))

    def ssr(self, reg: int) -> None:
        self.emit(("ssr", reg))

    def sll(self, rd: int, rs: int) -> None:
        self.emit(("sll", rd, rs))

    def srl(self, rd: int, rs: int) -> None:
        self.emit(("srl", rd, rs))

    def memw(self) -> None:
        self.emit(("memw",))

    def call(self, name: str) -> None:
        self.emit(("call", self._lit(("sym", name))))

    def callx8(self, reg: int) -> None:
        self.emit(("callx8", reg))

    def ret(self) -> None:
        self.emit(("retw",))

    def link(self, entry_name: str = "call_start_cpu0") -> LinkResult:
        labels: dict[str, int] = {}
        pc = IRAM_BASE + len(self.lits) * 4
        placed: list[tuple] = []
        for fn in self.funcs:
            pad = align_padding(pc)
            if pad:
                placed.append(("pad", pc, pad))
                pc += len(pad)
            fn.address = pc
            fn.frame = frame_size(fn.nslots)
            placed.append(("entry", pc, fn))
            pc += 3
            for op in fn.ops:
                if op[0] == "label":
                    labels[op[1]] = pc
                    continue
                placed.append(("op", pc, op))
                pc += op_size(op)
        placed.append(("pad", pc, b"\x00" * 16))
        pc += 16

        by_name = {fn.name: fn for fn in self.funcs}
        values: list[int] = []
        for lit in self.lits:
            if isinstance(lit, tuple) and lit and lit[0] == "sym":
                target = by_name.get(lit[1])
                if target is None:
                    raise LinkError(f"undefined reference to {lit[1]}")
                values.append(target.address)
            else:
                values.append(int(lit) & 0xFFFFFFFF)
        pool = b"".join(struct.pack("<I", v) for v in values)
        code = bytearray()
        for kind, at, payload in placed:
            assert IRAM_BASE + len(pool) + len(code) == at, (kind, at, IRAM_BASE + len(pool) + len(code))
            if kind == "pad":
                code += payload
            elif kind == "entry":
                code += _b24(enc_entry(1, payload.frame))
            else:
                code += _encode_op(at, payload, labels)
        iram = pool + code
        dram = bytes(self.dram)
        symbols = {fn.name: fn.address for fn in self.funcs}
        if entry_name not in symbols:
            raise LinkError(f"missing entry {entry_name}")
        segments = []
        if dram:
            segments.append((DRAM_BASE, dram))
        segments.append((IRAM_BASE, iram))
        image = pack_image(symbols[entry_name], segments)
        return LinkResult(
            image=image,
            entry=symbols[entry_name],
            entry_name=entry_name,
            iram=iram,
            iram_base=IRAM_BASE,
            dram=dram,
            dram_base=DRAM_BASE,
            symbols=symbols,
        )


def _b24(word: int) -> bytes:
    return struct.pack("<I", word & 0xFFFFFF)[:3]


def _b16(word: int) -> bytes:
    return struct.pack("<H", word & 0xFFFF)


def _encode_op(pc: int, op: tuple, labels: dict[str, int]) -> bytes:
    kind = op[0]
    if kind == "movi":
        return _b24(enc_movi(op[1], op[2]))
    if kind == "l32r":
        lit_addr = IRAM_BASE + op[2] * 4
        return _b24(enc_l32r(op[1], pc, lit_addr))
    if kind == "or":
        return _b24(enc_or(op[1], op[2], op[3]))
    if kind == "and":
        return _b24(enc_and(op[1], op[2], op[3]))
    if kind == "xor":
        return _b24(enc_xor(op[1], op[2], op[3]))
    if kind == "sub":
        return _b24(enc_sub(op[1], op[2], op[3]))
    if kind == "neg":
        return _b24(enc_neg(op[1], op[2]))
    if kind == "add":
        return _b16(enc_addn(op[1], op[2], op[3]))
    if kind == "addi":
        return _b24(enc_addi(op[1], op[2], op[3]))
    if kind == "l32i":
        return _b24(enc_l32i(op[1], op[2], op[3]))
    if kind == "s32i":
        return _b24(enc_s32i(op[1], op[2], op[3]))
    if kind == "l8ui":
        return _b24(enc_l8ui(op[1], op[2], op[3]))
    if kind == "ssl":
        return _b24(enc_ssl(op[1]))
    if kind == "ssr":
        return _b24(enc_ssr(op[1]))
    if kind == "sll":
        return _b24(enc_sll(op[1], op[2]))
    if kind == "srl":
        return _b24(enc_srl(op[1], op[2]))
    if kind == "memw":
        return _b24(MEMW)
    if kind == "callx8":
        return _b24(enc_callx8(op[1]))
    if kind == "retw":
        return _b16(RETW_N)
    if kind == "call":
        lit = op[1]
        return _b24(enc_l32r(8, pc, IRAM_BASE + lit * 4)) + _b24(enc_callx8(8))
    if kind == "j":
        dest = labels[op[1]]
        return _b24(enc_j(dest - pc - 4))
    if kind in ("beq", "bne", "blt", "bge"):
        cond = {"beq": 1, "bne": 9, "blt": 2, "bge": 10}[kind]
        inv = cond ^ 8
        dest = labels[op[3]]
        skip = _b24(enc_bcc(inv, op[1], op[2], 2))
        jrel = dest - (pc + 3) - 4
        return skip + _b24(enc_j(jrel))
    if kind in ("beqz", "bnez", "bltz", "bgez"):
        # Invert the condition and skip over the jump.
        inv = {"beqz": 1, "bnez": 0, "bltz": 3, "bgez": 2}[kind]
        dest = labels[op[2]]
        skip = _b24(enc_bccz(inv, op[1], 2))
        jrel = dest - (pc + 3) - 4
        return skip + _b24(enc_j(jrel))
    raise LinkError(f"bad op {op}")


def pack_image(entry: int, segments: list[tuple[int, bytes]]) -> bytes:
    """ESP32 ROM boot image: 8-byte header, 16-byte extended header, segments, checksum."""
    ext = struct.pack(
        "<BBBBHBHHBBBBB",
        0xEE,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    )
    if len(ext) != 16:
        raise LinkError("extended header must be 16 bytes")
    out = bytearray()
    out += struct.pack("<BBBBI", 0xE9, len(segments), 2, 0x20, entry)
    out += ext
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
    if len(out) % 16 != 0:
        raise LinkError("image alignment")
    return bytes(out)


def _s32(value: int) -> int:
    value &= 0xFFFFFFFF
    if value & 0x80000000:
        return value - 0x100000000
    return value


class Machine:
    """Enough of an Xtensa to execute the code this assembler emits."""

    def __init__(self, linked: LinkResult) -> None:
        self.linked = linked
        self.mem: dict[int, bytearray] = {}
        self._write_bytes(linked.iram_base, linked.iram)
        self._write_bytes(linked.dram_base, linked.dram)
        self.regs = [0] * 16
        self.regs[1] = STACK_TOP
        self.pc = linked.entry
        self.uart = bytearray()
        self.frames: list[list[int]] = []
        self.halted: str | None = None
        self.steps = 0
        self.sar_left = 0
        self.sar_right = 0
        self.gpio_out = 0
        self.gpio_en = 0
        self.gpio_in = 1
        self.trace: list[int] = []

    def run(self, max_steps: int = 1_000_000, entry: str | None = None, a2: int = 0, a3: int = 0) -> Machine:
        if entry is not None:
            self.pc = self.linked.symbols[entry]
            self.regs = [0] * 16
            self.regs[1] = STACK_TOP
            self.regs[2] = a2 & 0xFFFFFFFF
            self.regs[3] = a3 & 0xFFFFFFFF
            self.frames = []
            self.halted = None
        while self.halted is None and self.steps < max_steps:
            self.trace.append(self.pc)
            if len(self.trace) > 24:
                self.trace.pop(0)
            self.step()
            self.steps += 1
        if self.halted is None:
            self.halted = "step limit"
        return self

    def step(self) -> None:
        pc = self.pc
        b0 = self._r8(pc)
        if (b0 & 0xF) >= 8:
            word = b0 | (self._r8(pc + 1) << 8)
            self._exec16(pc, word)
            return
        word = b0 | (self._r8(pc + 1) << 8) | (self._r8(pc + 2) << 16)
        if not self._exec24(pc, word):
            self.pc = (pc + 3) & 0xFFFFFFFF

    def _exec16(self, pc: int, word: int) -> None:
        op0 = word & 0xF
        r = (word >> 12) & 0xF
        s = (word >> 8) & 0xF
        t = (word >> 4) & 0xF
        if op0 == 10:
            self.regs[r] = (self.regs[s] + self.regs[t]) & 0xFFFFFFFF
            self.pc = (pc + 2) & 0xFFFFFFFF
            return
        if word == RETW_N:
            self._retw()
            return
        if word == NOP_N:
            self.pc = (pc + 2) & 0xFFFFFFFF
            return
        self.halted = f"unknown 16-bit op 0x{word:04x} at 0x{pc:08x}"

    def _exec24(self, pc: int, word: int) -> bool:
        op0 = word & 0xF
        if op0 == 1:
            reg = (word >> 4) & 0xF
            imm16 = (word >> 8) & 0xFFFF
            if imm16 & 0x8000:
                imm16 -= 0x10000
            addr = ((pc + 3) & ~3) + (imm16 << 2)
            self.regs[reg] = self._r32(addr)
            return False
        if op0 == 2:
            r = (word >> 12) & 0xF
            s = (word >> 8) & 0xF
            t = (word >> 4) & 0xF
            imm = (word >> 16) & 0xFF
            if r == 10:
                if imm & 0x80:
                    # 12-bit immediate: high nibble is in `s`.
                    pass
                value = imm | (s << 8)
                if value & 0x800:
                    value -= 0x1000
                self.regs[t] = value & 0xFFFFFFFF
            elif r == 12:
                if imm & 0x80:
                    imm -= 256
                self.regs[t] = (self.regs[s] + imm) & 0xFFFFFFFF
            elif r == 0:
                self.regs[t] = self._r8((self.regs[s] + imm) & 0xFFFFFFFF)
            elif r == 2:
                self.regs[t] = self._r32((self.regs[s] + imm * 4) & 0xFFFFFFFF)
            elif r == 6:
                self._w32((self.regs[s] + imm * 4) & 0xFFFFFFFF, self.regs[t])
            else:
                self.halted = f"unknown rri8 r={r} at 0x{pc:08x}"
                return True
            return False
        if op0 == 6:
            n = (word >> 4) & 3
            if n == 3:
                imm = (word >> 12) & 0xFFF
                self.regs[1] = (self.regs[1] - imm * 8) & 0xFFFFFFFF
                return False
            if n == 0:
                imm = (word >> 6) & 0x3FFFF
                if imm & 0x20000:
                    imm -= 0x40000
                self.pc = (pc + 4 + imm) & 0xFFFFFFFF
                return True
            if n == 1:
                cond = (word >> 6) & 3
                reg = (word >> 8) & 0xF
                rel = (word >> 12) & 0xFFF
                if rel & 0x800:
                    rel -= 0x1000
                taken = _ccz(cond, _s32(self.regs[reg]))
                self.pc = ((pc + 4 + rel) if taken else (pc + 3)) & 0xFFFFFFFF
                return True
        if op0 == 7:
            cond = (word >> 12) & 0xF
            a = (word >> 8) & 0xF
            b = (word >> 4) & 0xF
            rel = (word >> 16) & 0xFF
            if rel & 0x80:
                rel -= 256
            taken = _cc(cond, self.regs[a], self.regs[b])
            self.pc = ((pc + 4 + rel) if taken else (pc + 3)) & 0xFFFFFFFF
            return True
        if op0 == 0:
            if word == MEMW:
                return False
            if (word & 0xFF) == 0xE0 and ((word >> 16) & 0xFF) == 0:
                self._callx8(self.regs[(word >> 8) & 0xF])
                return True
            op2 = (word >> 20) & 0xF
            op1 = (word >> 16) & 0xF
            r = (word >> 12) & 0xF
            s = (word >> 8) & 0xF
            t = (word >> 4) & 0xF
            if op1 == 0 and op2 == 2:
                self.regs[r] = (self.regs[s] | self.regs[t]) & 0xFFFFFFFF
            elif op1 == 0 and op2 == 1:
                self.regs[r] = (self.regs[s] & self.regs[t]) & 0xFFFFFFFF
            elif op1 == 0 and op2 == 3:
                self.regs[r] = (self.regs[s] ^ self.regs[t]) & 0xFFFFFFFF
            elif op1 == 0 and op2 == 12:
                self.regs[r] = (self.regs[s] - self.regs[t]) & 0xFFFFFFFF
            elif op1 == 0 and op2 == 6:
                self.regs[r] = (-_s32(self.regs[t])) & 0xFFFFFFFF
            elif op1 == 0 and op2 == 4 and r == 1:
                self.sar_left = self.regs[s] & 31
            elif op1 == 0 and op2 == 4 and r == 0:
                self.sar_right = self.regs[s] & 31
            elif op1 == 1 and op2 == 10:
                self.regs[r] = (self.regs[s] << self.sar_left) & 0xFFFFFFFF
            elif op1 == 1 and op2 == 9:
                self.regs[r] = (self.regs[t] & 0xFFFFFFFF) >> self.sar_right
            else:
                self.halted = f"unknown rrr 0x{word:06x} at 0x{pc:08x}"
                return True
            return False
        self.halted = f"unknown op0={op0} word 0x{word:06x} at 0x{pc:08x}"
        return True

    def _callx8(self, target: int) -> None:
        target &= 0xFFFFFFFF
        if target == UART_TX_ONE_CHAR:
            self.uart.append(self.regs[10] & 0xFF)
            self.regs[10] = 0
            self.pc = (self.pc + 3) & 0xFFFFFFFF
            return
        if target == ETS_DELAY_US or target in (GPIO_PAD_SELECT_GPIO, GPIO_PAD_PULLUP):
            self.regs[10] = 0
            self.pc = (self.pc + 3) & 0xFFFFFFFF
            return
        if target == SOFTWARE_RESET:
            self.halted = "restart"
            return
        if len(self.frames) > 48:
            self.halted = "recursion"
            return
        saved = self.regs[:]
        new = [0] * 16
        new[0] = (self.pc + 3) & 0xFFFFFFFF
        new[1] = saved[1]
        for i in range(6):
            new[2 + i] = saved[10 + i]
        self.frames.append(saved)
        self.regs = new
        self.pc = target

    def _retw(self) -> None:
        if not self.frames:
            self.halted = "return"
            return
        value = self.regs[2] & 0xFFFFFFFF
        ret = self.regs[0]
        caller = self.frames.pop()
        caller[10] = value
        self.regs = caller
        self.pc = ret & 0xFFFFFFFF

    def _r8(self, addr: int) -> int:
        page = self.mem.get(addr & ~0xFFF)
        if page is None:
            return 0
        return page[addr & 0xFFF]

    def _r32(self, addr: int) -> int:
        if addr == GPIO_IN_REG:
            return self.gpio_in & 0xFFFFFFFF
        return (
            self._r8(addr)
            | (self._r8(addr + 1) << 8)
            | (self._r8(addr + 2) << 16)
            | (self._r8(addr + 3) << 24)
        )

    def _w32(self, addr: int, value: int) -> None:
        value &= 0xFFFFFFFF
        if addr == GPIO_OUT_W1TS:
            self.gpio_out = (self.gpio_out | value) & 0xFFFFFFFF
            return
        if addr == GPIO_OUT_W1TC:
            self.gpio_out = (self.gpio_out & ~value) & 0xFFFFFFFF
            return
        if addr == GPIO_ENABLE_W1TS:
            self.gpio_en = (self.gpio_en | value) & 0xFFFFFFFF
            return
        if addr == GPIO_ENABLE_W1TC:
            self.gpio_en = (self.gpio_en & ~value) & 0xFFFFFFFF
            return
        for i in range(4):
            self._w8(addr + i, (value >> (8 * i)) & 0xFF)

    def _w8(self, addr: int, value: int) -> None:
        base = addr & ~0xFFF
        page = self.mem.get(base)
        if page is None:
            page = bytearray(4096)
            self.mem[base] = page
        page[addr & 0xFFF] = value & 0xFF

    def _write_bytes(self, addr: int, data: bytes) -> None:
        for i, byte in enumerate(data):
            self._w8(addr + i, byte)


def _ccz(cond: int, value: int) -> bool:
    if cond == 0:
        return value == 0
    if cond == 1:
        return value != 0
    if cond == 2:
        return value < 0
    if cond == 3:
        return value >= 0
    return False


def _cc(cond: int, a: int, b: int) -> bool:
    sa, sb = _s32(a), _s32(b)
    if cond == 1:
        return a == b
    if cond == 9:
        return a != b
    if cond == 2:
        return sa < sb
    if cond == 10:
        return sa >= sb
    return False


def add_runtime(program: Program) -> None:
    _udiv(program)
    _mul(program)
    _div(program)
    _mod(program)
    _putchar(program)
    _print_i32(program)
    _print_hex(program)
    _print_str(program)
    _printf(program)
    _delay(program)
    _restart(program)
    _gpio(program)


def add_entry(program: Program) -> None:
    program.func("call_start_cpu0")
    program.use_slots(1)
    program.call("app_main")
    program.call("esp_restart")
    program.ret()


def _udiv(p: Program) -> None:
    p.func("__udivsi3")
    p.use_slots(5)
    p.s32i(2, 1, 0)
    p.s32i(3, 1, 1)
    p.movi(2, 0)
    p.s32i(2, 1, 2)
    p.s32i(2, 1, 3)
    p.l32i(2, 1, 1)
    p.beqz(2, "zero")
    p.movi(2, 31)
    p.s32i(2, 1, 4)
    p.label("loop")
    p.l32i(2, 1, 2)
    p.movi(3, 1)
    p.ssl(3)
    p.sll(2, 2)
    p.s32i(2, 1, 2)
    p.l32i(2, 1, 0)
    p.l32i(3, 1, 4)
    p.ssr(3)
    p.srl(2, 2)
    p.movi(3, 1)
    p.and_(2, 2, 3)
    p.l32i(3, 1, 2)
    p.or_(3, 3, 2)
    p.s32i(3, 1, 2)
    p.l32i(2, 1, 2)
    p.l32i(3, 1, 1)
    p.blt(2, 3, "nosub")
    p.sub(2, 2, 3)
    p.s32i(2, 1, 2)
    p.movi(2, 1)
    p.l32i(3, 1, 4)
    p.ssl(3)
    p.sll(2, 2)
    p.l32i(3, 1, 3)
    p.or_(2, 2, 3)
    p.s32i(2, 1, 3)
    p.label("nosub")
    p.l32i(2, 1, 4)
    p.addi(2, 2, -1)
    p.s32i(2, 1, 4)
    p.bgez(2, "loop")
    p.l32i(2, 1, 3)
    p.ret()
    p.label("zero")
    p.movi(2, 0)
    p.ret()


def _mul(p: Program) -> None:
    p.func("__mulsi3")
    p.use_slots(4)
    p.s32i(2, 1, 0)
    p.s32i(3, 1, 1)
    p.movi(2, 0)
    p.s32i(2, 1, 2)
    p.s32i(2, 1, 3)
    p.label("loop")
    p.l32i(2, 1, 3)
    p.movi(3, 32)
    p.bge(2, 3, "done")
    p.l32i(2, 1, 1)
    p.movi(3, 1)
    p.and_(2, 2, 3)
    p.beqz(2, "noadd")
    p.l32i(2, 1, 2)
    p.l32i(3, 1, 0)
    p.add(2, 2, 3)
    p.s32i(2, 1, 2)
    p.label("noadd")
    p.l32i(2, 1, 0)
    p.movi(3, 1)
    p.ssl(3)
    p.sll(2, 2)
    p.s32i(2, 1, 0)
    p.l32i(2, 1, 1)
    p.movi(3, 1)
    p.ssr(3)
    p.srl(2, 2)
    p.s32i(2, 1, 1)
    p.l32i(2, 1, 3)
    p.addi(2, 2, 1)
    p.s32i(2, 1, 3)
    p.j("loop")
    p.label("done")
    p.l32i(2, 1, 2)
    p.ret()


def _div(p: Program) -> None:
    p.func("__divsi3")
    p.use_slots(4)
    p.s32i(2, 1, 0)
    p.s32i(3, 1, 1)
    p.movi(2, 0)
    p.s32i(2, 1, 2)
    p.l32i(2, 1, 0)
    p.bgez(2, "n_ok")
    p.neg(2, 2)
    p.s32i(2, 1, 0)
    p.movi(2, 1)
    p.s32i(2, 1, 2)
    p.label("n_ok")
    p.l32i(2, 1, 1)
    p.bgez(2, "d_ok")
    p.neg(2, 2)
    p.s32i(2, 1, 1)
    p.l32i(3, 1, 2)
    p.movi(4, 1)
    p.xor(3, 3, 4)
    p.s32i(3, 1, 2)
    p.label("d_ok")
    p.l32i(10, 1, 0)
    p.l32i(11, 1, 1)
    p.call("__udivsi3")
    p.move(2, 10)
    p.l32i(3, 1, 2)
    p.beqz(3, "nosign")
    p.neg(2, 2)
    p.label("nosign")
    p.ret()


def _mod(p: Program) -> None:
    """C99 remainder: n - trunc_div(n, d) * d. Sign follows the dividend."""
    p.func("__modsi3")
    p.use_slots(3)
    p.s32i(2, 1, 0)
    p.s32i(3, 1, 1)
    p.move(10, 2)
    p.move(11, 3)
    p.call("__divsi3")
    p.s32i(10, 1, 2)
    p.l32i(10, 1, 2)
    p.l32i(11, 1, 1)
    p.call("__mulsi3")
    p.l32i(2, 1, 0)
    p.move(3, 10)
    p.sub(2, 2, 3)
    p.ret()


def _putchar(p: Program) -> None:
    p.func("putchar")
    p.use_slots(1)
    p.s32i(2, 1, 0)
    p.movi(3, 10)
    p.bne(2, 3, "raw")
    p.movi(10, 13)
    p.l32r_imm(8, UART_TX_ONE_CHAR)
    p.callx8(8)
    p.label("raw")
    p.l32i(2, 1, 0)
    p.move(10, 2)
    p.l32r_imm(8, UART_TX_ONE_CHAR)
    p.callx8(8)
    p.movi(2, 0)
    p.ret()


def _print_i32(p: Program) -> None:
    p.func("print_i32")
    p.use_slots(16)
    p.s32i(2, 1, 0)
    p.movi(3, 0)
    p.bge(2, 3, "nonneg")
    p.movi(10, ord("-"))
    p.call("putchar")
    p.l32i(2, 1, 0)
    p.neg(2, 2)
    p.s32i(2, 1, 0)
    p.label("nonneg")
    p.l32i(2, 1, 0)
    p.movi(3, 0)
    p.bne(2, 3, "nz")
    p.movi(10, ord("0"))
    p.call("putchar")
    p.ret()
    p.label("nz")
    p.movi(2, 0)
    p.s32i(2, 1, 13)  # count
    p.label("split")
    p.l32i(2, 1, 13)
    p.movi(3, 11)
    p.bge(2, 3, "bad")
    p.l32i(10, 1, 0)
    p.movi(11, 10)
    p.call("__modsi3")
    p.move(4, 10)  # digit
    p.l32i(2, 1, 13)
    p.movi(3, 2)
    p.ssl(3)
    p.sll(2, 2)  # count * 4
    p.addi(3, 1, 4)  # &digits[0] == slot 1
    p.add(3, 3, 2)
    p.s32i(4, 3, 0)
    p.l32i(10, 1, 0)
    p.movi(11, 10)
    p.call("__divsi3")
    p.s32i(10, 1, 0)  # n = n / 10  (return is in a10)
    p.l32i(2, 1, 13)
    p.addi(2, 2, 1)
    p.s32i(2, 1, 13)
    p.l32i(3, 1, 0)
    p.bnez(3, "split")
    p.label("emit")
    p.l32i(2, 1, 13)
    p.beqz(2, "done")
    p.addi(2, 2, -1)
    p.s32i(2, 1, 13)
    p.movi(3, 2)
    p.ssl(3)
    p.sll(2, 2)
    p.addi(3, 1, 4)
    p.add(3, 3, 2)
    p.l32i(2, 3, 0)
    p.addi(2, 2, ord("0"))
    p.move(10, 2)
    p.call("putchar")
    p.j("emit")
    p.label("bad")
    p.label("done")
    p.movi(2, 0)
    p.ret()


def _print_hex(p: Program) -> None:
    p.func("print_hex")
    p.use_slots(2)
    p.s32i(2, 1, 0)
    p.movi(2, 28)
    p.s32i(2, 1, 1)
    p.label("loop")
    p.l32i(2, 1, 0)
    p.l32i(3, 1, 1)
    p.ssr(3)
    p.srl(2, 2)
    p.movi(3, 15)
    p.and_(2, 2, 3)
    p.movi(3, 10)
    p.blt(2, 3, "digit")
    p.addi(2, 2, ord("a") - 10)
    p.j("out")
    p.label("digit")
    p.addi(2, 2, ord("0"))
    p.label("out")
    p.move(10, 2)
    p.call("putchar")
    p.l32i(2, 1, 1)
    p.addi(2, 2, -4)
    p.s32i(2, 1, 1)
    p.bgez(2, "loop")
    p.movi(2, 0)
    p.ret()


def _print_str(p: Program) -> None:
    p.func("print_str")
    p.use_slots(1)
    p.s32i(2, 1, 0)
    p.label("loop")
    p.l32i(2, 1, 0)
    p.l8ui(3, 2, 0)
    p.beqz(3, "done")
    p.addi(2, 2, 1)
    p.s32i(2, 1, 0)
    p.move(10, 3)
    p.call("putchar")
    p.j("loop")
    p.label("done")
    p.movi(2, 0)
    p.ret()


def _load_arg(p: Program, suffix: str) -> None:
    p.l32i(4, 1, 5)
    p.movi(5, 0)
    p.beq(4, 5, f"n0_{suffix}")
    p.movi(5, 1)
    p.beq(4, 5, f"n1_{suffix}")
    p.movi(5, 2)
    p.beq(4, 5, f"n2_{suffix}")
    p.l32i(2, 1, 4)
    p.j(f"nd_{suffix}")
    p.label(f"n0_{suffix}")
    p.l32i(2, 1, 1)
    p.j(f"nd_{suffix}")
    p.label(f"n1_{suffix}")
    p.l32i(2, 1, 2)
    p.j(f"nd_{suffix}")
    p.label(f"n2_{suffix}")
    p.l32i(2, 1, 3)
    p.label(f"nd_{suffix}")
    p.l32i(4, 1, 5)
    p.addi(4, 4, 1)
    p.s32i(4, 1, 5)


def _printf(p: Program) -> None:
    p.func("printf")
    p.use_slots(8)
    p.s32i(2, 1, 0)
    p.s32i(3, 1, 1)
    p.s32i(4, 1, 2)
    p.s32i(5, 1, 3)
    p.s32i(6, 1, 4)
    p.movi(2, 0)
    p.s32i(2, 1, 5)
    p.label("loop")
    p.l32i(2, 1, 0)
    p.l8ui(3, 2, 0)
    p.beqz(3, "done")
    p.addi(2, 2, 1)
    p.s32i(2, 1, 0)
    p.movi(4, 37)
    p.beq(3, 4, "spec")
    p.move(10, 3)
    p.call("putchar")
    p.j("loop")
    p.label("spec")
    p.l32i(2, 1, 0)
    p.l8ui(3, 2, 0)
    p.beqz(3, "done")
    p.addi(2, 2, 1)
    p.s32i(2, 1, 0)
    p.movi(4, 37)
    p.beq(3, 4, "pct")
    p.movi(4, ord("d"))
    p.beq(3, 4, "dec")
    p.movi(4, ord("s"))
    p.beq(3, 4, "str")
    p.movi(4, ord("x"))
    p.beq(3, 4, "hex")
    p.movi(4, ord("c"))
    p.beq(3, 4, "chr")
    p.move(10, 3)
    p.call("putchar")
    p.j("loop")
    p.label("pct")
    p.movi(10, 37)
    p.call("putchar")
    p.j("loop")
    p.label("dec")
    _load_arg(p, "d")
    p.move(10, 2)
    p.call("print_i32")
    p.j("loop")
    p.label("str")
    _load_arg(p, "s")
    p.move(10, 2)
    p.call("print_str")
    p.j("loop")
    p.label("hex")
    _load_arg(p, "x")
    p.move(10, 2)
    p.call("print_hex")
    p.j("loop")
    p.label("chr")
    _load_arg(p, "c")
    p.move(10, 2)
    p.call("putchar")
    p.j("loop")
    p.label("done")
    p.movi(2, 0)
    p.ret()


def _delay(p: Program) -> None:
    p.func("vTaskDelay")
    p.use_slots(1)
    p.s32i(2, 1, 0)
    p.move(10, 2)
    p.l32r_imm(11, 10000)
    p.call("__mulsi3")
    p.l32r_imm(8, ETS_DELAY_US)
    p.callx8(8)
    p.movi(2, 0)
    p.ret()


def _restart(p: Program) -> None:
    p.func("esp_restart")
    p.l32r_imm(8, SOFTWARE_RESET)
    p.callx8(8)
    p.ret()


def _gpio(p: Program) -> None:
    p.func("gpio_set_direction")
    p.use_slots(3)
    p.s32i(2, 1, 0)
    p.s32i(3, 1, 1)
    p.move(10, 2)
    p.l32r_imm(8, GPIO_PAD_SELECT_GPIO)
    p.callx8(8)
    p.movi(2, 1)
    p.l32i(3, 1, 0)
    p.ssl(3)
    p.sll(2, 2)
    p.s32i(2, 1, 2)
    p.l32i(2, 1, 1)
    p.movi(3, 2)
    p.beq(2, 3, "out")
    p.l32r_imm(4, GPIO_ENABLE_W1TC)
    p.memw()
    p.l32i(2, 1, 2)
    p.s32i(2, 4, 0)
    p.memw()
    p.l32i(10, 1, 0)
    p.l32r_imm(8, GPIO_PAD_PULLUP)
    p.callx8(8)
    p.movi(2, 0)
    p.ret()
    p.label("out")
    p.l32r_imm(4, GPIO_ENABLE_W1TS)
    p.memw()
    p.l32i(2, 1, 2)
    p.s32i(2, 4, 0)
    p.memw()
    p.movi(2, 0)
    p.ret()

    p.func("gpio_set_level")
    p.use_slots(3)
    p.s32i(2, 1, 0)
    p.s32i(3, 1, 1)
    p.movi(2, 1)
    p.l32i(3, 1, 0)
    p.ssl(3)
    p.sll(2, 2)
    p.s32i(2, 1, 2)
    p.l32i(2, 1, 1)
    p.beqz(2, "low")
    p.l32r_imm(4, GPIO_OUT_W1TS)
    p.j("store")
    p.label("low")
    p.l32r_imm(4, GPIO_OUT_W1TC)
    p.label("store")
    p.memw()
    p.l32i(2, 1, 2)
    p.s32i(2, 4, 0)
    p.memw()
    p.movi(2, 0)
    p.ret()

    p.func("gpio_get_level")
    p.use_slots(1)
    p.s32i(2, 1, 0)
    p.l32r_imm(4, GPIO_IN_REG)
    p.memw()
    p.l32i(2, 4, 0)
    p.l32i(3, 1, 0)
    p.ssr(3)
    p.srl(2, 2)
    p.movi(3, 1)
    p.and_(2, 2, 3)
    p.ret()
