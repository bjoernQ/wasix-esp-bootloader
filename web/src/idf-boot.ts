import type { BootOptions } from "./wasix";

export async function buildIdfBootloader(options: BootOptions, log: (line: string) => void): Promise<Uint8Array> {
  log(`Building the ESP-IDF bootloader for ${options.chip}…`);
  const response = await fetch("/api/bootloader", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    throw new Error((await response.text()) || `build failed (${response.status})`);
  }
  if (!response.body) throw new Error("build returned no output");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let imageUrl = "";
  let failed = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) note(line);
  }
  if (pending) note(pending);
  if (failed || !imageUrl) throw new Error("ESP-IDF build did not produce a bootloader image");
  const binResponse = await fetch(imageUrl);
  if (!binResponse.ok) throw new Error(`could not read the bootloader image (${binResponse.status})`);
  const bin = new Uint8Array(await binResponse.arrayBuffer());
  if (bin[0] !== 0xe9 || bin.length < 8000) {
    throw new Error(`image is ${bin.length} bytes, which is not the ESP-IDF bootloader`);
  }
  return bin;

  function note(line: string): void {
    if (line.startsWith("IMAGE ")) imageUrl = line.slice("IMAGE ".length).trim();
    else if (line.startsWith("build failed")) failed = true;
    if (line) log(line);
  }
}
