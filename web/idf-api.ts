import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const chips = new Set([
  "esp32", "esp32c2", "esp32c3", "esp32c5", "esp32c6", "esp32c61",
  "esp32h2", "esp32h21", "esp32h4", "esp32p4", "esp32s2", "esp32s3", "esp32s31",
]);
const modes = new Set(["qio", "qout", "dio", "dout"]);
const freqs = new Set(["80m", "40m", "26m", "20m"]);
const sizes = new Set(["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"]);
const logs = new Set(["none", "error", "warn", "info", "debug", "verbose"]);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "toolchain", "build-real-bootloader.py");

let running = false;

function imagePath(chip: string): string {
  return `\\\\wsl$\\Ubuntu\\opt\\idf-targets\\${chip}\\build\\bootloader\\bootloader.bin`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(message);
}

async function handle(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/bootloader-image" && req.method === "GET") {
    const chip = url.searchParams.get("chip") ?? "";
    const file = imagePath(chip);
    if (!chips.has(chip) || !existsSync(file)) {
      send(res, 404, "bootloader image is not built");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/octet-stream");
    createReadStream(file).pipe(res);
    return;
  }
  if (url.pathname !== "/api/bootloader" || req.method !== "POST") {
    next();
    return;
  }
  if (running) {
    send(res, 409, "a bootloader build is already running");
    return;
  }
  let options: Record<string, unknown>;
  try {
    options = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    send(res, 400, "options must be JSON");
    return;
  }
  const chip = String(options.chip ?? "");
  const mode = String(options.mode ?? "");
  const freq = String(options.freq ?? "");
  const size = String(options.size ?? "");
  const logLevel = String(options.logLevel ?? "");
  const baud = Number(options.baud);
  const resetGpio = Number(options.resetGpio);
  const partition = String(options.partition ?? "");
  if (!chips.has(chip) || !modes.has(mode) || !freqs.has(freq) || !sizes.has(size) || !logs.has(logLevel)) {
    send(res, 400, "unknown chip or flash option");
    return;
  }
  if (!Number.isInteger(baud) || baud < 1 || !Number.isInteger(resetGpio) || !/^(0x[0-9a-fA-F]+|\d+)$/.test(partition)) {
    send(res, 400, "baud, reset gpio, or partition offset is invalid");
    return;
  }
  running = true;
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  const child = spawn("wsl", [
    "-d", "Ubuntu", "-u", "root", "--",
    "python3", "-u", script.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`),
    "--chip", chip,
    "--mode", mode,
    "--freq", freq,
    "--size", size,
    "--log", logLevel,
    "--baud", String(baud),
    "--rollback", options.rollback ? "1" : "0",
    "--sha256", options.sha256 ? "1" : "0",
    "--reset-gpio", String(resetGpio),
    "--partition", partition,
  ], { windowsHide: true });
  child.stdout.on("data", (chunk: Buffer) => res.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => res.write(chunk));
  child.on("error", (error) => {
    res.write(`\nERROR ${error.message}\n`);
  });
  child.on("close", (code) => {
    running = false;
    if (code !== 0) res.write(`\nbuild failed (${code})\n`);
    res.end();
  });
}

export function idfBootloaderApi(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    void handle(req, res, next).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, error instanceof Error ? error.message : String(error));
      else res.end();
    });
  };
  return {
    name: "idf-bootloader-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
