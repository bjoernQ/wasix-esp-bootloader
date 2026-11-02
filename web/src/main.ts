import { bootloader } from "virtual:project-files";
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
  <div class="content">
    <header>
      <img src="/esp-rs.svg" alt="esp-rs" width="100" height="100" />
      <h1>ESP-IDF second stage bootloader builder</h1>
      <p>Build the second-stage bootloader in the browser.</p>
    </header>
    <h2>Options</h2>
    <div class="fields">
      <label><span>Chip</span><select id="chip"></select></label>
      <label><span>Mode</span><select id="mode"></select></label>
      <label><span>Frequency</span><select id="freq"></select></label>
      <label><span>Size</span><select id="size"></select></label>
      <label><span>Log</span><select id="log-level"></select></label>
      <label><span>Console baud</span><input id="baud" type="number" min="1" step="1" value="115200"></label>
      <label><span>Partition</span><input id="partition" type="text" value="0x8000" spellcheck="false"></label>
      <label><span>Reset GPIO</span><input id="gpio" type="number" step="1" value="-1"></label>
      <label><span>Rollback</span><input id="rollback" type="checkbox"></label>
      <label><span>Require SHA-256</span><input id="sha256" type="checkbox" checked></label>
    </div>
    <div class="actions">
      <button id="build" class="primary">Build</button>
      <button id="download" disabled>Download .bin</button>
      <button id="clear">Clear</button>
    </div>
    <h2>Build</h2>
    <pre id="log"></pre>
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

function append(text: string): void {
  logEl.textContent += text.endsWith("\n") ? text : `${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function invalidate(): void {
  image = null;
  imageChip = null;
  downloadButton.disabled = true;
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
  node.addEventListener("change", invalidate);
}

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

byId("clear").addEventListener("click", () => {
  logEl.textContent = "";
});
