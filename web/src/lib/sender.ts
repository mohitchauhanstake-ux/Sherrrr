// Sending side of one transfer. Reads files in small blocks and never holds
// more than a few megabytes in memory, however large the files are.

import {
  ACK_WINDOW,
  BUFFER_HIGH,
  BUFFER_LOW,
  READ_BLOCK,
  SAFE_CHUNK,
  type ControlMessage,
  type FileEntry,
} from "./protocol";
import { randomId } from "./util";

export type SendPhase = "offered" | "sending" | "done" | "declined" | "error";

export interface PickedFile {
  file: File;
  path: string;
}

export class Sender {
  readonly transferId = randomId();
  readonly entries: FileEntry[];
  readonly totalBytes: number;
  phase: SendPhase = "offered";
  error = "";
  currentPath = "";
  filesDone = 0;

  private readonly files: File[];
  private dc: RTCDataChannel | null = null;
  private maxChunk = SAFE_CHUNK;
  /** Bumped whenever the current send loop must stop (drop, cancel, restart). */
  private run = 0;
  private waiters: Array<() => void> = [];
  /** Bytes the receiver already had when the current send loop started. */
  private base = 0;
  private sent = 0;
  private acked = 0;

  constructor(picked: PickedFile[], private readonly onChange: () => void) {
    this.files = picked.map((p) => p.file);
    this.entries = picked.map((p, id) => ({
      id,
      path: p.path,
      size: p.file.size,
      lastModified: p.file.lastModified,
    }));
    this.totalBytes = this.entries.reduce((sum, e) => sum + e.size, 0);
  }

  get active(): boolean {
    return this.phase === "offered" || this.phase === "sending";
  }

  /** Bytes the receiver has confirmed writing to disk. */
  get confirmedBytes(): number {
    if (this.phase === "done") return this.totalBytes;
    return Math.min(this.totalBytes, this.base + this.acked);
  }

  attach(dc: RTCDataChannel, maxChunk: number): void {
    this.dc = dc;
    this.maxChunk = maxChunk;
    this.run++;
    this.wake();
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.addEventListener("bufferedamountlow", () => this.wake());
    // Re-announcing on every (re)connect is what triggers the receiver to
    // tell us where to resume from.
    if (this.active) this.send({ t: "manifest", transferId: this.transferId, files: this.entries });
  }

  detach(): void {
    this.dc = null;
    this.run++;
    this.wake();
  }

  cancel(reason: string, notify = true): void {
    if (!this.active) return;
    if (notify) this.send({ t: "cancel", reason });
    this.phase = "error";
    this.error = reason;
    this.run++;
    this.wake();
    this.onChange();
  }

  handle(message: ControlMessage): void {
    switch (message.t) {
      case "accept":
        if (message.transferId === this.transferId && this.active) void this.pump(message);
        break;
      case "decline":
        if (message.transferId === this.transferId && this.phase === "offered") {
          this.phase = "declined";
          this.onChange();
        }
        break;
      case "ack":
        this.acked = message.bytes;
        this.wake();
        this.onChange();
        break;
      case "complete":
        if (this.phase === "sending") {
          this.phase = "done";
          this.filesDone = this.entries.length;
          this.onChange();
        }
        break;
      case "cancel":
        this.cancel(message.reason, false);
        break;
    }
  }

  private async pump(accept: Extract<ControlMessage, { t: "accept" }>): Promise<void> {
    const run = ++this.run;
    this.wake();
    const dc = this.dc;
    if (!dc) return;
    const live = () => run === this.run && dc.readyState === "open";

    const done = new Set(accept.done);
    const partial = accept.partial;
    this.base =
      this.entries.reduce((sum, e) => sum + (done.has(e.id) ? e.size : 0), 0) + (partial?.offset ?? 0);
    this.sent = 0;
    this.acked = 0;
    this.filesDone = done.size;
    this.phase = "sending";
    this.onChange();

    try {
      for (const entry of this.entries) {
        if (done.has(entry.id)) continue;
        const file = this.files[entry.id];
        let offset = partial?.id === entry.id ? Math.min(partial.offset, entry.size) : 0;
        this.currentPath = entry.path;
        dc.send(JSON.stringify({ t: "file", id: entry.id, offset } satisfies ControlMessage));

        while (offset < entry.size) {
          const block = await file.slice(offset, offset + READ_BLOCK).arrayBuffer();
          if (block.byteLength === 0) throw new Error(`Could not read "${entry.path}".`);
          for (let i = 0; i < block.byteLength; i += this.maxChunk) {
            // Two brakes: the browser's own send buffer, and how far ahead of
            // the receiver's disk we are allowed to get.
            while (live() && (dc.bufferedAmount > BUFFER_HIGH || this.sent - this.acked > ACK_WINDOW)) {
              await this.wait();
            }
            if (!live()) return;
            const length = Math.min(this.maxChunk, block.byteLength - i);
            dc.send(new Uint8Array(block, i, length));
            this.sent += length;
          }
          offset += block.byteLength;
        }
        if (!live()) return;
        dc.send(JSON.stringify({ t: "file-end", id: entry.id } satisfies ControlMessage));
        this.filesDone++;
        this.onChange();
      }
      dc.send(JSON.stringify({ t: "done" } satisfies ControlMessage));
    } catch (err) {
      // If the channel dropped mid-send, the reconnect will resume; only a
      // genuine local failure (e.g. unreadable file) ends the transfer.
      if (!live()) return;
      const detail = err instanceof Error ? err.message : String(err);
      this.cancel(`Sending "${this.currentPath}" failed: ${detail}`);
    }
  }

  private send(message: ControlMessage): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(message));
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      setTimeout(resolve, 1000); // safety net against a missed event
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
