import { bootloader } from "virtual:project-files";
import { Board } from "./flash";
import { compileIdfBootloader } from "./compile-boot";
import type { BootOptions } from "./wasix";

type Chip = {
  id: string;
  label: string;
  arch: string;
  chipId: number;
  flashOffset: number;
};

const chips = JSON.parse(bootloader["chips.json"] ?? "[]") as Chip[];
if (!chips.length) throw new Error("chip table is missing");

const app = document.querySelector("#app");
if (!app) throw new Error("missing #app");

app.innerHTML = `
  <header>
    <div>
      <h1>ESP-IDF bootloader</h1>
      <p>Build compiles the ESP-IDF second-stage bootloader in the browser.</p>
    </div>
    <div id="isolation"></div>
  </header>
  <section class="note">
    This is the ESP-IDF bootloader, compiled here with clang. It brings up the chip, reads the partition table, checks the application, and jumps to it. Flash mode, frequency, size, log level, console baud, rollback, SHA-256 checking, factory-reset GPIO, and the partition offset are applied to the bootloader configuration before that compile.
    Download mode always uses 115200. Flash tries the classic UART reset, then the USB-JTAG reset used by C3, S3, and later DevKits. Monitor pulses the chip into the running application and listens at the console baud. Flashing replaces the bootloader at <code id="flash-at"></code>.
  </section>
  <div class="toolbar">
    <label>Chip <select id="chip"></select></label>
    <label>Mode <select id="mode"></select></label>
    <label>Frequency <select id="freq"></select></label>
    <label>Size <select id="size"></select></label>
    <label>Log <select id="log-level"></select></label>
    <label>Console baud <input id="baud" type="number" min="1" step="1" value="115200"></label>
    <label>Partition <input id="partition" type="text" value="0x8000" spellcheck="false"></label>
    <label>Reset GPIO <input id="gpio" type="number" step="1" value="-1"></label>
    <label><input id="rollback" type="checkbox"> Rollback</label>
    <label><input id="sha256" type="checkbox" checked> Require SHA-256</label>
    <button id="build" class="primary">Build</button>
    <button id="download" disabled>Download .bin</button>
    <button id="connect">Connect</button>
    <button id="flash" disabled>Flash</button>
    <button id="monitor" disabled>Monitor</button>
    <button id="clear">Clear</button>
  </div>
  <div class="workspace">
    <section class="terminal">
      <h2>Build and serial</h2>
      <pre id="log"></pre>
    </section>
  </div>
`;

const chipSelect = byId("chip") as HTMLSelectElement;
const modeSelect = fill("mode", ["qio", "qout", "dio", "dout"], "dio");
const freqSelect = fill("freq", ["80m", "40m", "26m", "20m"], "40m");
const sizeSelect = fill("size", ["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"], "4MB");
const logSelect = fill("log-level", ["none", "error", "warn", "info", "debug", "verbose"], "info");
const baudInput = byId("baud") as HTMLInputElement;
const partitionInput = byId("partition") as HTMLInputElement;
const gpioInput = byId("gpio") as HTMLInputElement;
const rollbackInput = byId("rollback") as HTMLInputElement;
const shaInput = byId("sha256") as HTMLInputElement;
const logEl = byId("log");
const buildButton = byId("build") as HTMLButtonElement;
const downloadButton = byId("download") as HTMLButtonElement;
const connectButton = byId("connect") as HTMLButtonElement;
const flashButton = byId("flash") as HTMLButtonElement;
const monitorButton = byId("monitor") as HTMLButtonElement;
const flashAt = byId("flash-at");
const isolation = byId("isolation");

isolation.textContent = crossOriginIsolated ? "cross-origin isolated" : "waiting to isolate this page";

for (const chip of chips) {
  const option = document.createElement("option");
  option.value = chip.id;
  option.textContent = `${chip.label} (${chip.arch})`;
  chipSelect.append(option);
}
chipSelect.value = chips.some((chip) => chip.id === "esp32c6") ? "esp32c6" : chips[0].id;

let image: Uint8Array | null = null;
let imageChip: Chip | null = null;
let busy = false;
const board = new Board();
board.onText = (text) => append(text);

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function fill(id: string, values: string[], selected: string): HTMLSelectElement {
  const select = byId(id) as HTMLSelectElement;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = selected;
  return select;
}

function selectedChip(): Chip {
  const chip = chips.find((item) => item.id === chipSelect.value);
  if (!chip) throw new Error("unknown chip");
  return chip;
}

function showOffset(): void {
  flashAt.textContent = `0x${selectedChip().flashOffset.toString(16)}`;
}

function append(text: string): void {
  logEl.textContent += text.endsWith("\n") ? text : `${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function invalidate(): void {
  image = null;
  imageChip = null;
  downloadButton.disabled = true;
  flashButton.disabled = true;
}

function options(): BootOptions {
  const baud = Number(baudInput.value);
  const resetGpio = Number(gpioInput.value);
  if (!Number.isInteger(baud) || baud < 1) throw new Error("Baud must be a positive integer.");
  if (!Number.isInteger(resetGpio)) throw new Error("Reset GPIO must be an integer, or -1 to leave it unused.");
  return {
    chip: selectedChip().id,
    mode: modeSelect.value,
    freq: freqSelect.value,
    size: sizeSelect.value,
    logLevel: logSelect.value,
    baud,
    rollback: rollbackInput.checked,
    sha256: shaInput.checked,
    resetGpio,
    partition: partitionInput.value.trim(),
  };
}

for (const node of [chipSelect, modeSelect, freqSelect, sizeSelect, logSelect, baudInput, partitionInput, gpioInput, rollbackInput, shaInput]) {
  node.addEventListener("change", () => {
    showOffset();
    invalidate();
  });
}

showOffset();
append(`Ready. ${chips.length} chips. Build compiles the ESP-IDF bootloader in the browser. Loading the compiler and the first chip takes several minutes.`);

buildButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  buildButton.disabled = true;
  try {
    const chip = selectedChip();
    const built = await compileIdfBootloader(options(), append);
    const chipId = new DataView(built.buffer, built.byteOffset, built.byteLength).getUint16(12, true);
    if (chipId !== chip.chipId) throw new Error(`image chip id ${chipId} does not match ${chip.label}`);
    image = built;
    imageChip = chip;
    downloadButton.disabled = false;
    flashButton.disabled = !board.connected;
    append(`Image ${built.length} bytes, chip id ${chipId}, flash at 0x${chip.flashOffset.toString(16)}.`);
  } catch (error) {
    append(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    buildButton.disabled = false;
  }
});

downloadButton.addEventListener("click", () => {
  if (!image || !imageChip) return;
  const bytes = new ArrayBuffer(image.byteLength);
  new Uint8Array(bytes).set(image);
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${imageChip.id}-bootloader.bin`;
  link.click();
  URL.revokeObjectURL(url);
});

connectButton.addEventListener("click", async () => {
  try {
    if (board.connected) {
      await board.disconnect();
      connectButton.textContent = "Connect";
      flashButton.disabled = true;
      monitorButton.disabled = true;
      append("serial closed");
      return;
    }
    const baud = Number(baudInput.value);
    append(await board.connect(Number.isInteger(baud) && baud > 0 ? baud : 115200));
    connectButton.textContent = "Disconnect";
    flashButton.disabled = image == null;
    monitorButton.disabled = false;
  } catch (error) {
    append(error instanceof Error ? error.message : String(error));
  }
});

flashButton.addEventListener("click", async () => {
  if (!image || !imageChip || busy) return;
  busy = true;
  flashButton.disabled = true;
  try {
    const baud = Number(baudInput.value);
    await board.flash(image, imageChip.flashOffset, imageChip.id, Number.isInteger(baud) && baud > 0 ? baud : 115200, append);
    monitorButton.disabled = false;
  } catch (error) {
    append(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    flashButton.disabled = image == null || !board.connected;
  }
});

byId("clear").addEventListener("click", () => {
  logEl.textContent = "";
});

monitorButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  monitorButton.disabled = true;
  try {
    const baud = Number(baudInput.value);
    await board.monitor(Number.isInteger(baud) && baud > 0 ? baud : 115200, append);
  } catch (error) {
    append(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    monitorButton.disabled = !board.connected;
  }
});
