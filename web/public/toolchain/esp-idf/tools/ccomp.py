"""C subset compiler for the ESP32 runtime in xtensa.py.

Enough of C to compile the Hello World, Button, and Wi-Fi Scan examples:
preprocessor, functions, locals, control flow, integer arithmetic, calls, and
strings. Structs, floating point, and pointers-as-memory are out of scope;
pointers are integers, which is all printf and fflush need.
"""

from __future__ import annotations

import os

import xtensa

OPS = [
    "...",
    "<<=",
    ">>=",
    "&&",
    "||",
    "==",
    "!=",
    "<=",
    ">=",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "<<",
    ">>",
    "->",
    "#",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    ";",
    ",",
    "=",
    "<",
    ">",
    "!",
    "~",
    "+",
    "-",
    "*",
    "/",
    "%",
    "&",
    "|",
    "^",
    "?",
    ":",
    ".",
]


class BuildError(Exception):
    pass


class Token:
    def __init__(self, kind: str, value, file: str, line: int) -> None:
        self.kind = kind
        self.value = value
        self.file = file
        self.line = line

    def __repr__(self) -> str:
        return f"{self.kind}:{self.value}@{self.line}"


def _err(token: Token, message: str) -> None:
    raise BuildError(f"{token.file}:{token.line}: {message}")


class Scanner:
    def __init__(self, path: str, text: str) -> None:
        self.path = path
        self.text = text
        self.n = len(text)
        self.i = 0
        self.line = 1

    def scan(self) -> list[Token]:
        out: list[Token] = []
        while True:
            self._space_and_comments()
            if self.i >= self.n:
                out.append(Token("eof", "", self.path, self.line))
                return out
            tok = self._one()
            if tok is not None:
                out.append(tok)

    def _space_and_comments(self) -> None:
        while self.i < self.n:
            ch = self.text[self.i]
            if ch in " \t\r\v\f":
                self.i += 1
            elif ch == "\n":
                self.i += 1
                self.line += 1
            elif ch == "/" and self._peek(1) == "/":
                self.i += 2
                while self.i < self.n and self.text[self.i] != "\n":
                    self.i += 1
            elif ch == "/" and self._peek(1) == "*":
                self.i += 2
                while self.i < self.n and not (self.text[self.i] == "*" and self._peek(1) == "/"):
                    if self.text[self.i] == "\n":
                        self.line += 1
                    self.i += 1
                if self.i >= self.n:
                    raise BuildError(f"{self.path}:{self.line}: unterminated comment")
                self.i += 2
            else:
                return

    def _peek(self, offset: int) -> str:
        j = self.i + offset
        return self.text[j] if j < self.n else ""

    def _one(self) -> Token | None:
        start = self.i
        line = self.line
        ch = self.text[self.i]
        if ch == "#" and self._at_line_start():
            return self._directive(line)
        if ch == '"':
            return self._string(line)
        if ch == "'":
            return self._char(line)
        if ch.isdigit() or (ch == "." and self._peek(1).isdigit()):
            return self._number(line)
        if ch.isalpha() or ch == "_":
            self.i += 1
            while self.i < self.n and (self.text[self.i].isalnum() or self.text[self.i] == "_"):
                self.i += 1
            return Token("id", self.text[start : self.i], self.path, line)
        for op in OPS:
            if self.text.startswith(op, self.i):
                self.i += len(op)
                return Token("op", op, self.path, line)
        raise BuildError(f"{self.path}:{line}: unexpected {ch!r}")

    def _at_line_start(self) -> bool:
        j = self.i - 1
        while j >= 0 and self.text[j] in " \t":
            j -= 1
        return j < 0 or self.text[j] == "\n"

    def _directive(self, line: int) -> Token:
        self.i += 1
        while self.i < self.n and self.text[self.i] in " \t":
            self.i += 1
        start = self.i
        while self.i < self.n and (self.text[self.i].isalnum() or self.text[self.i] == "_"):
            self.i += 1
        name = self.text[start : self.i]
        body = ""
        if name != "else" and name != "endif":
            while self.i < self.n and self.text[self.i] in " \t":
                self.i += 1
            start = self.i
            while self.i < self.n and self.text[self.i] != "\n":
                if self.text[self.i] == "\\" and self._peek(1) == "\n":
                    self.i += 2
                    self.line += 1
                    continue
                if self.text[self.i] == "/" and self._peek(1) == "/":
                    break
                self.i += 1
            body = self.text[start : self.i].strip()
        return Token("dir", (name, body), self.path, line)

    def _string(self, line: int) -> Token:
        self.i += 1
        chars: list[str] = []
        while self.i < self.n and self.text[self.i] != '"':
            chars.append(self._escape(line))
        if self.i >= self.n:
            raise BuildError(f"{self.path}:{line}: unterminated string")
        self.i += 1
        return Token("str", "".join(chars), self.path, line)

    def _char(self, line: int) -> Token:
        self.i += 1
        if self.i >= self.n:
            raise BuildError(f"{self.path}:{line}: unterminated character")
        value = self._escape(line)
        if self.i >= self.n or self.text[self.i] != "'":
            raise BuildError(f"{self.path}:{line}: unterminated character")
        self.i += 1
        if len(value) != 1:
            raise BuildError(f"{self.path}:{line}: character constant is not one byte")
        return Token("num", ord(value), self.path, line)

    def _escape(self, line: int) -> str:
        ch = self.text[self.i]
        self.i += 1
        if ch != "\\":
            if ch == "\n":
                self.line += 1
            return ch
        if self.i >= self.n:
            raise BuildError(f"{self.path}:{line}: bad escape")
        esc = self.text[self.i]
        self.i += 1
        table = {"n": "\n", "r": "\r", "t": "\t", "0": "\0", "\\": "\\", "'": "'", '"': '"'}
        if esc in table:
            return table[esc]
        if esc == "x":
            hexdigits = ""
            while self.i < self.n and self.text[self.i] in "0123456789abcdefABCDEF" and len(hexdigits) < 2:
                hexdigits += self.text[self.i]
                self.i += 1
            if not hexdigits:
                raise BuildError(f"{self.path}:{line}: bad hex escape")
            return chr(int(hexdigits, 16))
        raise BuildError(f"{self.path}:{line}: unknown escape \\{esc}")

    def _number(self, line: int) -> Token:
        start = self.i
        if self.text[self.i] == "0" and self._peek(1) in "xX":
            self.i += 2
            while self.i < self.n and self.text[self.i] in "0123456789abcdefABCDEF":
                self.i += 1
            return Token("num", int(self.text[start : self.i], 16), self.path, line)
        while self.i < self.n and self.text[self.i].isdigit():
            self.i += 1
        return Token("num", int(self.text[start : self.i], 10), self.path, line)


def preprocess(path: str, text: str, include_dirs: list[str], seen: set[str] | None = None) -> list[Token]:
    if seen is None:
        seen = set()
    tokens = Scanner(path, text).scan()
    return _expand(path, tokens, include_dirs, seen, {})


def _expand(path: str, tokens: list[Token], include_dirs: list[str], seen: set[str], macros: dict) -> list[Token]:
    out: list[Token] = []
    skip = [False]
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if tok.kind == "dir":
            name, body = tok.value
            if name == "if" or name == "ifdef" or name == "ifndef":
                active = not any(skip)
                if name == "ifdef":
                    cond = body in macros
                elif name == "ifndef":
                    cond = body not in macros
                else:
                    cond = _if_const(body, macros)
                skip.append(not (active and cond))
            elif name == "else":
                if len(skip) == 1:
                    _err(tok, "#else without #if")
                parent = any(skip[:-1])
                skip[-1] = parent or (not skip[-1])
            elif name == "endif":
                if len(skip) == 1:
                    _err(tok, "#endif without #if")
                skip.pop()
            elif name == "elif":
                _err(tok, "#elif is not supported")
            elif any(skip):
                continue
            elif name == "define":
                parts = body.split(None, 1)
                if not parts:
                    _err(tok, "empty #define")
                if "(" in parts[0]:
                    _err(tok, "function-like macros are not supported")
                macros[parts[0]] = parts[1] if len(parts) > 1 else ""
            elif name == "include":
                inc = _include_path(tok, body)
                target = _resolve(path, inc, include_dirs, body.startswith("<"))
                real = os.path.realpath(target)
                if real in seen:
                    continue
                seen.add(real)
                with open(target, encoding="utf-8") as handle:
                    nested = Scanner(target, handle.read()).scan()
                out.extend(_expand(target, nested, include_dirs, seen, macros))
            elif name in ("pragma", "undef", "error", "warning", "line"):
                if name == "error":
                    _err(tok, body or "#error")
            else:
                _err(tok, f"unknown directive #{name}")
            continue
        if any(skip) or tok.kind == "eof":
            continue
        if tok.kind == "id" and tok.value in macros:
            repl = macros[tok.value]
            if repl == "":
                continue
            expanded = Scanner(tok.file, repl).scan()
            out.extend(t for t in expanded if t.kind != "eof")
            continue
        out.append(tok)
    return out


def _if_const(body: str, macros: dict) -> bool:
    text = body
    for name, value in macros.items():
        text = text.replace(name, value if value else "0")
    text = text.replace("defined", "")
    try:
        return bool(int(text.strip(), 0))
    except ValueError as exc:
        raise BuildError(f"cannot evaluate #{body}") from exc


def _include_path(tok: Token, body: str) -> str:
    body = body.strip()
    if len(body) >= 2 and ((body[0] == '"' and body[-1] == '"') or (body[0] == "<" and body[-1] == ">")):
        return body[1:-1]
    _err(tok, f"bad include {body}")
    return ""


def _resolve(current: str, name: str, include_dirs: list[str], angled: bool) -> str:
    candidates = []
    if not angled:
        candidates.append(os.path.join(os.path.dirname(current), name))
    candidates.extend(os.path.join(directory, name) for directory in include_dirs)
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise BuildError(f"cannot find {name} included from {current}")


class Func:
    def __init__(self, name: str, params: list[str], body, variadic: bool, tok: Token) -> None:
        self.name = name
        self.params = params
        self.body = body
        self.variadic = variadic
        self.tok = tok


class Parser:
    def __init__(self, tokens: list[Token], origin: str) -> None:
        self.toks = tokens + [Token("eof", "", origin, 1)]
        self.i = 0

    def cur(self) -> Token:
        return self.toks[self.i]

    def advance(self) -> Token:
        tok = self.cur()
        if tok.kind != "eof":
            self.i += 1
        return tok

    def check_op(self, value: str) -> bool:
        tok = self.cur()
        return tok.kind == "op" and tok.value == value

    def check_id(self, value: str | None = None) -> bool:
        tok = self.cur()
        return tok.kind == "id" and (value is None or tok.value == value)

    def match_op(self, value: str) -> bool:
        if self.check_op(value):
            self.advance()
            return True
        return False

    def expect_op(self, value: str) -> None:
        if not self.match_op(value):
            _err(self.cur(), f"expected {value}")

    def expect_id(self) -> str:
        tok = self.cur()
        if tok.kind != "id":
            _err(tok, "expected a name")
        self.advance()
        return tok.value

    def is_type(self) -> bool:
        tok = self.cur()
        return tok.kind == "id" and tok.value in ("void", "int", "char", "const")

    def parse_globals(self, funcs: dict[str, Func]) -> None:
        while self.cur().kind != "eof":
            func = self.parse_function()
            existing = funcs.get(func.name)
            if existing is None:
                funcs[func.name] = func
                continue
            if func.body is None:
                continue
            if existing.body is not None:
                _err(func.tok, f"duplicate definition of {func.name}")
            funcs[func.name] = func

    def parse_function(self) -> Func:
        tok = self.cur()
        self.parse_type()
        name = self.expect_id()
        self.expect_op("(")
        params, variadic = self.parse_params()
        if self.match_op(";"):
            return Func(name, params, None, variadic, tok)
        if variadic:
            _err(tok, "variadic definitions are not supported")
        self.expect_op("{")
        body = self.parse_block()
        return Func(name, params, body, False, tok)

    def parse_params(self) -> tuple[list[str], bool]:
        if self.match_op(")"):
            return [], False
        if self.check_id("void") and self.toks[self.i + 1].kind == "op" and self.toks[self.i + 1].value == ")":
            self.advance()
            self.expect_op(")")
            return [], False
        params: list[str] = []
        variadic = False
        while True:
            if self.match_op("..."):
                variadic = True
                break
            self.parse_type()
            if self.cur().kind == "id":
                params.append(self.advance().value)
            else:
                params.append(f"__p{len(params)}")
            if self.match_op(")"):
                return params, variadic
            self.expect_op(",")
        self.expect_op(")")
        return params, variadic

    def parse_type(self) -> None:
        saw = False
        if self.check_id("const"):
            self.advance()
            saw = True
        if self.cur().kind == "id" and self.cur().value in ("void", "int", "char"):
            self.advance()
            saw = True
        if not saw:
            _err(self.cur(), "expected a type")
        while self.match_op("*"):
            pass

    def parse_block(self) -> list:
        stmts = []
        while not self.check_op("}") and self.cur().kind != "eof":
            stmts.append(self.parse_statement())
        self.expect_op("}")
        return stmts

    def parse_statement(self):
        if self.match_op(";"):
            return ("empty",)
        if self.match_op("{"):
            return ("block", self.parse_block())
        if self.check_id("if"):
            self.advance()
            self.expect_op("(")
            cond = self.parse_expr()
            self.expect_op(")")
            then = self.parse_statement()
            els = None
            if self.check_id("else"):
                self.advance()
                els = self.parse_statement()
            return ("if", cond, then, els)
        if self.check_id("while"):
            self.advance()
            self.expect_op("(")
            cond = self.parse_expr()
            self.expect_op(")")
            return ("while", cond, self.parse_statement())
        if self.check_id("for"):
            return self.parse_for()
        if self.check_id("return"):
            self.advance()
            expr = None if self.check_op(";") else self.parse_expr()
            self.expect_op(";")
            return ("return", expr)
        if self.is_type():
            return self.parse_decl()
        expr = self.parse_expr()
        self.expect_op(";")
        return ("expr", expr)

    def parse_for(self):
        self.advance()
        self.expect_op("(")
        if self.check_op(";"):
            init = None
            self.advance()
        elif self.is_type():
            init = self.parse_decl()
        else:
            init = ("expr", self.parse_expr())
            self.expect_op(";")
        cond = None if self.check_op(";") else self.parse_expr()
        self.expect_op(";")
        step = None if self.check_op(")") else self.parse_expr()
        self.expect_op(")")
        return ("for", init, cond, step, self.parse_statement())

    def parse_decl(self):
        self.parse_type()
        name = self.expect_id()
        init = self.parse_expr() if self.match_op("=") else None
        self.expect_op(";")
        return ("decl", name, init)

    def parse_expr(self):
        return self.parse_assign()

    def parse_assign(self):
        left = self.parse_or()
        tok = self.cur()
        if tok.kind == "op" and tok.value in ("=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="):
            self.advance()
            right = self.parse_assign()
            if left[0] != "var":
                _err(tok, "assignment target must be a variable")
            if tok.value != "=":
                right = ("bin", tok.value[0], left, right)
            return ("assign", left[1], right)
        return left

    def parse_or(self):
        left = self.parse_and()
        while self.match_op("||"):
            left = ("bin", "||", left, self.parse_and())
        return left

    def parse_and(self):
        left = self.parse_bor()
        while self.match_op("&&"):
            left = ("bin", "&&", left, self.parse_bor())
        return left

    def parse_bor(self):
        left = self.parse_bxor()
        while self.match_op("|"):
            left = ("bin", "|", left, self.parse_bxor())
        return left

    def parse_bxor(self):
        left = self.parse_band()
        while self.match_op("^"):
            left = ("bin", "^", left, self.parse_band())
        return left

    def parse_band(self):
        left = self.parse_eq()
        while self.match_op("&"):
            left = ("bin", "&", left, self.parse_eq())
        return left

    def parse_eq(self):
        left = self.parse_rel()
        while self.cur().kind == "op" and self.cur().value in ("==", "!="):
            op = self.advance().value
            left = ("bin", op, left, self.parse_rel())
        return left

    def parse_rel(self):
        left = self.parse_shift()
        while self.cur().kind == "op" and self.cur().value in ("<", ">", "<=", ">="):
            op = self.advance().value
            left = ("bin", op, left, self.parse_shift())
        return left

    def parse_shift(self):
        left = self.parse_add()
        while self.cur().kind == "op" and self.cur().value in ("<<", ">>"):
            op = self.advance().value
            left = ("bin", op, left, self.parse_add())
        return left

    def parse_add(self):
        left = self.parse_mul()
        while self.cur().kind == "op" and self.cur().value in ("+", "-"):
            op = self.advance().value
            left = ("bin", op, left, self.parse_mul())
        return left

    def parse_mul(self):
        left = self.parse_unary()
        while self.cur().kind == "op" and self.cur().value in ("*", "/", "%"):
            op = self.advance().value
            left = ("bin", op, left, self.parse_unary())
        return left

    def parse_unary(self):
        tok = self.cur()
        if tok.kind == "op" and tok.value in ("!", "~", "-", "+", "++", "--", "*", "&"):
            self.advance()
            inner = self.parse_unary()
            if tok.value == "+":
                return inner
            if tok.value == "&":
                if inner[0] != "var":
                    _err(tok, "cannot take the address of this expression")
                return ("int", 0)
            if tok.value in ("++", "--"):
                if inner[0] != "var":
                    _err(tok, "++ and -- need a variable")
                return ("pre", tok.value, inner[1])
            return ("un", tok.value, inner)
        return self.parse_postfix()

    def parse_postfix(self):
        expr = self.parse_primary()
        while True:
            if self.match_op("("):
                if expr[0] != "var":
                    _err(self.cur(), "only direct calls are supported")
                args = []
                if not self.check_op(")"):
                    while True:
                        args.append(self.parse_expr())
                        if not self.match_op(","):
                            break
                self.expect_op(")")
                expr = ("call", expr[1], args)
            elif self.cur().kind == "op" and self.cur().value in ("++", "--"):
                op = self.advance().value
                if expr[0] != "var":
                    _err(self.cur(), "++ and -- need a variable")
                expr = ("post", op, expr[1])
            else:
                return expr

    def parse_primary(self):
        tok = self.advance()
        if tok.kind == "num":
            return ("int", tok.value)
        if tok.kind == "str":
            return ("str", tok.value)
        if tok.kind == "id":
            return ("var", tok.value)
        if tok.kind == "op" and tok.value == "(":
            expr = self.parse_expr()
            self.expect_op(")")
            return expr
        _err(tok, "expected an expression")
        return ("int", 0)


def fold(expr):
    kind = expr[0]
    if kind == "un":
        inner = fold(expr[2])
        if inner[0] == "int":
            value = inner[1]
            op = expr[1]
            if op == "-":
                return ("int", -value)
            if op == "!":
                return ("int", 0 if value else 1)
            if op == "~":
                return ("int", (~value) & 0xFFFFFFFF)
        return ("un", expr[1], inner)
    if kind == "bin":
        left, right = fold(expr[2]), fold(expr[3])
        op = expr[1]
        if op == "&&" and left[0] == "int" and left[1] == 0:
            return ("int", 0)
        if op == "||" and left[0] == "int" and left[1] != 0:
            return ("int", 1)
        if left[0] == "int" and right[0] == "int":
            a, b = left[1], right[1]
            if op in ("/", "%") and b == 0:
                raise BuildError("division by zero")
            return ("int", _apply(op, a, b))
        return ("bin", op, left, right)
    return expr


def _cdiv(a: int, b: int) -> int:
    if a < 0 and b < 0:
        return abs(a) // abs(b)
    if a < 0:
        return - (abs(a) // abs(b))
    if b < 0:
        return - (a // abs(b))
    return a // b


def _cmod(a: int, b: int) -> int:
    return a - _cdiv(a, b) * b


def _apply(op: str, a: int, b: int) -> int:
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return _cdiv(a, b)
    if op == "%":
        return _cmod(a, b)
    if op == "<<":
        return (a << (b & 31)) & 0xFFFFFFFF
    if op == ">>":
        return (a & 0xFFFFFFFF) >> (b & 31)
    if op == "&":
        return a & b
    if op == "|":
        return a | b
    if op == "^":
        return a ^ b
    if op == "&&":
        return 1 if a and b else 0
    if op == "||":
        return 1 if a or b else 0
    if op == "==":
        return 1 if a == b else 0
    if op == "!=":
        return 1 if a != b else 0
    if op == "<":
        return 1 if a < b else 0
    if op == ">":
        return 1 if a > b else 0
    if op == "<=":
        return 1 if a <= b else 0
    if op == ">=":
        return 1 if a >= b else 0
    raise BuildError(f"bad operator {op}")


class Codegen:
    def __init__(self, program: xtensa.Program) -> None:
        self.p = program
        self.locals: dict[str, int] = {}
        self.next_local = 0
        self.temp = 40
        self.labels = 0

    def fresh(self) -> str:
        self.labels += 1
        return f"L{self.labels}"

    def add_local(self, name: str) -> int:
        if name in self.locals:
            raise BuildError(f"duplicate local {name}")
        if self.next_local >= 40:
            raise BuildError("too many locals")
        slot = self.next_local
        self.next_local += 1
        self.locals[name] = slot
        return slot

    def alloc_temp(self) -> int:
        if self.temp >= 56:
            raise BuildError("expression is too complex")
        slot = self.temp
        self.temp += 1
        return slot

    def emit_stmt(self, stmt) -> None:
        kind = stmt[0]
        if kind == "empty":
            return
        if kind == "block":
            for item in stmt[1]:
                self.emit_stmt(item)
                self.temp = 40
            return
        if kind == "decl":
            slot = self.add_local(stmt[1])
            if stmt[2] is not None:
                self.emit_expr(stmt[2])
                self.p.s32i(2, 1, slot)
            self.temp = 40
            return
        if kind == "expr":
            self.emit_expr(stmt[1])
            self.temp = 40
            return
        if kind == "return":
            if stmt[1] is not None:
                self.emit_expr(stmt[1])
            self.p.ret()
            self.temp = 40
            return
        if kind == "if":
            self.emit_expr(stmt[1])
            else_l, end_l = self.fresh(), self.fresh()
            self.p.beqz(2, else_l if stmt[3] is not None else end_l)
            self.temp = 40
            self.emit_stmt(stmt[2])
            if stmt[3] is not None:
                self.p.j(end_l)
                self.p.label(else_l)
                self.emit_stmt(stmt[3])
            self.p.label(end_l)
            return
        if kind == "while":
            start, end = self.fresh(), self.fresh()
            self.p.label(start)
            self.emit_expr(stmt[1])
            self.p.beqz(2, end)
            self.temp = 40
            self.emit_stmt(stmt[2])
            self.p.j(start)
            self.p.label(end)
            return
        if kind == "for":
            if stmt[1] is not None:
                self.emit_stmt(stmt[1])
            start, end = self.fresh(), self.fresh()
            self.p.label(start)
            if stmt[2] is not None:
                self.emit_expr(stmt[2])
                self.p.beqz(2, end)
                self.temp = 40
            self.emit_stmt(stmt[4])
            if stmt[3] is not None:
                self.emit_expr(stmt[3])
                self.temp = 40
            self.p.j(start)
            self.p.label(end)
            return
        raise BuildError(f"bad statement {kind}")

    def emit_expr(self, expr) -> None:
        expr = fold(expr)
        kind = expr[0]
        if kind == "int":
            self.p.movi(2, expr[1])
            return
        if kind == "str":
            self.p.load_string(2, expr[1])
            return
        if kind == "var":
            if expr[1] not in self.locals:
                raise BuildError(f"unknown variable {expr[1]}")
            self.p.l32i(2, 1, self.locals[expr[1]])
            return
        if kind == "assign":
            self.emit_expr(expr[2])
            self.p.s32i(2, 1, self.locals[expr[1]])
            return
        if kind == "pre":
            slot = self.locals[expr[2]]
            self.p.l32i(2, 1, slot)
            self.p.addi(2, 2, 1 if expr[1] == "++" else -1)
            self.p.s32i(2, 1, slot)
            return
        if kind == "post":
            slot = self.locals[expr[2]]
            self.p.l32i(2, 1, slot)
            saved = self.alloc_temp()
            self.p.s32i(2, 1, saved)
            self.p.addi(2, 2, 1 if expr[1] == "++" else -1)
            self.p.s32i(2, 1, slot)
            self.p.l32i(2, 1, saved)
            return
        if kind == "un":
            self.emit_expr(expr[2])
            if expr[1] == "-":
                self.p.neg(2, 2)
            elif expr[1] == "!":
                yes, end = self.fresh(), self.fresh()
                self.p.beqz(2, yes)
                self.p.movi(2, 0)
                self.p.j(end)
                self.p.label(yes)
                self.p.movi(2, 1)
                self.p.label(end)
            elif expr[1] == "~":
                self.p.movi(3, -1)
                self.p.xor(2, 2, 3)
            elif expr[1] == "*":
                return
            else:
                raise BuildError(f"bad unary {expr[1]}")
            return
        if kind == "call":
            if len(expr[2]) > 4:
                raise BuildError("too many arguments")
            spilled = []
            for arg in expr[2]:
                self.emit_expr(arg)
                slot = self.alloc_temp()
                self.p.s32i(2, 1, slot)
                spilled.append(slot)
            for index, slot in enumerate(spilled):
                self.p.l32i(10 + index, 1, slot)
            self.p.call(expr[1])
            self.p.move(2, 10)
            return
        if kind == "bin":
            self.emit_bin(expr[1], expr[2], expr[3])
            return
        raise BuildError(f"bad expression {kind}")

    def emit_bin(self, op: str, left, right) -> None:
        if op == "&&":
            no, end = self.fresh(), self.fresh()
            self.emit_expr(left)
            self.p.beqz(2, no)
            self.temp = 40
            self.emit_expr(right)
            self.p.beqz(2, no)
            self.p.movi(2, 1)
            self.p.j(end)
            self.p.label(no)
            self.p.movi(2, 0)
            self.p.label(end)
            return
        if op == "||":
            yes, end = self.fresh(), self.fresh()
            self.emit_expr(left)
            self.p.bnez(2, yes)
            self.temp = 40
            self.emit_expr(right)
            self.p.bnez(2, yes)
            self.p.movi(2, 0)
            self.p.j(end)
            self.p.label(yes)
            self.p.movi(2, 1)
            self.p.label(end)
            return
        self.emit_expr(left)
        slot = self.alloc_temp()
        self.p.s32i(2, 1, slot)
        self.emit_expr(right)
        self.p.l32i(3, 1, slot)
        if op == "+":
            self.p.add(2, 3, 2)
        elif op == "-":
            self.p.sub(2, 3, 2)
        elif op == "*":
            self._call2("__mulsi3")
        elif op == "/":
            self._call2("__divsi3")
        elif op == "%":
            self._call2("__modsi3")
        elif op == "&":
            self.p.and_(2, 3, 2)
        elif op == "|":
            self.p.or_(2, 3, 2)
        elif op == "^":
            self.p.xor(2, 3, 2)
        elif op == "<<":
            self.p.ssl(2)
            self.p.sll(3, 3)
            self.p.move(2, 3)
        elif op == ">>":
            self.p.ssr(2)
            self.p.srl(3, 3)
            self.p.move(2, 3)
        elif op in ("==", "!=", "<", ">", "<=", ">="):
            self._cmp(op)
        else:
            raise BuildError(f"bad operator {op}")

    def _call2(self, name: str) -> None:
        self.p.move(10, 3)
        self.p.move(11, 2)
        self.p.call(name)
        self.p.move(2, 10)

    def _cmp(self, op: str) -> None:
        yes, end = self.fresh(), self.fresh()
        if op == "==":
            self.p.beq(3, 2, yes)
        elif op == "!=":
            self.p.bne(3, 2, yes)
        elif op == "<":
            self.p.blt(3, 2, yes)
        elif op == ">":
            self.p.blt(2, 3, yes)
        elif op == "<=":
            self.p.bge(2, 3, yes)
        elif op == ">=":
            self.p.bge(3, 2, yes)
        self.p.movi(2, 0)
        self.p.j(end)
        self.p.label(yes)
        self.p.movi(2, 1)
        self.p.label(end)


def emit_function(program: xtensa.Program, func: Func) -> None:
    program.func(func.name)
    program.use_slots(56)
    gen = Codegen(program)
    if len(func.params) > 4:
        raise BuildError(f"{func.name} has too many parameters")
    for index, name in enumerate(func.params):
        gen.add_local(name)
        program.s32i(2 + index, 1, index)
    gen.emit_stmt(("block", func.body))
    program.ret()


def compile_units(units: list[tuple[str, str]], include_dirs: list[str]) -> xtensa.LinkResult:
    program = xtensa.Program()
    xtensa.add_runtime(program)
    funcs: dict[str, Func] = {}
    for path, text in units:
        tokens = preprocess(path, text, include_dirs)
        Parser(tokens, path).parse_globals(funcs)
    for func in funcs.values():
        if func.body is not None:
            emit_function(program, func)
    if "app_main" not in program._names:
        raise BuildError("app_main is not defined")
    xtensa.add_entry(program)
    return program.link()


def compile_files(paths: list[str], include_dirs: list[str]) -> xtensa.LinkResult:
    units = []
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            units.append((path, handle.read()))
    return compile_units(units, include_dirs)
