// One pairing between two devices. Owns the connection and the current
// transfer, and exposes a plain snapshot for the UI to render.

import { Link, type LinkStatus, type PathKind, type Role } from "./link";
import type { ControlMessage, FileEntry } from "./protocol";
import { Receiver } from "./receiver";
import { Sender, type PickedFile } from "./sender";
import { DownloadSink, FolderSink, supportsFolderSink, type SavedFile } from "./sinks";
import { randomId } from "./util";

export type TransferPhase = "none" | "offered" | "transferring" | "done" | "declined" | "error";

export interface SessionState {
  role: Role;
  code: string;
  link: LinkStatus;
  path: PathKind | null;
  /** Unrecoverable pairing problem (wrong code, room full). */
  fatal: string | null;
  picked: { count: number; bytes: number; list: PickedFile[] };
  phase: TransferPhase;
  files: FileEntry[];
  totalBytes: number;
  doneBytes: number;
  filesDone: number;
  currentPath: string;
  speed: number;
  eta: number;
  error: string;
  /** Receiver only: finished files waiting to be saved (download mode). */
  saved: SavedFile[];
  /** Receiver only: files are being held in memory, so size is limited. */
  inMemory: boolean;
}

const SIGNALING_URL: string =
  import.meta.env.VITE_SIGNALING_URL ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787`;

const SAMPLE_MS = 500;
const SPEED_WINDOW = 6; // samples → 3 s average

export class Session {
  readonly link: Link;
  private state: SessionState;
  private listeners = new Set<() => void>();
  private dc: RTCDataChannel | null = null;
  private maxChunk = 0;
  private picked: PickedFile[] = [];
  private sender: Sender | null = null;
  private receiver: Receiver | null = null;
  private samples: Array<{ at: number; bytes: number }> = [];
  private ticker: ReturnType<typeof setInterval> | undefined;
  private ticks = 0;
  private wakeLock: WakeLockSentinel | null = null;

  constructor(role: Role, code: string) {
    this.state = {
      role,
      code,
      link: "server",
      path: null,
      fatal: null,
      picked: { count: 0, bytes: 0, list: [] },
      phase: "none",
      files: [],
      totalBytes: 0,
      doneBytes: 0,
      filesDone: 0,
      currentPath: "",
      speed: 0,
      eta: Infinity,
      error: "",
      saved: [],
      inMemory: false,
    };
    this.link = new Link(SIGNALING_URL, code, role, randomId(), {
      onStatus: (link) => this.patch({ link }),
      onOpen: (dc, maxChunk) => this.channelOpened(dc, maxChunk),
      onClose: () => this.channelClosed(),
      onFatal: (reason) => this.patch({ fatal: reason }),
    });
    this.link.start();
    this.ticker = setInterval(() => this.tick(), SAMPLE_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  // ---- store interface -----------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.state;

  close(): void {
    this.sender?.cancel("The other device left.");
    this.receiver?.cancel();
    clearInterval(this.ticker);
    document.removeEventListener("visibilitychange", this.onVisibility);
    void this.wakeLock?.release().catch(() => {});
    for (const file of this.state.saved) URL.revokeObjectURL(file.url);
    // Give the cancel message a moment to leave before tearing down.
    setTimeout(() => this.link.stop(), 100);
  }

  // ---- sender actions ------------------------------------------------------

  addFiles(files: PickedFile[]): void {
    const seen = new Set(this.picked.map((p) => p.path));
    for (const f of files) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        this.picked.push(f);
      }
    }
    this.refreshPicked();
  }

  removeFile(path: string): void {
    this.picked = this.picked.filter((p) => p.path !== path);
    this.refreshPicked();
  }

  clearFiles(): void {
    this.picked = [];
    this.refreshPicked();
  }

  /** Offer the picked files to the other device. */
  send(): void {
    if (!this.dc || this.picked.length === 0 || this.sender?.active) return;
    this.receiver = null;
    this.sender = new Sender(this.picked, () => this.sync());
    this.picked = [];
    this.refreshPicked();
    this.samples = [];
    this.sender.attach(this.dc, this.maxChunk);
    this.sync();
  }

  // ---- receiver actions ----------------------------------------------------

  /** Must be called from a click: picking a folder needs a user gesture. */
  async accept(): Promise<void> {
    const receiver = this.receiver;
    if (!receiver || receiver.phase !== "offered") return;
    try {
      let sink;
      if (supportsFolderSink()) {
        try {
          sink = await FolderSink.pick();
        } catch (err) {
          if ((err as DOMException).name === "AbortError") return; // user closed the picker
          throw err;
        }
      } else {
        sink = new DownloadSink((file) => this.patch({ saved: [...this.state.saved, file] }));
      }
      await receiver.accept(sink);
      if (sink instanceof DownloadSink) this.patch({ inMemory: sink.inMemory });
      this.samples = [];
    } catch (err) {
      this.patch({ error: `Could not start receiving: ${err instanceof Error ? err.message : err}` });
    }
  }

  decline(): void {
    this.receiver?.decline();
  }

  // ---- shared actions ------------------------------------------------------

  cancel(): void {
    this.sender?.cancel("Transfer cancelled.");
    this.receiver?.cancel();
  }

  /** Clear a finished/failed transfer so another can start. */
  reset(): void {
    if (this.sender?.active || this.receiver?.active) return;
    this.sender = null;
    this.receiver = null;
    this.sync();
  }

  // ---- connection events ---------------------------------------------------

  private channelOpened(dc: RTCDataChannel, maxChunk: number): void {
    this.dc = dc;
    this.maxChunk = maxChunk;
    dc.onmessage = (event) => this.onMessage(event.data);
    this.sender?.attach(dc, maxChunk);
    this.receiver?.attach(dc);
    this.samples = [];
    void this.link.pathKind().then((path) => this.patch({ path }));
  }

  private channelClosed(): void {
    this.dc = null;
    this.sender?.detach();
    this.receiver?.detach();
    this.samples = [];
    this.patch({ path: null, speed: 0, eta: Infinity });
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      this.receiver?.onBinary(data);
      return;
    }
    let message: ControlMessage;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.t === "manifest") {
      this.onManifest(message);
    } else if (this.sender) {
      this.sender.handle(message);
    } else {
      this.receiver?.onControl(message);
    }
  }

  private onManifest(message: Extract<ControlMessage, { t: "manifest" }>): void {
    if (this.receiver?.transferId === message.transferId) return; // re-announced after a reconnect
    if (this.sender?.active || this.receiver?.phase === "receiving") {
      this.dc?.send(JSON.stringify({ t: "decline", transferId: message.transferId } satisfies ControlMessage));
      return;
    }
    if (!validManifest(message.files)) return;
    for (const file of this.state.saved) URL.revokeObjectURL(file.url);
    this.sender = null;
    this.receiver = new Receiver(message.transferId, message.files, () => this.sync());
    this.receiver.attach(this.dc!);
    this.patch({ saved: [], inMemory: false, error: "" });
    this.sync();
  }

  // ---- state ---------------------------------------------------------------

  private refreshPicked(): void {
    this.patch({
      picked: {
        count: this.picked.length,
        bytes: this.picked.reduce((sum, p) => sum + p.file.size, 0),
        list: [...this.picked],
      },
    });
  }

  /** Copy the live transfer's progress into the snapshot. */
  private sync(): void {
    const s = this.sender;
    const r = this.receiver;
    if (s) {
      this.patch({
        phase: s.phase === "sending" ? "transferring" : s.phase,
        files: s.entries,
        totalBytes: s.totalBytes,
        doneBytes: s.confirmedBytes,
        filesDone: s.filesDone,
        currentPath: s.currentPath,
        error: s.error,
      });
    } else if (r) {
      this.patch({
        phase: r.phase === "receiving" ? "transferring" : r.phase,
        files: r.entries,
        totalBytes: r.totalBytes,
        doneBytes: r.receivedBytes,
        filesDone: r.filesDone,
        currentPath: r.currentPath,
        error: r.error,
      });
    } else {
      this.patch({ phase: "none", files: [], totalBytes: 0, doneBytes: 0, filesDone: 0, currentPath: "", error: "" });
    }
    void this.updateWakeLock();
  }

  private tick(): void {
    if (!this.dc) return;
    // The browser may switch to a better route shortly after connecting, so
    // the route label is re-read every couple of seconds.
    if (this.ticks++ % 4 === 0) {
      void this.link.pathKind().then((path) => {
        if (path && path !== this.state.path) this.patch({ path });
      });
    }
    if (this.state.phase !== "transferring") return;
    const now = performance.now();
    this.samples.push({ at: now, bytes: this.state.doneBytes });
    if (this.samples.length > SPEED_WINDOW + 1) this.samples.shift();
    const first = this.samples[0];
    const seconds = (now - first.at) / 1000;
    const speed = seconds > 0 ? Math.max(0, (this.state.doneBytes - first.bytes) / seconds) : 0;
    const remaining = this.state.totalBytes - this.state.doneBytes;
    this.patch({ speed, eta: speed > 0 ? remaining / speed : Infinity });
  }

  private patch(change: Partial<SessionState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  // ---- keep the screen awake while transferring ------------------------------

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") void this.updateWakeLock();
  };

  private async updateWakeLock(): Promise<void> {
    const want = this.state.phase === "transferring";
    try {
      if (want && (!this.wakeLock || this.wakeLock.released) && "wakeLock" in navigator) {
        this.wakeLock = await navigator.wakeLock.request("screen");
      } else if (!want && this.wakeLock) {
        const lock = this.wakeLock;
        this.wakeLock = null;
        await lock.release();
      }
    } catch {
      // Not supported or not allowed right now; the transfer still works.
    }
  }
}

function validManifest(files: unknown): files is FileEntry[] {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(
      (f, i) =>
        f && f.id === i && typeof f.path === "string" && Number.isSafeInteger(f.size) && f.size >= 0,
    )
  );
}
