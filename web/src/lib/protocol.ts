// Wire protocol spoken over the single ordered WebRTC data channel.
// Text frames are JSON control messages; binary frames are file bytes for the
// file most recently announced by a "file" message.

export interface FileEntry {
  id: number;
  /** Relative path using "/" separators, e.g. "Trip/IMG_001.jpg". */
  path: string;
  size: number;
  lastModified: number;
}

export type ControlMessage =
  /** Sender → receiver. Sent on every channel open while a transfer is live. */
  | { t: "manifest"; transferId: string; files: FileEntry[] }
  /**
   * Receiver → sender. Starts (or resumes) the byte stream. `done` lists files
   * the receiver already has in full; `partial` is the file it is midway
   * through and how many bytes of it are safely written.
   */
  | { t: "accept"; transferId: string; done: number[]; partial?: { id: number; offset: number } }
  | { t: "decline"; transferId: string }
  /** Sender → receiver. Binary frames that follow belong to this file. */
  | { t: "file"; id: number; offset: number }
  | { t: "file-end"; id: number }
  /** Receiver → sender. Total bytes written to disk since the last accept. */
  | { t: "ack"; bytes: number }
  /** Sender → receiver. Every file has been sent. */
  | { t: "done" }
  /** Receiver → sender. Every file is written and closed. */
  | { t: "complete" }
  | { t: "cancel"; reason: string };

/** Sender pauses when this many bytes are sent but not yet written by the receiver. */
export const ACK_WINDOW = 32 * 1024 * 1024;
/** Receiver buffers this much before each disk write (and ack). */
export const WRITE_BATCH = 2 * 1024 * 1024;
/** Sender reads the source file in blocks of this size. */
export const READ_BLOCK = 4 * 1024 * 1024;
/** Data channel send-buffer watermarks. */
export const BUFFER_HIGH = 8 * 1024 * 1024;
export const BUFFER_LOW = 1 * 1024 * 1024;
/** Upper bound for one data channel message; the peer may advertise less. */
export const MAX_CHUNK = 256 * 1024;
export const SAFE_CHUNK = 64 * 1024;
