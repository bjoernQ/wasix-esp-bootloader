import { bootloader } from "virtual:project-files";
import { compileIdfBootloader } from "./compile-boot";
import { encryptions, freqs, logLevels, modes, readLink, sizes, writeLink, type LinkState } from "./query";
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
      <p>Build the second-stage bootloader in the browser. The address bar stores these options, so the link opens the same setup.</p>
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
      <label><span>Secure boot</span><input id="secure-boot" type="checkbox"></label>
      <label id="verify-key-row" hidden><span>Verify key</span><input id="verify-key" type="text" spellcheck="false" placeholder="64-byte public key, hex"></label>
      <label><span>Flash encryption</span><select id="encryption"></select></label>
    </div>
    <div class="notes">
      <p id="secure-note"></p>
      <p>The first boot burns the flash encryption key into eFuse. That key cannot be read back. Release mode write-protects those eFuses and disables UART download, so encryption stays on. Development mode still burns the key. UART download stays usable, and encryption can still be turned off by burning more eFuse bits.</p>
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
const modeSelect = fill("mode", modes, "dio");
const freqSelect = fill("freq", freqs, "40m");
const sizeSelect = fill("size", sizes, "4MB");
const logSelect = fill("log-level", logLevels, "info");
const baudInput = byId("baud") as HTMLInputElement;
const partitionInput = byId("partition") as HTMLInputElement;
const gpioInput = byId("gpio") as HTMLInputElement;
const rollbackInput = byId("rollback") as HTMLInputElement;
const shaInput = byId("sha256") as HTMLInputElement;
const secureInput = byId("secure-boot") as HTMLInputElement;
const verifyRow = byId("verify-key-row");
const verifyInput = byId("verify-key") as HTMLInputElement;
const encryptionSelect = fill("encryption", encryptions, "off");
const secureNote = "Secure boot images from this page are unsigned. Sign the downloaded file before flashing. Secure Boot V2: espsecure.py sign_data --version 2. The image is padded to 4 KB so the signature sector lines up. ESP32 uses Secure Boot V1 and needs the 64-byte verification public key pasted above. The private key stays on your machine.";
const logEl = byId("log");
const buildButton = byId("build") as HTMLButtonElement;
const downloadButton = byId("download") as HTMLButtonElement;

for (const chip of chips) {
  const option = document.createElement("option");
  option.value = chip.id;
  option.textContent = `${chip.label} (${chip.arch})`;
  chipSelect.append(option);
}
const chipIds = chips.map((chip) => chip.id);
const loaded = readLink(location.search, chipIds);
applyLink(loaded.state);
syncChip();
syncAddressBar();

let image: Uint8Array | null = null;
let imageChip: Chip | null = null;
let busy = false;

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function applyLink(state: LinkState): void {
  chipSelect.value = state.chip;
  modeSelect.value = state.mode;
  freqSelect.value = state.freq;
  sizeSelect.value = state.size;
  logSelect.value = state.log;
  baudInput.value = state.baud;
  partitionInput.value = state.partition;
  gpioInput.value = state.gpio;
  rollbackInput.checked = state.rollback;
  shaInput.checked = state.sha256;
  secureInput.checked = state.secure;
  verifyInput.value = state.key;
  encryptionSelect.value = state.encryption;
}

function currentLink(): LinkState {
  return {
    chip: chipSelect.value,
    mode: modeSelect.value,
    freq: freqSelect.value,
    size: sizeSelect.value,
    log: logSelect.value,
    baud: baudInput.value,
    partition: partitionInput.value,
    gpio: gpioInput.value,
    rollback: rollbackInput.checked,
    sha256: shaInput.checked,
    secure: secureInput.checked,
    key: verifyInput.value,
    encryption: encryptionSelect.value,
  };
}

function syncAddressBar(): void {
  const query = writeLink(currentLink(), chipIds);
  const next = `${location.pathname}${query}${location.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (next !== current) history.replaceState(history.state, "", next);
}

function fill(id: string, values: readonly string[], selected: string): HTMLSelectElement {
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

function syncChip(): void {
  const id = chipSelect.value;
  verifyRow.hidden = id !== "esp32" || !secureInput.checked;
  const note = document.getElementById("secure-note");
  if (note) note.textContent = id === "esp32h4"
    ? "ESP32-H4 does not support secure boot. Flash encryption is still available."
    : secureNote;
  secureInput.disabled = id === "esp32h4";
  if (id === "esp32h4") secureInput.checked = false;
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
    secureBoot: secureInput.checked,
    verifyKey: verifyInput.value.trim(),
    encryption: encryptionSelect.value as BootOptions["encryption"],
  };
}

function onOptionChange(): void {
  syncChip();
  invalidate();
  syncAddressBar();
}

for (const node of [chipSelect, modeSelect, freqSelect, sizeSelect, logSelect, baudInput, partitionInput, gpioInput, rollbackInput, shaInput, secureInput, verifyInput, encryptionSelect]) {
  node.addEventListener("change", onOptionChange);
}
for (const node of [baudInput, partitionInput, gpioInput, verifyInput]) {
  node.addEventListener("input", onOptionChange);
}

append(`Ready. ${chips.length} chips. Build compiles the ESP-IDF bootloader in the browser. Loading the compiler and the first chip takes several minutes.`);
for (const warning of loaded.warnings) append(warning);

buildButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  buildButton.disabled = true;
  try {
    const chip = selectedChip();
    const opts = options();
    const built = await compileIdfBootloader(opts, append);
    const chipId = new DataView(built.buffer, built.byteOffset, built.byteLength).getUint16(12, true);
    if (chipId !== chip.chipId) throw new Error(`image chip id ${chipId} does not match ${chip.label}`);
    image = built;
    imageChip = chip;
    downloadButton.disabled = false;
    append(`Image ${built.length} bytes, chip id ${chipId}, flash at 0x${chip.flashOffset.toString(16)}.`);
    const slot = Number(opts.partition) - chip.flashOffset;
    if (Number.isFinite(slot) && slot > 0 && built.length > slot) {
      append(`This image is ${built.length - slot} bytes past the ${slot}-byte slot from 0x${chip.flashOffset.toString(16)} to ${opts.partition}. The tail sits in the partition-table sector and the ROM checksum fails. Raise the partition offset so the slot is at least ${built.length} bytes.`);
    }
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
