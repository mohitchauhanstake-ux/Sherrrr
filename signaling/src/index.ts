// Signaling service: lets two browsers find each other and exchange WebRTC
// connection info. No file data ever passes through here.
//
// One Durable Object per room code. A room holds at most one "host" (the
// sender, who created the room) and one "guest". Every text message from one
// side is forwarded verbatim to the other.

import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

type Role = "host" | "guest";
interface Attachment {
  role: Role;
  clientId: string;
}

const ROOM_PATH = /^\/room\/([A-HJ-NP-Z2-9]{6})$/;
const MAX_MESSAGE_CHARS = 64_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = ROOM_PATH.exec(url.pathname);
    if (!match) {
      return new Response("sher signaling", { status: url.pathname === "/" ? 200 : 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const role = url.searchParams.get("role");
    const clientId = url.searchParams.get("client") ?? "";
    if ((role !== "host" && role !== "guest") || !/^[\w-]{8,64}$/.test(clientId)) {
      return new Response("bad request", { status: 400 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as Role;
    const clientId = url.searchParams.get("client")!;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Refusals are sent as a message after accepting, because a rejected
    // WebSocket upgrade gives the browser no readable reason.
    const refuse = (reason: string, code: number) => {
      server.accept();
      server.send(JSON.stringify({ type: "error", reason }));
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    const live = this.liveSockets();
    const sameRole = live.find((ws) => attachment(ws).role === role);
    if (sameRole) {
      if (attachment(sameRole).clientId !== clientId) return refuse("room-full", 4001);
      // Same device reconnecting: its old socket is stale.
      sameRole.close(4000, "replaced");
    }
    if (role === "guest" && !live.some((ws) => attachment(ws).role === "host")) {
      return refuse("no-such-room", 4004);
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, clientId } satisfies Attachment);
    this.broadcastPeers(sameRole);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS) return;
    for (const other of this.liveSockets()) {
      if (other !== ws) {
        try {
          other.send(message);
        } catch {
          // The other side is going away; its close handler will announce it.
        }
      }
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    this.broadcastPeers(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.broadcastPeers(ws);
  }

  private liveSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** Tell everyone who is currently in the room. */
  private broadcastPeers(exclude?: WebSocket): void {
    const sockets = this.liveSockets().filter((ws) => ws !== exclude);
    const roles = sockets.map((ws) => attachment(ws).role);
    const message = JSON.stringify({ type: "peers", roles });
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // ignore
      }
    }
  }
}

function attachment(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}
