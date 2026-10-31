# ESP-IDF bootloader builder

A local page that builds the ESP-IDF second-stage bootloader for the current Espressif chips and flashes it with Web Serial.

Build compiles that bootloader in the browser. The page loads the ESP-IDF sources and runs the WASI `clang` and `ld.lld` shipped with this project. It does not call a host GCC or `idf.py`.

## Run the page

You need Node.js 22 or newer, and Chrome or Edge for Web Serial.

```powershell
cd web
npm install
npm run dev
```

Open http://localhost:5173/ . Pick a chip and the bootloader options, then Build. The compiler is about 180 MB and is cached for the browser session. The first build for a chip also downloads that chip's source package and takes several minutes.

Connect opens the serial port. Flash writes the image at the offset shown on the page (download mode stays at 115200). Monitor resets the chip and listens at the console baud. Clear empties the log.

`npm run build` typechecks and writes `web/dist`. That directory is a static site: HTML, JavaScript, the compiler, and the packed sources. Any plain HTTP server can host it. The page includes a service worker that adds the cross-origin isolation headers WebAssembly needs, then reloads once. Servers that already send those headers skip the reload.

```powershell
cd web
npm run build
python -m http.server 8080 --directory dist
```

## Sources

The compiler is `web/public/toolchain/bin/clang` and `lld`, built by `toolchain/build-esp-clang.sh` from Espressif LLVM (`release/esp_22.x`) with wasi-sdk 34. Picolibc headers and `libc.a` / `libgcc.a` come from the Espressif GNU toolchain sysroot under `/opt/esp-clang/sysroots` in WSL. Those libraries are linked as data. The page does not run the GNU compilers.

Every chip in the list has a static package at `web/public/boot-sources/<chip>.bin`. The browser downloads that file and compiles it. Nothing on the host runs while the page is open.

`npm run pack-sources` writes those packages from a local ESP-IDF checkout. It reads `/opt/idf-targets/<chip>/build/bootloader` and the tree at `/opt/esp-idf`, then stores the file list, headers, `sdkconfig.h`, linker scripts, and picolibc/`libgcc` archives. This project was packed from ESP-IDF v6.2, commit `9c37a0a`. To compile a different release, check that tag out at `/opt/esp-idf`, regenerate each chip's bootloader directory so its file list matches, and run `npm run pack-sources` again. Chips without a package fail at Build. The chip list on the page is `web/public/toolchain/bootloader/chips.json`.

## Update the bootloader to a specific IDF release

The sources the page compiles are whatever is checked out at `/opt/esp-idf`. Run this as root in Ubuntu. Replace `v5.4.2` with the release tag (`v5.4.2`, `v5.5.1`, `v6.1`, and so on).

```bash
cd /opt/esp-idf
git fetch origin tag v5.4.2 --depth 1
git checkout v5.4.2
git submodule update --init --recursive
```

Regenerate `/opt/idf-targets/<chip>/build/bootloader` for that checkout, then run `npm run pack-sources` in `web/`. The page compiles the new package with the in-browser clang. Picolibc has to match the release: the versions are `riscv32-esp-elf` and `xtensa-esp-elf` in `/opt/esp-idf/tools/tools.json`. Unpack those into `/opt/esp-clang/sysroots/riscv32-esp-elf` and `/opt/esp-clang/sysroots/xtensa-esp-elf`.

Chips the release does not contain still appear on the page. Their source list will not match and Build fails for them.

## What stays out of git

`web/node_modules`, `web/dist`, and `.wasmer-cache` are installed or downloaded locally.

`web/public/toolchain/bin/` holds the wasm `clang` and `ld.lld` (about 180 MB) that Build runs. `toolchain/build-esp-clang.sh` and `toolchain/wasi-compat/` are how those binaries were built.

`toolchain/out/` is local compiler output. `/opt/idf-targets` in WSL is the per-chip IDF build tree.

`.tools` was a downloaded Windows `xtensa-esp32-elf` toolchain, plus scripts that fetched pages from esp.onweb.dev while searching for a compiler. The app does not use any of it, so that directory is not part of the project.
