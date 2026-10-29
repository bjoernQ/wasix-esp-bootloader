# ESP-IDF bootloader builder

A static web page that builds the ESP-IDF second-stage bootloader for Espressif chips, entirely in the browser, and downloads the image.

The page loads the ESP-IDF bootloader sources and compiles them with `clang` and `ld.lld` built for WebAssembly, running on the [Wasmer SDK](https://github.com/wasmerio/wasmer-js). Nothing runs on a server. It does not use GCC or `idf.py`.

> [!WARNING]
> Bootloaders with secure boot or flash encryption burn eFuses on first boot. That cannot be undone and can make a chip unusable if the image or keys are wrong. Test on a development board first. This project comes with no warranty (see the licenses).

## Run the page

You need Node.js 22.18 or newer.

```sh
cd web
npm install
npm run fetch-compiler
npm run dev
```

`npm run fetch-compiler` downloads the WebAssembly `clang` (110 MB) and `lld` (75 MB) from this repository's [releases](https://github.com/bjoernQ/wasix-esp-bootloader/releases) and checks their SHA-256 hashes. They are too large for git. To build them yourself instead, see [Build the compiler yourself](#build-the-compiler-yourself).

Open http://localhost:5173/, pick a chip and the bootloader options, then Build. The browser keeps the compiler for the rest of the session. The first build downloads the compiler and that chip's 20–50 MB source package.

## Options and links

The address bar stores the options, so a copied link opens the same setup. The link always names the chip. Any parameter left out keeps its default.

| Parameter | Aliases | Values |
| --- | --- | --- |
| `chip` | | `esp32`, `esp32c2`, `esp32c3`, `esp32c5`, `esp32c6`, `esp32c61`, `esp32h2`, `esp32h21`, `esp32h4`, `esp32p4`, `esp32s2`, `esp32s3`, `esp32s31` |
| `mode` | | `qio`, `qout`, `dio`, `dout` |
| `freq` | `frequency` | depends on the chip (see below) |
| `size` | | `1MB` to `128MB` |
| `log` | `log-level` | `none`, `error`, `warn`, `info`, `debug`, `verbose` |
| `baud` | | console baud rate |
| `partition` | | partition table offset, decimal or `0x` hex, a multiple of `0x1000` |
| `gpio` | `reset-gpio` | factory-reset GPIO, `-1` for none |
| `rollback` | | checkbox |
| `sha256` | `sha-256` | checkbox |
| `secure` | `secure-boot` | checkbox |
| `key` | `verify-key` | ESP32 Secure Boot V1 verification public key, hex |
| `encryption` | `flash-encryption` | `off`, `development`, `release` |

Names and choices are matched without case. Checkboxes take `1`/`0`, `true`/`false`, `yes`/`no`, or `on`/`off`. A checkbox name on its own, as in `?rollback`, turns it on. Values the page does not recognize are ignored and reported in the log.

The flash clocks follow ESP-IDF's choices for each chip. ESP32, ESP32-S2, and ESP32-C3 offer 80, 40, 26, and 20 MHz. ESP32-C2 offers 60, 30, 20, and 15 MHz. ESP32-H2 offers 64, 32, and 16 MHz, and ESP32-H21 and ESP32-H4 offer 64 and 32 MHz. The other chips offer 80, 40, and 20 MHz. 120 MHz is not offered.

```
http://localhost:5173/?chip=esp32s3&mode=qio&freq=80m&size=8MB&log=debug&partition=0x9000&gpio=0&rollback=1&encryption=development
```

Secure boot images are unsigned. Sign them before flashing (`espsecure.py sign_data --version 2` for Secure Boot V2). ESP32 uses Secure Boot V1 and needs the 64-byte verification public key. ESP32-H4 does not support secure boot. Secure boot always keeps the SHA-256 check on.

### Known limitations

- On ESP32, Secure Boot V1 and flash encryption each build, but together the loader code is about 4 KB larger than its IRAM region with this clang build. The page rejects that combination.
- 120 MHz flash and octal (OPI) flash modes are not offered.
- The images are built with clang, not the GCC toolchain ESP-IDF uses, so they are not byte-identical to `idf.py` output. Check a new configuration on a development board before relying on it.

## Command line

`npm run build-bootloader` runs the same build in Node, which is useful for scripting and for checking changes:

```sh
npm run build-bootloader -- --chip esp32c3 --freq 80m --size 8MB --out esp32c3-bootloader.bin
```

It takes the same options as the page (`--mode`, `--freq`, `--size`, `--log`, `--baud`, `--partition`, `--gpio`, `--rollback`, `--no-sha256`, `--secure`, `--key`, `--encryption`, `--out`).

## Host the page

`npm run build` typechecks and writes `web/dist`, a static site containing the HTML, JavaScript, the compiler, and the packed sources. Any HTTP server can host it, under any path. The page includes a service worker that adds the cross-origin isolation headers WebAssembly threads need, then reloads once. Servers that already send those headers skip the reload.

```sh
cd web
npm run build
python -m http.server 8080 --directory dist
```

The site is about 550 MB, and the largest file is `clang` at 110 MB. Hosts with per-file size limits, such as Cloudflare Pages, will not take it as is.

## Development

```sh
npm run typecheck
npm test
```

The tests cover link parsing, option validation, `sdkconfig.h` patching, and the image format. CI runs them on every push.

## How it works

Each chip has a package at `web/public/boot-sources/<chip>.bin`. It holds the bootloader's compile commands, sources, headers, `sdkconfig.h`, linker scripts, and the picolibc and `libgcc` archives. The page rewrites `sdkconfig.h` for the chosen options, compiles every source with clang, archives the objects into the component libraries, and links with lld. It then turns the ELF into an ESP image (`web/src/elf-image.ts`) the same way `esptool elf2image` does.

If a symbol the bootloader references is undefined, the link fails. The only exception is a short per-chip list in `compile-boot.ts` of ROM aliases the bootloader never calls, which are linked as address 0 and named in the log. If the loader's IRAM region is a few bytes too small, the build moves that space over from the bootloader's DRAM region and says so in the log.

## Rebuild the source packages

The packages were made from ESP-IDF v6.2 (commit `9c37a0a`) in WSL Ubuntu. To pack a different release:

1. Check out the release at `/opt/esp-idf`:

   ```bash
   cd /opt/esp-idf
   git fetch origin tag v5.4.2 --depth 1
   git checkout v5.4.2
   git submodule update --init --recursive
   ```

2. Build the bootloader for each chip into `/opt/idf-targets/<chip>/build/bootloader`, so each has a `compile_commands.json`, `build.ninja`, and `bootloader.map`.
3. Unpack the matching `riscv32-esp-elf` and `xtensa-esp-elf` toolchains (versions are in `/opt/esp-idf/tools/tools.json`) into `/opt/esp-clang/sysroots/`.
4. Run `npm run pack-sources` in `web/`. To pack only some chips, list them: `npm run pack-sources -- esp32c3 esp32s3`.

## Build the compiler yourself

You can build `clang` and `lld` instead of downloading them. `toolchain/build-esp-clang.sh` cross-compiles Espressif LLVM to `wasm32-wasip1` with wasi-sdk 34. By default it checks out commit `508a314` of `release/esp_22.x`, the commit the released binaries come from. `toolchain/wasi-compat/` holds the small POSIX shims LLVM needs on WASI.

What you need:

- x86-64 Linux, or WSL on Windows. The script downloads the x86-64 build of wasi-sdk, so ARM Linux and macOS do not work as they are.
- About 16 GB of RAM plus swap, and about 5 GB of free disk space.
- Time. It is a full LLVM build. Budget a few hours on a typical machine; many cores help.

On a fresh Ubuntu or WSL install, run as root:

```bash
bash toolchain/setup-wsl.sh        # apt packages, plus a 16 GB /swapfile if there is none
bash toolchain/build-esp-clang.sh
```

`setup-wsl.sh` needs root for `apt-get` and the swapfile. If you install the packages yourself (`build-essential ninja-build python3 git curl cmake`), the build itself does not need root. These environment variables change what `build-esp-clang.sh` does:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ESP_CLANG_ROOT` | `/opt/esp-clang` | Working directory for wasi-sdk, the LLVM checkout, and both builds. Point it somewhere you can write to build without root. |
| `ESP_LLVM_COMMIT` | `508a314…` | LLVM commit to build. Set it to an empty value to build the tip of `ESP_LLVM_BRANCH` instead. |
| `ESP_LLVM_BRANCH` | `release/esp_22.x` | Branch used when `ESP_LLVM_COMMIT` is empty. |
| `ESP_CLANG_JOBS` | `nproc` | Parallel compile jobs. Lower it if the build runs out of memory. |

The results are `$ESP_CLANG_ROOT/build-wasi/bin/clang-22` and `lld`. Copy them to `web/public/toolchain/bin/clang` (renamed from `clang-22`) and `web/public/toolchain/bin/lld`, then run `npm run dev` or `npm run build` as usual.

Skip `npm run fetch-compiler` when you use your own build. Your binaries will not match the pinned hashes, so it would replace them with the released ones.

### Publish a new compiler release

Copy the binaries into `web/public/toolchain/bin/` as above, then upload them as a new release:

```sh
gh release create compiler-v2 web/public/toolchain/bin/clang web/public/toolchain/bin/lld
```

Update the release tag and hashes in `web/scripts/fetch-compiler.ts` to match.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT), at your option.

The packed sources and the compiler contain third-party code under its own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
