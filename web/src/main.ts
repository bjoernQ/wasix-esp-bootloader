import { Wasmer } from "@wasmer/sdk";
import { chipById, chips } from "./chips.ts";
import { compileIdfBootloader, type BuildHost } from "./compile-boot.ts";
import { encryptions, logLevels, modes, sizes, type BootOptions } from "./options.ts";
import { readLink, writeLink, type LinkState } from "./query.ts";

const base = import.meta.env.BASE_URL;
const app = document.querySelector("#app");
if (!app) throw new Error("missing #app");

app.innerHTML = `
  <div class="content">
    <header>
      <img src="${base}esp-rs.svg" alt="esp-rs" width="100" height="100" />
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
      <label><span>Reset GPIO</span><input id="gpio" type="number" min="-1" step="1" value="-1"></label>
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
const modeSelect = fill("mode", modes);
const freqSelect = byId("freq") as HTMLSelectElement;
const sizeSelect = fill("size", sizes);
const logSelect = fill("log-level", logLevels);
const baudInput = byId("baud") as HTMLInputElement;
const partitionInput = byId("partition") as HTMLInputElement;
const gpioInput = byId("gpio") as HTMLInputElement;
const rollbackInput = byId("rollback") as HTMLInputElement;
const shaInput = byId("sha256") as HTMLInputElement;
const secureInput = byId("secure-boot") as HTMLInputElement;
const verifyRow = byId("verify-key-row");
const verifyInput = byId("verify-key") as HTMLInputElement;
const encryptionSelect = fill("encryption", encryptions);
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
const loaded = readLink(location.search);
applyLink(loaded.state);
syncChip();
syncAddressBar();

let image: Uint8Array | null = null;
let imageName = "";
let busy = false;
let wasmer: Wasmer | null = null;

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function applyLink(state: LinkState): void {
  chipSelect.value = state.chip;
  fillFreqs(state.freq);
  modeSelect.value = state.mode;
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
  const query = writeLink(currentLink());
  const next = `${location.pathname}${query}${location.hash}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (next !== current) history.replaceState(history.state, "", next);
}

function fill(id: string, values: readonly string[]): HTMLSelectElement {
  const select = byId(id) as HTMLSelectElement;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  return select;
}

/** The flash clocks differ per chip. Keeps the current one when the new chip has it. */
function fillFreqs(preferred: string): void {
  const chip = chipById(chipSelect.value);
  freqSelect.replaceChildren();
  for (const freq of chip.freqs) {
    const option = document.createElement("option");
    option.value = freq.id;
    option.textContent = freq.id;
    freqSelect.append(option);
  }
  freqSelect.value = chip.freqs.some((freq) => freq.id === preferred) ? preferred : chip.defaultFreq;
}

function syncChip(): void {
  const chip = chipById(chipSelect.value);
  if (!chip.secureBoot) secureInput.checked = false;
  secureInput.disabled = !chip.secureBoot;
  verifyRow.hidden = chip.id !== "esp32" || !secureInput.checked;
  byId("secure-note").textContent = chip.secureBoot
    ? secureNote
    : `${chip.label} does not support secure boot. Flash encryption is still available.`;
  if (secureInput.checked) shaInput.checked = true;
  shaInput.disabled = secureInput.checked;
}

function append(text: string): void {
  logEl.textContent += text.endsWith("\n") ? text : `${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function invalidate(): void {
  image = null;
  downloadButton.disabled = true;
}

function options(): BootOptions {
  return {
    chip: chipSelect.value,
    mode: modeSelect.value,
    freq: freqSelect.value,
    size: sizeSelect.value,
    logLevel: logSelect.value,
    baud: Number(baudInput.value),
    rollback: rollbackInput.checked,
    sha256: shaInput.checked,
    resetGpio: Number(gpioInput.value),
    partition: partitionInput.value.trim(),
    secureBoot: secureInput.checked,
    verifyKey: verifyInput.value.trim(),
    encryption: encryptionSelect.value as BootOptions["encryption"],
  };
}

function onOptionChange(event: Event): void {
  if (event.target === chipSelect) fillFreqs(freqSelect.value);
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

function browserHost(): BuildHost {
  if (!crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the compiler cannot start. Open it over HTTP and let the page reload once.");
  }
  wasmer ??= new Wasmer({ outputBytes: 8_000_000 });
  return {
    client: wasmer,
    async loadSources(chip) {
      const response = await fetch(`${base}boot-sources/${encodeURIComponent(chip)}.bin`);
      if (!response.ok) throw new Error(`No packed sources for ${chip} (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async loadCompiler() {
      const [clang, lld] = await Promise.all([
        fetchBytes(`${base}toolchain/bin/clang`),
        fetchBytes(`${base}toolchain/bin/lld`),
      ]);
      return { clang, lld };
    },
  };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}). Run npm run fetch-compiler first.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  let reported = -1;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.length;
    const percent = length > 0 ? Math.floor((received / length) * 100) : received;
    if (percent >= reported + 10) {
      reported = percent;
      append(length > 0 ? `${url} ${percent}%` : `${url} ${received} bytes`);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

buildButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  buildButton.disabled = true;
  try {
    const opts = options();
    const chip = chipById(opts.chip);
    const built = await compileIdfBootloader(opts, browserHost(), append);
    image = built;
    imageName = `${chip.id}-bootloader.bin`;
    downloadButton.disabled = false;
    append(`Image ${built.length} bytes, flash at 0x${chip.flashOffset.toString(16)}.`);
    const slot = Number(opts.partition) - chip.flashOffset;
    if (built.length > slot) {
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
  if (!image) return;
  const bytes = new ArrayBuffer(image.byteLength);
  new Uint8Array(bytes).set(image);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = imageName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

byId("clear").addEventListener("click", () => {
  logEl.textContent = "";
});
