// Connection layer: keeps a signaling WebSocket open and (re)builds the WebRTC
// peer connection whenever it drops. The host always makes the offer, so the
// two sides can never both start negotiating at once.

import { MAX_CHUNK, SAFE_CHUNK } from "./protocol";

export type Role = "host" | "guest";

/**
 * server:       reaching the signaling service
 * waiting:      in the room, other device not here yet
 * connecting:   other device present, building the direct connection
 * connected:    data channel open
 * reconnecting: had a connection, lost it, trying again
 */
export type LinkStatus = "server" | "waiting" | "connecting" | "connected" | "reconnecting";

export type PathKind = "local" | "internet" | "relay";

export interface LinkEvents {
  onStatus(status: LinkStatus): void;
  onOpen(channel: RTCDataChannel, maxChunk: number): void;
  onClose(): void;
  onFatal(reason: string): void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];
const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECT_GRACE_MS = 5_000;
const PING_INTERVAL_MS = 20_000;

type Signal =
  | { type: "peers"; roles: Role[] }
  | { type: "error"; reason: string }
  | { type: "offer"; gen: number; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; gen: number; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; gen: number; candidate: RTCIceCandidateInit }
  | { type: "need-offer" };

function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (a.endsWith(".local")) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // IPv6 loopback, link-local and unique-local ranges.
  return a === "::1" || /^fe[89ab]/.test(a) || /^f[cd]/.test(a);
}

export class Link {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private pcCreatedAt = 0;
  private channelOpen = false;
  private everOpened = false;
  private everJoined = false;
  private peerPresent = false;
  private stopped = false;
  private gen = 0;
  private wsAttempts = 0;
  private signalQueue: Promise<void> = Promise.resolve();
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private status: LinkStatus = "server";

  constructor(
    private readonly baseUrl: string,
    private readonly code: string,
    private readonly role: Role,
    private readonly clientId: string,
    private readonly events: LinkEvents,
  ) {}

  start(): void {
    this.connectSignaling();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.teardownPeer();
    this.ws?.close();
    this.ws = null;
  }

  /** How the two devices are actually connected, for display. */
  async pathKind(): Promise<PathKind | null> {
    const pc = this.pc;
    if (!pc || !this.channelOpen) return null;
    try {
      const stats = await pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r) => {
        if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let pair: any = pairId ? stats.get(pairId) : undefined;
      if (!pair) {
        // Firefox has no transport report; it marks the pair as selected.
        stats.forEach((r) => {
          if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = r;
        });
      }
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      if (!local || !remote) return null;
      if (local.candidateType === "relay" || remote.candidateType === "relay") return "relay";
      // Candidate types alone mislead: on one network a side can still be
      // reported as "peer reflexive". The address we actually talk to settles it.
      const address: string = remote.address ?? remote.ip ?? "";
      if (isPrivateAddress(address)) return "local";
      if (local.candidateType === "host" && remote.candidateType === "host") return "local";
      return "internet";
    } catch {
      return null;
    }
  }

  /** Test hook: kill the peer connection as if the network dropped. */
  debugDrop(): void {
    if (this.pc) this.peerDown(this.pc);
  }

  // ---- signaling -----------------------------------------------------------

  private connectSignaling(): void {
    if (this.stopped) return;
    const url = `${this.baseUrl}/room/${this.code}?role=${this.role}&client=${this.clientId}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.wsAttempts = 0;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      let signal: Signal;
      try {
        signal = JSON.parse(event.data);
      } catch {
        return;
      }
      // Handle strictly in arrival order: an ICE candidate must not be applied
      // before the offer/answer that precedes it has finished applying.
      this.signalQueue = this.signalQueue
        .then(() => (ws === this.ws ? this.handleSignal(signal) : undefined))
        .catch((err) => console.warn("signal handling failed", err));
    };

    ws.onclose = () => {
      if (ws !== this.ws || this.stopped) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.refreshStatus();
      const delay = Math.min(5000, 500 * 2 ** this.wsAttempts++);
      this.retryTimer = setTimeout(() => this.connectSignaling(), delay);
    };
  }

  private sendSignal(signal: Signal): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(signal));
  }

  private async handleSignal(signal: Signal): Promise<void> {
    switch (signal.type) {
      case "error": {
        // After a first successful join, "no-such-room" only means the host's
        // socket is briefly down; keep retrying instead of giving up.
        if (signal.reason === "no-such-room" && this.everJoined) return;
        this.events.onFatal(signal.reason);
        this.stop();
        return;
      }
      case "peers": {
        this.everJoined = true;
        const other: Role = this.role === "host" ? "guest" : "host";
        this.peerPresent = signal.roles.includes(other);
        if (this.peerPresent && !this.peerHealthy()) {
          if (this.role === "host") await this.startOffer();
          else if (this.everOpened) this.sendSignal({ type: "need-offer" });
        }
        this.refreshStatus();
        return;
      }
      case "need-offer": {
        if (this.role !== "host") return;
        // Ignore if we only just started a fresh attempt ourselves.
        const fresh = this.pc && !this.channelOpen && Date.now() - this.pcCreatedAt < 5000;
        if (!fresh) await this.startOffer();
        return;
      }
      case "offer": {
        if (this.role !== "guest") return;
        this.dropPeer();
        this.gen = signal.gen;
        const pc = this.createPeer();
        pc.ondatachannel = (event) => this.adoptChannel(pc, event.channel);
        await pc.setRemoteDescription(signal.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        this.sendSignal({ type: "answer", gen: this.gen, sdp: pc.localDescription!.toJSON() });
        this.refreshStatus();
        return;
      }
      case "answer": {
        if (this.role !== "host" || signal.gen !== this.gen || !this.pc) return;
        await this.pc.setRemoteDescription(signal.sdp);
        return;
      }
      case "ice": {
        if (signal.gen !== this.gen || !this.pc) return;
        await this.pc.addIceCandidate(signal.candidate).catch(() => {});
        return;
      }
    }
  }

  // ---- peer connection -----------------------------------------------------

  private peerHealthy(): boolean {
    const state = this.pc?.connectionState;
    return state === "new" || state === "connecting" || state === "connected";
  }

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const gen = this.gen;
    this.pc = pc;
    this.pcCreatedAt = Date.now();

    pc.onicecandidate = (event) => {
      if (event.candidate && pc === this.pc) {
        this.sendSignal({ type: "ice", gen, candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      clearTimeout(this.graceTimer);
      if (pc.connectionState === "failed") {
        this.peerDown(pc);
      } else if (pc.connectionState === "disconnected") {
        // Brief blips often heal on their own; give it a moment.
        this.graceTimer = setTimeout(() => {
          if (pc === this.pc && pc.connectionState !== "connected") this.peerDown(pc);
        }, DISCONNECT_GRACE_MS);
      }
    };

    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (pc === this.pc && !this.channelOpen) this.peerDown(pc);
    }, CONNECT_TIMEOUT_MS);
    return pc;
  }

  private async startOffer(): Promise<void> {
    this.dropPeer();
    this.gen++;
    const pc = this.createPeer();
    this.adoptChannel(pc, pc.createDataChannel("sher", { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    if (pc !== this.pc) return;
    this.sendSignal({ type: "offer", gen: this.gen, sdp: pc.localDescription!.toJSON() });
    this.refreshStatus();
  }

  private adoptChannel(pc: RTCPeerConnection, dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    this.dc = dc;
    dc.onopen = () => {
      if (pc !== this.pc) return;
      clearTimeout(this.connectTimer);
      this.channelOpen = true;
      this.everOpened = true;
      const advertised = pc.sctp?.maxMessageSize;
      const maxChunk = advertised && advertised >= SAFE_CHUNK ? Math.min(advertised, MAX_CHUNK) : SAFE_CHUNK;
      this.refreshStatus();
      this.events.onOpen(dc, maxChunk);
    };
    dc.onclose = () => {
      if (pc === this.pc) this.peerDown(pc);
    };
  }

  /** Close the current peer connection and tell the app if a channel was live. */
  private dropPeer(): void {
    const wasOpen = this.channelOpen;
    this.teardownPeer();
    if (wasOpen) this.events.onClose();
  }

  private teardownPeer(): void {
    clearTimeout(this.connectTimer);
    clearTimeout(this.graceTimer);
    if (this.dc) {
      this.dc.onopen = this.dc.onclose = this.dc.onmessage = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ondatachannel = null;
      this.pc.close();
    }
    this.pc = null;
    this.dc = null;
    this.channelOpen = false;
  }

  /** The connection is dead: clean up and try to build a new one. */
  private peerDown(pc: RTCPeerConnection): void {
    if (pc !== this.pc || this.stopped) return;
    this.dropPeer();
    this.refreshStatus();
    if (!this.peerPresent) return; // a "peers" update will restart us
    if (this.role === "host") {
      this.signalQueue = this.signalQueue.then(() => this.startOffer()).catch(() => {});
    } else {
      this.sendSignal({ type: "need-offer" });
    }
  }

  private refreshStatus(): void {
    let next: LinkStatus;
    if (this.channelOpen) next = "connected";
    else if (this.everOpened) next = "reconnecting";
    else if (this.ws?.readyState !== WebSocket.OPEN) next = "server";
    else if (!this.peerPresent) next = "waiting";
    else next = "connecting";
    if (next !== this.status) {
      this.status = next;
      this.events.onStatus(next);
    }
  }
}
