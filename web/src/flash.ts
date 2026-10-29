type WebSerialPort = {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  getInfo(): { usbVendorId?: number };
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
};

function webSerial(): { requestPort(): Promise<WebSerialPort> } | undefined {
  return (navigator as Navigator & { serial?: { requestPort(): Promise<WebSerialPort> } }).serial;
}

const BLOCK = 0x400;
const SECTOR = 4096;
const SYNC = 0x08;
const FLASH_BEGIN = 0x02;
const FLASH_DATA = 0x03;
const FLASH_END = 0x04;
const SPI_ATTACH = 0x0d;
const DOWNLOAD_BAUD = 115200;

export type ResetKind = "classic" | "usb-jtag";

export class Board {
  private port: WebSerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private incoming: Uint8Array[] = [];
  private notify: (() => void) | null = null;
  private mode: "binary" | "text" = "text";
  private decoder = new TextDecoder();
  private pumping = false;
  private baud = DOWNLOAD_BAUD;
  private resetKind: ResetKind = "classic";
  onText: (text: string) => void = () => {};

  get connected(): boolean {
    return this.port !== null;
  }

  async connect(baudRate = DOWNLOAD_BAUD): Promise<string> {
    const serial = webSerial();
    if (!serial) {
      throw new Error("Web Serial is not available. Use Chrome or Edge on https or localhost.");
    }
    if (this.port) return "serial already open";
    this.port = await serial.requestPort();
    this.baud = baudRate;
    await this.port.open({ baudRate, bufferSize: 8192 });
    this.writer = this.port.writable.getWriter();
    await this.signals(false, false);
    this.mode = "text";
    this.attachReader();
    const info = this.port.getInfo();
    const vendor = info.usbVendorId == null ? "" : ` vendor 0x${info.usbVendorId.toString(16)}`;
    return `serial open at ${baudRate}${vendor}`;
  }

  async disconnect(): Promise<void> {
    this.mode = "binary";
    await this.reader?.cancel().catch(() => undefined);
    this.reader?.releaseLock();
    this.reader = null;
    this.writer?.releaseLock();
    this.writer = null;
    await this.port?.close().catch(() => undefined);
    this.port = null;
    this.incoming = [];
  }

  async monitor(baudRate: number, log: (line: string) => void): Promise<void> {
    if (!this.port) throw new Error("Connect a board before monitoring.");
    await this.useBaud(baudRate);
    this.mode = "text";
    this.incoming = [];
    log(`Resetting into the application at ${baudRate} baud…`);
    await this.runApplication();
    this.attachReader();
    log("Monitoring UART.");
  }

  private attachReader(): void {
    if (!this.port || this.reader) return;
    this.reader = this.port.readable.getReader();
    void this.pump();
  }

  private async useBaud(baudRate: number): Promise<void> {
    if (!this.port) throw new Error("serial port is not open");
    if (this.baud === baudRate && this.writer) return;
    await this.reader?.cancel().catch(() => undefined);
    this.reader?.releaseLock();
    this.reader = null;
    this.writer?.releaseLock();
    this.writer = null;
    await this.port.close();
    await this.port.open({ baudRate, bufferSize: 8192 });
    this.writer = this.port.writable.getWriter();
    this.baud = baudRate;
    await this.signals(false, false);
    this.attachReader();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.reader) {
        let value: Uint8Array | undefined;
        let done = false;
        try {
          const next = await this.reader.read();
          value = next.value;
          done = next.done;
        } catch {
          this.reader?.releaseLock();
          this.reader = null;
          break;
        }
        if (done) {
          this.reader?.releaseLock();
          this.reader = null;
          break;
        }
        if (!value?.length) continue;
        if (this.mode === "text") this.onText(this.decoder.decode(value, { stream: true }));
        else {
          this.incoming.push(value);
          this.notify?.();
          this.notify = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("serial port is not open");
    await this.writer.write(bytes);
  }

  private async signals(dataTerminalReady: boolean, requestToSend: boolean): Promise<void> {
    await this.port?.setSignals({ dataTerminalReady, requestToSend });
  }

  private async classicReset(delay: number): Promise<void> {
    await this.signals(false, true);
    await sleep(100);
    await this.signals(true, false);
    await sleep(delay);
    await this.signals(false, false);
  }

  private async usbJtagReset(): Promise<void> {
    await this.signals(false, false);
    await sleep(100);
    await this.signals(true, false);
    await sleep(100);
    await this.signals(false, true);
    await sleep(100);
    await this.signals(false, false);
  }

  private async runApplication(): Promise<void> {
    await this.signals(false, true);
    await sleep(120);
    await this.signals(false, false);
    this.attachReader();
  }

  private async nextByte(deadline: number): Promise<number> {
    for (;;) {
      const head = this.incoming[0];
      if (head && head.length) {
        const byte = head[0];
        this.incoming[0] = head.subarray(1);
        if (this.incoming[0].length === 0) this.incoming.shift();
        return byte;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for the chip");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.notify = null;
          resolve();
        }, Math.min(left, 40));
        this.notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private async readSlip(timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    const out: number[] = [];
    let started = false;
    let escape = false;
    for (;;) {
      const byte = await this.nextByte(deadline);
      if (!started) {
        if (byte === 0xc0) started = true;
        continue;
      }
      if (escape) {
        out.push(byte === 0xdc ? 0xc0 : byte === 0xdd ? 0xdb : byte);
        escape = false;
        continue;
      }
      if (byte === 0xdb) {
        escape = true;
        continue;
      }
      if (byte === 0xc0) {
        if (out.length === 0) continue;
        return Uint8Array.from(out);
      }
      out.push(byte);
    }
  }

  private async command(op: number, data: Uint8Array, timeoutMs: number, chk = 0): Promise<{ value: number; data: Uint8Array }> {
    this.attachReader();
    const packet = new Uint8Array(8 + data.length);
    const view = new DataView(packet.buffer);
    view.setUint8(1, op);
    view.setUint16(2, data.length, true);
    view.setUint32(4, chk >>> 0, true);
    packet.set(data, 8);
    await this.write(slip(packet));
    const response = await this.readSlip(timeoutMs);
    if (response.length < 8) throw new Error("short ROM packet");
    const header = new DataView(response.buffer, response.byteOffset, response.byteLength);
    if (header.getUint8(0) !== 1 || header.getUint8(1) !== op) {
      const seen = [...response.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
      throw new Error(`ROM replied ${seen}, expected command 0x${op.toString(16)}`);
    }
    const size = header.getUint16(2, true);
    return { value: header.getUint32(4, true), data: response.subarray(8, 8 + size) };
  }

  async flash(image: Uint8Array, offset: number, chip: string, consoleBaud: number, log: (line: string) => void): Promise<void> {
    if (!this.port) throw new Error("Connect a board before flashing.");
    await this.useBaud(DOWNLOAD_BAUD);
    this.mode = "binary";
    this.incoming = [];
    await this.enterDownload(log);
    log("Attaching SPI flash…");
    try {
      checkStatus((await this.command(SPI_ATTACH, u32(0, 0), 2000)).data, "SPI attach");
    } catch (error) {
      log(`SPI attach: ${error instanceof Error ? error.message : String(error)}`);
    }
    const blocks = Math.ceil(image.length / BLOCK);
    const eraseSize = Math.ceil(image.length / SECTOR) * SECTOR;
    const begin = await this.flashBegin(chip, eraseSize, blocks, offset, log);
    for (let index = 0; index < blocks; index++) {
      const slice = image.subarray(index * BLOCK, Math.min(image.length, (index + 1) * BLOCK));
      const padded = new Uint8Array(BLOCK);
      padded.fill(0xff);
      padded.set(slice);
      const body = new Uint8Array(16 + BLOCK);
      const bodyView = new DataView(body.buffer);
      bodyView.setUint32(0, padded.length, true);
      bodyView.setUint32(4, index, true);
      body.set(padded, 16);
      let written = false;
      let last = "no response";
      for (let attempt = 0; attempt < 3 && !written; attempt++) {
        try {
          checkStatus((await this.command(FLASH_DATA, body, 5000, checksum(padded))).data, `block ${index}`);
          written = true;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
          this.incoming = [];
        }
      }
      if (!written) throw new Error(last);
      log(`Wrote block ${index + 1}/${blocks}`);
    }
    log("Leaving download mode…");
    try {
      checkStatus((await this.command(FLASH_END, u32(0), 1000)).data, "flash end");
    } catch (error) {
      log(`flash end: ${error instanceof Error ? error.message : String(error)}`);
    }
    const listenAt = consoleBaud > 0 ? consoleBaud : DOWNLOAD_BAUD;
    if (listenAt !== DOWNLOAD_BAUD) {
      try {
        await this.useBaud(listenAt);
      } catch (error) {
        log(`Could not switch the monitor to ${listenAt}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.mode = "text";
    this.incoming = [];
    await this.runApplication();
    log(`Flashed ${image.length} bytes at 0x${offset.toString(16)} via ${this.resetKind} reset (${begin}). Monitoring UART at ${this.baud}.`);
  }

  private async flashBegin(chip: string, eraseSize: number, blocks: number, offset: number, log: (line: string) => void): Promise<string> {
    const layouts = chip === "esp32" ? [false, true] : [true, false];
    let last = "no response";
    for (const extra of layouts) {
      const words = [eraseSize, blocks, BLOCK, offset];
      if (extra) words.push(0);
      log(`Erasing ${eraseSize} bytes at 0x${offset.toString(16)}…`);
      try {
        checkStatus((await this.command(FLASH_BEGIN, u32(...words), 20000)).data, "flash begin");
        return extra ? "ROM flash header with encryption flag" : "ROM flash header";
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        log(`flash begin: ${last}`);
        this.incoming = [];
      }
    }
    throw new Error(last);
  }

  private async enterDownload(log: (line: string) => void): Promise<void> {
    const attempts: Array<{ kind: ResetKind; delay?: number }> = [
      { kind: "classic", delay: 50 },
      { kind: "classic", delay: 500 },
      { kind: "usb-jtag" },
    ];
    let last = "no response";
    for (const attempt of attempts) {
      const label = attempt.kind === "classic" ? `classic UART reset (${attempt.delay} ms)` : "USB-JTAG reset";
      log(`Reset into download mode: ${label}`);
      this.attachReader();
      try {
        if (attempt.kind === "classic") await this.classicReset(attempt.delay ?? 50);
        else await this.usbJtagReset();
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        log(last);
        continue;
      }
      await sleep(50);
      this.attachReader();
      this.incoming = [];
      try {
        await this.sync(log);
        this.resetKind = attempt.kind;
        return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`could not sync with the ROM bootloader (${last})`);
  }

  private async sync(log: (line: string) => void): Promise<void> {
    const payload = new Uint8Array(36);
    payload.set([0x07, 0x07, 0x12, 0x20]);
    payload.fill(0x55, 4);
    let last = "no response";
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const reply = await this.command(SYNC, payload, 400);
        for (let extra = 0; extra < 7; extra++) {
          try {
            await this.readSlip(80);
          } catch {
            break;
          }
        }
        log(reply.value === 0 ? "Sync ok (flasher stub)." : "ROM sync ok.");
        return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        log(`sync ${attempt}/5: ${last}`);
        this.incoming = [];
      }
    }
    throw new Error(last);
  }
}

function slip(packet: Uint8Array): Uint8Array {
  const out: number[] = [0xc0];
  for (const byte of packet) {
    if (byte === 0xdb) out.push(0xdb, 0xdd);
    else if (byte === 0xc0) out.push(0xdb, 0xdc);
    else out.push(byte);
  }
  out.push(0xc0);
  return Uint8Array.from(out);
}

function u32(...words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return bytes;
}

function checksum(data: Uint8Array): number {
  let state = 0xef;
  for (const byte of data) state ^= byte;
  return state;
}

function checkStatus(data: Uint8Array, what: string): void {
  const width = data.length >= 4 ? 4 : data.length >= 2 ? 2 : 0;
  if (width < 2) throw new Error(`${what}: status missing (${data.length} bytes)`);
  const status = data[data.length - width];
  const reason = data[data.length - width + 1];
  if (status !== 0) throw new Error(`${what} failed, status ${status} reason ${reason}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
