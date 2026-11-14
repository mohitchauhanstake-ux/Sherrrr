// Where received bytes go. Two strategies:
//
//  FolderSink    – writes straight into a folder the user picks (Chromium
//                  browsers). Nothing is held in memory and files land in
//                  their final place.
//  DownloadSink  – for browsers without folder access. Writes into the
//                  browser's private storage, then offers each finished file
//                  as a download. Falls back to memory if even that is missing.

import type { FileEntry } from "./protocol";

export interface FileWriter {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  /** Discard everything written so far. */
  abort(): Promise<void>;
}

export interface SavedFile {
  name: string;
  size: number;
  url: string;
}

export interface Sink {
  readonly kind: "folder" | "downloads";
  /** Inspect the destination; returns ids of files that are already complete there. */
  prepare(files: FileEntry[]): Promise<number[]>;
  open(entry: FileEntry): Promise<FileWriter>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
  }
}

/** Adding ?downloads to the URL forces download mode (used by the automated test). */
export function supportsFolderSink(): boolean {
  if (new URLSearchParams(location.search).has("downloads")) return false;
  return typeof window.showDirectoryPicker === "function";
}

// ---- path handling ---------------------------------------------------------

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function safeSegment(segment: string): string {
  // eslint-disable-next-line no-control-regex
  let s = segment.replace(/[<>:"|?*\\\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (!s) s = "_";
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Turns an untrusted relative path into safe folder names + a file name. */
export function safePath(path: string): { folders: string[]; name: string } {
  const parts = path
    .split("/")
    .filter((p) => p !== "" && p !== "." && p !== "..")
    .map(safeSegment);
  const name = parts.pop() ?? "file";
  return { folders: parts, name };
}

function withSuffix(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// ---- folder sink -----------------------------------------------------------

export class FolderSink implements Sink {
  readonly kind = "folder" as const;
  private readonly folders = new Map<string, Promise<FileSystemDirectoryHandle>>();
  private readonly targets = new Map<number, { dir: FileSystemDirectoryHandle; name: string }>();

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async pick(): Promise<FolderSink> {
    const root = await window.showDirectoryPicker!({ mode: "readwrite", id: "sher-receive" });
    return new FolderSink(root);
  }

  async prepare(files: FileEntry[]): Promise<number[]> {
    // A file only appears at full size once it has been completely written and
    // closed (the browser writes to a temporary file until then), so
    // "same name, same size" reliably means "already received".
    const done: number[] = [];
    for (const entry of files) {
      const { folders, name } = safePath(entry.path);
      const dir = await this.folder(folders);
      for (let n = 0; ; n++) {
        const candidate = withSuffix(name, n);
        let existingSize: number;
        try {
          existingSize = (await (await dir.getFileHandle(candidate)).getFile()).size;
        } catch (err) {
          if ((err as DOMException).name !== "NotFoundError") throw err;
          this.targets.set(entry.id, { dir, name: candidate });
          break;
        }
        if (existingSize === entry.size) {
          done.push(entry.id);
          break;
        }
        if (existingSize === 0) {
          // Empty placeholder left by an interrupted transfer: reuse it.
          this.targets.set(entry.id, { dir, name: candidate });
          break;
        }
        // A different file already has this name; try "name (1)", "name (2)"…
      }
    }
    return done;
  }

  async open(entry: FileEntry): Promise<FileWriter> {
    const target = this.targets.get(entry.id);
    if (!target) throw new Error(`No destination planned for ${entry.path}`);
    const handle = await target.dir.getFileHandle(target.name, { create: true });
    const stream = await handle.createWritable();
    return {
      write: (data) => stream.write(data),
      close: () => stream.close(),
      abort: async () => {
        await stream.abort().catch(() => {});
        await target.dir.removeEntry(target.name).catch(() => {});
      },
    };
  }

  private folder(segments: string[]): Promise<FileSystemDirectoryHandle> {
    const key = segments.join("/");
    let cached = this.folders.get(key);
    if (!cached) {
      cached =
        segments.length === 0
          ? Promise.resolve(this.root)
          : this.folder(segments.slice(0, -1)).then((parent) =>
              parent.getDirectoryHandle(segments[segments.length - 1], { create: true }),
            );
      this.folders.set(key, cached);
    }
    return cached;
  }
}

// ---- download sink ---------------------------------------------------------

const SCRATCH_DIR = "sher-incoming";
let scratchCleared = false;
let scratchCounter = 0;

export class DownloadSink implements Sink {
  readonly kind = "downloads" as const;
  private scratch: FileSystemDirectoryHandle | null = null;

  constructor(private readonly onSaved: (file: SavedFile) => void) {}

  /** True when files will be held in memory (no private storage available). */
  get inMemory(): boolean {
    return this.scratch === null;
  }

  async prepare(): Promise<number[]> {
    try {
      const canStream = typeof FileSystemFileHandle.prototype.createWritable === "function";
      if (canStream) {
        const root = await navigator.storage.getDirectory();
        if (!scratchCleared) {
          // Leftovers from earlier visits would otherwise eat storage quota.
          await root.removeEntry(SCRATCH_DIR, { recursive: true }).catch(() => {});
          scratchCleared = true;
        }
        this.scratch = await root.getDirectoryHandle(SCRATCH_DIR, { create: true });
      }
    } catch {
      this.scratch = null; // e.g. private browsing
    }
    return [];
  }

  async open(entry: FileEntry): Promise<FileWriter> {
    const name = safePath(entry.path).name;
    if (this.scratch) {
      const scratch = this.scratch;
      const scratchName = `${Date.now()}-${scratchCounter++}`;
      const handle = await scratch.getFileHandle(scratchName, { create: true });
      const stream = await handle.createWritable();
      return {
        write: (data) => stream.write(data),
        close: async () => {
          await stream.close();
          const file = await handle.getFile();
          this.onSaved({ name, size: file.size, url: URL.createObjectURL(file) });
        },
        abort: async () => {
          await stream.abort().catch(() => {});
          await scratch.removeEntry(scratchName).catch(() => {});
        },
      };
    }
    let parts: Blob[] = [];
    return {
      write: async (data) => {
        parts.push(data);
      },
      close: async () => {
        const blob = new Blob(parts, { type: "application/octet-stream" });
        parts = [];
        this.onSaved({ name, size: blob.size, url: URL.createObjectURL(blob) });
      },
      abort: async () => {
        parts = [];
      },
    };
  }
}
