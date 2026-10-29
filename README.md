# ESP-IDF bootloader builder

A local page that builds the ESP-IDF second-stage bootloader for the current Espressif chips and flashes it with Web Serial.

Build does not compile inside the browser. The dev server runs `toolchain/build-real-bootloader.py` in WSL, which configures a small ESP-IDF project and runs `idf.py bootloader`. The image is the normal IDF bootloader: it brings the chip up, checks the application, and jumps to it.

## Run the page

You need Node.js 22 or newer, and Chrome or Edge for Web Serial.

```powershell
cd web
npm install
npm run dev
```

Open http://localhost:5173/ . Pick a chip and the bootloader options, then Build. The first build for a chip configures ESP-IDF and takes a few minutes. Later builds reuse `/opt/idf-targets/<chip>` in WSL.

Connect opens the serial port. Flash writes the image at the offset shown on the page (download mode stays at 115200). Monitor resets the chip and listens at the console baud. Clear empties the log.

`npm run build` typechecks and writes `web/dist`. `npm run preview` serves that build and still needs the same WSL build machine, because Build calls `/api/bootloader` on the dev or preview server.

## WSL build machine

`toolchain/build-real-bootloader.py` expects this layout in Ubuntu:

- ESP-IDF at `/opt/esp-idf` (this project was used with v6.2, commit `9c37a0a`)
- A virtualenv at `/opt/idf-venv`, installed from `tools/requirements/requirements.core.txt` with the matching `espidf.constraints.v6.2.txt` in `~/.espressif/`
- `riscv32-esp-elf-gcc` in `/opt/esp-clang/sysroots/riscv32-esp-elf/bin`
- `xtensa-esp-elf-gcc` in `/opt/esp-clang/sysroots/xtensa-esp-elf/bin` (ESP32, ESP32-S2, and ESP32-S3)

The script sets `IDF_PATH`, `IDF_PYTHON_ENV_PATH=/opt/idf-venv`, and `ESP_IDF_VERSION=6.2.0`. It copies `examples/get-started/hello_world` to `/opt/idf-targets/<chip>`, applies the options to `sdkconfig`, and builds `build/bootloader/bootloader.bin`.

From this repo in the same Ubuntu machine:

```bash
python3 toolchain/build-real-bootloader.py --chip esp32c6 --mode dio --freq 40m --size 4MB --log info --baud 115200 --rollback 0 --sha256 1 --reset-gpio -1 --partition 0x8000
```

## Update the bootloader to a specific IDF release

The page builds whatever tree is checked out at `/opt/esp-idf`. `toolchain/build-real-bootloader.py` also forces `ESP_IDF_VERSION` to `6.2.0` and reuses `/opt/idf-targets/<chip>`, so a new release needs the checkout, the Python packages, that version string, and the old chip projects updated together. Run these as root in Ubuntu. Replace `v5.4.2` with the release tag you want (`v5.4.2`, `v5.5.1`, `v6.1`, and so on).

```bash
cd /opt/esp-idf
git fetch origin tag v5.4.2 --depth 1
git checkout v5.4.2
git submodule update --init --recursive
```

Install the Python packages for that minor version. The constraints file name is `v<major>.<minor>`, so `v5.4.2` uses `espidf.constraints.v5.4.txt`.

```bash
curl -fsSL -o /root/.espressif/espidf.constraints.v5.4.txt \
  https://dl.espressif.com/dl/esp-idf/espidf.constraints.v5.4.txt
rm -rf /opt/idf-venv
python3 -m venv /opt/idf-venv
/opt/idf-venv/bin/python -m pip install \
  -r /opt/esp-idf/tools/requirements/requirements.core.txt \
  -c /root/.espressif/espidf.constraints.v5.4.txt
```

In `toolchain/build-real-bootloader.py`, set `ESP_IDF_VERSION` to the release number without the leading `v` (`5.4.2` for tag `v5.4.2`). The script passes that value into `idf.py`. It has to match the constraints file above.

Drop the old per-chip projects. The next Build copies `examples/get-started/hello_world` from the new tree and runs `idf.py set-target` again.

```bash
rm -rf /opt/idf-targets
```

The script looks for `riscv32-esp-elf-gcc` and `xtensa-esp-elf-gcc` in `/opt/esp-clang/sysroots/riscv32-esp-elf/bin` and `/opt/esp-clang/sysroots/xtensa-esp-elf/bin`. The versions that release expects are listed in `/opt/esp-idf/tools/tools.json` under `riscv32-esp-elf` and `xtensa-esp-elf`. If `idf.py` reports a toolchain mismatch, install those versions and put their `bin` directories on those two paths.

Chips that release does not contain still appear on the page. Build fails for those at `set-target`. The list is `CHIPS` in `toolchain/build-real-bootloader.py` and `web/public/toolchain/bootloader/chips.json`.

## What stays out of git

`web/node_modules`, `web/dist`, and `.wasmer-cache` are installed or downloaded locally.

`web/public/toolchain/bin/` holds the optional wasm `clang` and `ld.lld` (about 180 MB). The page does not use them. They belong to an earlier experiment that compiled a small freestanding program in the browser. `toolchain/build-esp-clang.sh` and `toolchain/wasi-compat/` are the scripts from that build.

`toolchain/out/` is local compiler output. `/opt/idf-targets` in WSL is the per-chip IDF build tree.

`.tools` was a downloaded Windows `xtensa-esp32-elf` toolchain, plus scripts that fetched pages from esp.onweb.dev while searching for a compiler. The app does not use any of it, so that directory is not part of the project.
