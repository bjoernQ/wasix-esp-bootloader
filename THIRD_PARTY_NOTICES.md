# Third-party software

The code in this repository is licensed under MIT or Apache-2.0 (see `LICENSE-MIT` and `LICENSE-APACHE`). Some files it ships or downloads are other people's work under their own licenses.

## Packed bootloader sources: `web/public/boot-sources/*.bin`

Each package is an archive of files copied unchanged, except for `sdkconfig.h`, which the page rewrites before compiling:

- **ESP-IDF** v6.2 (commit `9c37a0a`): component sources, headers, and linker scripts. Copyright Espressif Systems (Shanghai) Co. Ltd. Apache-2.0, with some files under other permissive licenses noted in their SPDX headers. <https://github.com/espressif/esp-idf>
- **picolibc** headers and `libc.a` from the Espressif toolchain `esp-16.1.0_20260609`. BSD-style licenses, see <https://github.com/picolibc/picolibc/blob/main/COPYING.picolibc>.
- **libgcc** (`libgcc.a`) from the same toolchain. GPL-3.0-or-later with the GCC Runtime Library Exception 3.1. The exception lets you distribute bootloaders linked against it under any license. The corresponding source is the Espressif GCC fork at <https://github.com/espressif/gcc> and the toolchain build at <https://github.com/espressif/crosstool-NG/releases/tag/esp-16.1.0_20260609>.
- **Clang resource headers** (`lib/clang/22/include`) from Espressif LLVM. Apache-2.0 WITH LLVM-exception.

## Compiler: `web/public/toolchain/bin/clang` and `lld`

Not stored in git. `npm run fetch-compiler` downloads them from this repository's GitHub releases. `toolchain/build-esp-clang.sh` builds them from:

- **Espressif LLVM** (`release/esp_22.x`, commit `508a314`), <https://github.com/espressif/llvm-project>. Apache-2.0 WITH LLVM-exception. The script applies small source patches so it builds for WASI.
- **wasi-sdk** 34 (wasi-libc, libc++, libc++abi), <https://github.com/WebAssembly/wasi-sdk>. Apache-2.0 WITH LLVM-exception, MIT, and other permissive licenses.

## Runtime

- **@wasmer/sdk**, <https://github.com/wasmerio/wasmer-js>. "Modified MIT" license (MIT plus an attribution requirement for very large commercial deployments, see `node_modules/@wasmer/sdk/LICENSE`). Copied into `dist/vendor/wasmer` by the build.
- **Fira Sans** is loaded from Google Fonts at runtime and is not redistributed. SIL Open Font License 1.1.
- The **esp-rs logo** (`web/public/esp-rs.svg`) belongs to the esp-rs project.
