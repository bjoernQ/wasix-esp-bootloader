#!/bin/bash
# Cross-compile Espressif Clang (Xtensa + RISC-V) to wasm32-wasip1.
# The host build only produces llvm-tblgen and clang-tblgen. The compiler
# that runs in the browser is build-wasi/bin/clang.
set -euo pipefail

ROOT="${ESP_CLANG_ROOT:-/opt/esp-clang}"
SRC="$ROOT/llvm-project"
NATIVE="$ROOT/build-native"
WASI_BUILD="$ROOT/build-wasi"
WASI_SDK="$ROOT/wasi-sdk-34.0-x86_64-linux"
BRANCH="${ESP_LLVM_BRANCH:-release/esp_22.x}"
# The commit the published compiler was built from. Set ESP_LLVM_COMMIT= (empty) to build the tip of $BRANCH.
COMMIT="${ESP_LLVM_COMMIT-508a314ca7d0c551d26c610d0d109d5b087eff0e}"
JOBS="${ESP_CLANG_JOBS:-$(nproc)}"

mkdir -p "$ROOT"
cd "$ROOT"

if [[ ! -x "$WASI_SDK/bin/clang" ]]; then
  archive="wasi-sdk-34.0-x86_64-linux.tar.gz"
  if [[ ! -f "$archive" ]]; then
    curl -L --fail -o "$archive" \
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz"
  fi
  tar -xzf "$archive" -C "$ROOT"
fi
if [[ ! -x "$WASI_SDK/bin/clang" ]]; then
  found="$(find "$ROOT" -maxdepth 2 -type f -path '*/bin/clang' | head -1)"
  if [[ -n "$found" ]]; then
    WASI_SDK="$(dirname "$(dirname "$found")")"
  fi
fi
if [[ ! -x "$WASI_SDK/bin/clang" ]]; then
  echo "wasi-sdk clang not found under $ROOT" >&2
  exit 1
fi

if [[ ! -d "$SRC/llvm" ]]; then
  if [[ -n "$COMMIT" ]]; then
    git init -q "$SRC"
    git -C "$SRC" fetch --depth 1 https://github.com/espressif/llvm-project.git "$COMMIT"
    git -C "$SRC" checkout -q FETCH_HEAD
  else
    git clone --depth 1 --branch "$BRANCH" https://github.com/espressif/llvm-project.git "$SRC"
  fi
elif [[ -n "$COMMIT" ]] && [[ "$(git -C "$SRC" rev-parse HEAD)" != "$COMMIT" ]]; then
  echo "$SRC is at $(git -C "$SRC" rev-parse HEAD), not $COMMIT." >&2
  echo "Delete $SRC to fetch the pinned commit, or set ESP_LLVM_COMMIT= to build what is there." >&2
  exit 1
fi

if [[ ! -d "$SRC/llvm/lib/Target/Xtensa" ]]; then
  echo "Xtensa backend is missing from $SRC" >&2
  exit 1
fi

python3 - "$SRC" <<'PY'
import sys
from pathlib import Path
src = Path(sys.argv[1])
options = src / "llvm/cmake/modules/HandleLLVMOptions.cmake"
text = options.read_text()
old = "elseif(FUCHSIA OR UNIX OR CYGWIN)"
new = "elseif(FUCHSIA OR UNIX OR CYGWIN OR WASI OR CMAKE_SYSTEM_NAME STREQUAL \"WASI\")"
if old in text:
    options.write_text(text.replace(old, new, 1))
elif new not in text:
    raise SystemExit("HandleLLVMOptions platform check not found")
support = src / "llvm/lib/Support/CMakeLists.txt"
text = support.read_text()
old = "if( UNIX AND NOT (BEOS OR HAIKU) )"
new = "if( (UNIX OR WASI) AND NOT (BEOS OR HAIKU) )"
if old in text:
    support.write_text(text.replace(old, new, 1))
elif new not in text:
    raise SystemExit("Support libm check not found")
bit = src / "llvm/include/llvm/ADT/bit.h"
text = bit.read_text()
old = "defined(__managarm__)"
new = "defined(__managarm__) || defined(__wasi__)"
if old in text and "defined(__wasi__)" not in text:
    bit.write_text(text.replace(old, new, 1))
program = src / "llvm/lib/Support/Unix/Program.inc"
text = program.read_text()
old = "#if !defined(__HAIKU__) && !defined(__MVS__)"
new = "#if !defined(__HAIKU__) && !defined(__MVS__) && !defined(__wasi__)"
if old in text:
    program.write_text(text.replace(old, new, 1))
path = src / "llvm/lib/Support/Unix/Path.inc"
text = path.read_text()
old = "defined(__GNU__) ||       \\\n    defined(__MVS__)"
new = "defined(__GNU__) ||       \\\n    defined(__MVS__) || defined(__wasi__)"
if old in text:
    path.write_text(text.replace(old, new, 1))
elif "defined(__wasi__)" not in text.split("STATVFS_F_FLAG", 1)[0]:
    raise SystemExit("Path.inc statvfs flag guard not found")
compiler = src / "clang/include/clang/Support/Compiler.h"
text = compiler.read_text()
old = "#elif defined(__ELF__) || defined(__MINGW32__) || defined(_AIX) ||             \\"
new = "#elif defined(__wasi__) || defined(__wasm__)\n#define CLANG_ABI LLVM_ATTRIBUTE_VISIBILITY_DEFAULT\n#define CLANG_TEMPLATE_ABI\n#define CLANG_EXPORT_TEMPLATE\n#elif defined(__ELF__) || defined(__MINGW32__) || defined(_AIX) ||             \\\\"
if "#elif defined(__wasi__) || defined(__wasm__)" not in text:
    if old not in text:
        raise SystemExit("clang Compiler.h visibility guard not found")
    compiler.write_text(text.replace(old, new, 1))
stack = src / "clang/lib/Basic/Stack.cpp"
text = stack.read_text()
old = "bool clang::isStackNearlyExhausted() {\n  // We consider 256 KiB"
new = "bool clang::isStackNearlyExhausted() {\n#if defined(__wasi__)\n  return false;\n#endif\n  // We consider 256 KiB"
if old in text:
    stack.write_text(text.replace(old, new, 1))
elif "#if defined(__wasi__)" not in text[text.find("isStackNearlyExhausted"):text.find("isStackNearlyExhausted") + 400]:
    raise SystemExit("Stack.cpp hook not found")
PY

COMPAT="$ROOT/wasi-compat"
rm -rf "$COMPAT"
mkdir -p "$COMPAT"
cp -a "$(dirname "$0")/wasi-compat/." "$COMPAT/"
SYSROOT="$WASI_SDK/share/wasi-sysroot"
WASI_DEFS="-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_SIGNAL -mllvm -wasm-enable-sjlj -I$COMPAT"
python3 - "$SYSROOT" <<'PY'
from pathlib import Path
import sys
un = Path(sys.argv[1]) / "include/wasm32-wasip1/__struct_sockaddr_un.h"
text = un.read_text()
if "sun_path" not in text:
    needle = "sa_family_t sun_family;"
    if needle not in text:
        raise SystemExit("sockaddr_un layout not found")
    un.write_text(text.replace(needle, needle + "\n  char sun_path[108];", 1))
PY
"$WASI_SDK/bin/clang" --target=wasm32-wasip1 --sysroot="$SYSROOT" \
  $WASI_DEFS -c "$COMPAT/stubs.c" -o "$COMPAT/stubs.o"
"$WASI_SDK/bin/llvm-ar" rcs "$COMPAT/libwasi-llvm-stubs.a" "$COMPAT/stubs.o"

if [[ ! -x "$NATIVE/bin/llvm-tblgen" || ! -x "$NATIVE/bin/clang-tblgen" ]]; then
  cmake -G Ninja -S "$SRC/llvm" -B "$NATIVE" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS=clang \
    -DLLVM_TARGETS_TO_BUILD=X86 \
    -DLLVM_ENABLE_ASSERTIONS=OFF \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_BUILD_DOCS=OFF \
    -DCLANG_INCLUDE_TESTS=OFF \
    -DCLANG_ENABLE_ARCMT=OFF \
    -DCLANG_ENABLE_STATIC_ANALYZER=OFF
  cmake --build "$NATIVE" --target llvm-tblgen clang-tblgen -j "$JOBS"
fi

toolchain=""
for candidate in \
  "$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" \
  "$WASI_SDK/share/cmake/wasi-sdk.cmake"
do
  if [[ -f "$candidate" ]]; then
    toolchain="$candidate"
    break
  fi
done
if [[ -z "$toolchain" ]]; then
  echo "wasi-sdk CMake toolchain file not found under $WASI_SDK" >&2
  exit 1
fi

cmake -G Ninja -S "$SRC/llvm" -B "$WASI_BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DCMAKE_C_FLAGS="$WASI_DEFS" \
    -DCMAKE_CXX_FLAGS="$WASI_DEFS" \
    -DCMAKE_EXE_LINKER_FLAGS="-lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-signal -lsetjmp -Wl,-z,stack-size=67108864" \
    -DCMAKE_CXX_STANDARD_LIBRARIES="$COMPAT/libwasi-llvm-stubs.a -lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-signal -lsetjmp" \
    -DCMAKE_C_COMPILER_WORKS=ON \
    -DCMAKE_CXX_COMPILER_WORKS=ON \
    -DLLVM_ENABLE_PROJECTS="clang;lld" \
    -DLLVM_TARGETS_TO_BUILD=RISCV \
    -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa \
    -DLLVM_DEFAULT_TARGET_TRIPLE=riscv32-esp-unknown-elf \
    -DLLVM_TABLEGEN="$NATIVE/bin/llvm-tblgen" \
    -DCLANG_TABLEGEN="$NATIVE/bin/clang-tblgen" \
    -DLLVM_NATIVE_TOOL_DIR="$NATIVE/bin" \
    -DCROSS_TOOLCHAIN_FLAGS_NATIVE="-DCMAKE_C_COMPILER=/usr/bin/gcc;-DCMAKE_CXX_COMPILER=/usr/bin/g++" \
    -DLLVM_ENABLE_THREADS=OFF \
    -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_ZSTD=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF \
    -DLLVM_ENABLE_LIBEDIT=OFF \
    -DLLVM_ENABLE_LIBPFM=OFF \
    -DLLVM_ENABLE_CURL=OFF \
    -DLLVM_ENABLE_ASSERTIONS=OFF \
    -DLLVM_ENABLE_EH=OFF \
    -DLLVM_ENABLE_RTTI=OFF \
    -DLLVM_ENABLE_BINDINGS=OFF \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_UTILS=OFF \
    -DLLVM_BUILD_DOCS=OFF \
    -DLLVM_BUILD_TOOLS=OFF \
    -DLLVM_BUILD_LLVM_DYLIB=OFF \
    -DLLVM_LINK_LLVM_DYLIB=OFF \
    -DLLVM_PARALLEL_LINK_JOBS=1 \
    -DLLVM_PARALLEL_COMPILE_JOBS="$JOBS" \
    -DCLANG_ENABLE_ARCMT=OFF \
    -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
    -DCLANG_INCLUDE_TESTS=OFF \
    -DCLANG_BUILD_TOOLS=ON

cmake --build "$WASI_BUILD" --target clang lld -j "$JOBS"
echo "built $WASI_BUILD/bin/clang-22 and lld"
