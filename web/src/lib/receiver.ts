// Receiving side of one transfer. Every incoming message is handled strictly
// in order through a queue, and bytes are acknowledged only after they are
// written, so the sender can never get more than ACK_WINDOW ahead of our disk.

import { WRITE_BATCH, type ControlMessage, type FileEntry } from "./protocol";
import type { FileWriter, Sink } from "./sinks";

export type ReceivePhase = "offered" | "receiving" | "done" | "declined" | "error";

interface OpenFile {
  entry: FileEntry;
  writer: FileWriter;
  /** Bytes of this file safely handed to the writer. */
  offset: number;
  pending: ArrayBuffer[];
  pendingBytes: number;
}

export class Receiver {
  readonly totalBytes: number;
  phase: ReceivePhase = "offered";
  error = "";
  currentPath = "";
  filesDone = 0;
  receivedBytes = 0;

  private sink: Sink | null = null;
  private readonly done = new Set<number>();
  private current: OpenFile | null = null;
  private dc: RTCDataChannel | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Bytes written since the last accept; mirrors the sender's counter. */
  private sessionBytes = 0;

  constructor(
    readonly transferId: string,
    readonly entries: FileEntry[],
    private readonly onChange: () => void,
  ) {
    this.totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  }

  get active(): boolean {
    return this.phase === "offered" || this.phase === "receiving";
  }

  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    // Queued behind anything still being written from the old connection, so
    // the resume point we report is exact.
    if (this.phase === "receiving") this.enqueue(() => this.sendAccept());
    else if (this.phase === "done") this.send({ t: "complete" });
  }

  detach(): void {
    this.dc = null;
  }

  /** User agreed; `sink` is where the files go. */
  async accept(sink: Sink): Promise<void> {
    const already = await sink.prepare(this.entries);
    this.sink = sink;
    for (const id of already) {
      this.done.add(id);
      this.receivedBytes += this.entries[id].size;
    }
    this.filesDone = this.done.size;
    this.phase = "receiving";
    this.onChange();
    this.enqueue(() => this.sendAccept());
  }

  decline(): void {
    if (this.phase !== "offered") return;
    this.send({ t: "decline", transferId: this.transferId });
    this.phase = "declined";
    this.onChange();
  }

  cancel(): void {
    if (this.phase === "offered") this.decline();
    else this.enqueue(() => this.fail("Transfer cancelled.", true));
  }

  onControl(message: ControlMessage): void {
    if (message.t === "cancel" && this.phase === "offered") {
      // Sender withdrew the offer before we answered.
      this.phase = "error";
      this.error = message.reason;
      this.onChange();
      return;
    }
    this.enqueue(() => this.handleControl(message));
  }

  onBinary(data: ArrayBuffer): void {
    this.enqueue(() => this.handleBinary(data));
  }

  // ---- queue workers -------------------------------------------------------

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.phase !== "receiving") return;
      try {
        await work();
      } catch (err) {
        await this.fail(describeError(err), true);
      }
    });
  }

  private async sendAccept(): Promise<void> {
    await this.flush();
    this.sessionBytes = 0;
    this.send({
      t: "accept",
      transferId: this.transferId,
      done: [...this.done],
      partial: this.current ? { id: this.current.entry.id, offset: this.current.offset } : undefined,
    });
  }

  private async handleControl(message: ControlMessage): Promise<void> {
    switch (message.t) {
      case "file": {
        const entry = this.entries[message.id];
        if (!entry || this.done.has(entry.id)) throw new Error("Sender announced an unexpected file.");
        this.currentPath = entry.path;
        if (this.current?.entry.id === entry.id && this.current.offset === message.offset) {
          return; // continuing the file we already have open
        }
        if (this.current) {
          this.receivedBytes -= this.current.offset;
          await this.current.writer.abort();
          this.current = null;
        }
        if (message.offset !== 0) throw new Error("Sender resumed from a position we do not have.");
        const writer = await this.sink!.open(entry);
        this.current = { entry, writer, offset: 0, pending: [], pendingBytes: 0 };
        this.onChange();
        return;
      }
      case "file-end": {
        const file = this.current;
        if (!file || file.entry.id !== message.id) throw new Error("Sender finished an unexpected file.");
        await this.flush();
        if (file.offset !== file.entry.size) {
          throw new Error(`"${file.entry.path}" arrived incomplete (${file.offset} of ${file.entry.size} bytes).`);
        }
        await file.writer.close();
        this.current = null;
        this.done.add(file.entry.id);
        this.filesDone = this.done.size;
        this.onChange();
        return;
      }
      case "done": {
        if (this.done.size !== this.entries.length) throw new Error("Sender finished before all files arrived.");
        this.phase = "done";
        this.send({ t: "complete" });
        this.onChange();
        return;
      }
      case "cancel":
        await this.fail(message.reason, false);
        return;
    }
  }

  private async handleBinary(data: ArrayBuffer): Promise<void> {
    const file = this.current;
    if (!file) return;
    if (file.offset + file.pendingBytes + data.byteLength > file.entry.size) {
      throw new Error(`"${file.entry.path}" received more data than expected.`);
    }
    file.pending.push(data);
    file.pendingBytes += data.byteLength;
    if (file.pendingBytes >= WRITE_BATCH) await this.flush();
  }

  /** Write buffered bytes to the sink, then acknowledge them. */
  private async flush(): Promise<void> {
    const file = this.current;
    if (!file || file.pendingBytes === 0) return;
    const blob = new Blob(file.pending);
    const bytes = file.pendingBytes;
    file.pending = [];
    file.pendingBytes = 0;
    await file.writer.write(blob);
    file.offset += bytes;
    this.receivedBytes += bytes;
    this.sessionBytes += bytes;
    this.send({ t: "ack", bytes: this.sessionBytes });
    this.onChange();
  }

  private async fail(reason: string, notify: boolean): Promise<void> {
    if (notify) this.send({ t: "cancel", reason });
    this.phase = "error";
    this.error = reason;
    const file = this.current;
    this.current = null;
    if (file) await file.writer.abort().catch(() => {});
    this.onChange();
  }

  private send(message: ControlMessage): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(message));
  }
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === "QuotaExceededError") {
    return "The receiving device ran out of storage space.";
  }
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return "The browser lost permission to write to the chosen folder.";
  }
  return err instanceof Error ? err.message : String(err);
}
