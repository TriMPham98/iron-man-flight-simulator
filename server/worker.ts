/**
 * Stark Flight Multiplayer Room Server — Cloudflare Workers + Durable Objects.
 *
 * Uses the Durable Objects WebSocket Hibernation API so idle rooms consume
 * 0 compute duration on the Cloudflare Workers Free Plan.
 *
 * Endpoints:
 *   GET /health        -> { ok: true, service: "stark-mp" }
 *   GET /room/:code    -> WebSocket upgrade for a 2-player room (Iron Man + War Machine)
 *
 * Wire protocol:
 *   - Binary frames: pilot state (25 Hz) and host enemy snapshots (15 Hz), relayed raw to the other peer
 *   - JSON text frames: hello / select / ping / event control messages
 */

export interface Env {
  FLIGHT_ROOM: DurableObjectNamespace;
}

type SuitVariant = 'ironman' | 'warmachine';
type MatchMode = 'coop' | 'duel';
type PlayerRole = 'host' | 'guest';

interface PeerAttachment {
  id: string;
  role: PlayerRole;
  suit: SuitVariant;
  mode: MatchMode;
  callsign: string;
}

const MAX_PLAYERS = 2;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sanitizeRoom(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12) || 'MALIBU';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json(
        { ok: true, service: 'stark-mp', maxPlayers: MAX_PLAYERS },
        { headers: CORS_HEADERS },
      );
    }

    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (match) {
      const code = sanitizeRoom(decodeURIComponent(match[1]));
      const id = env.FLIGHT_ROOM.idFromName(code);
      const stub = env.FLIGHT_ROOM.get(id);
      const fwdUrl = new URL(request.url);
      fwdUrl.searchParams.set('room', code);
      return stub.fetch(new Request(fwdUrl.toString(), request));
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};

export class FlightRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private roomCode = 'MALIBU';
  private startedAt = Date.now();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    this.roomCode = sanitizeRoom(url.searchParams.get('room') ?? this.roomCode);

    // A seat whose socket we've let go of (see below) no longer counts
    let existing = this.ctx.getWebSockets().filter((ws) => this.readPeer(ws) !== null);

    // A pilot whose phone dropped the link comes back for their own seat: the
    // old socket may not have closed yet (a dead mobile connection can linger),
    // so it is let go quietly (no peerLeft) and the pilot keeps id, role and suit
    const rejoin = url.searchParams.get('rejoin');
    const stale = rejoin ? existing.find((ws) => this.readPeer(ws)?.id === rejoin) : undefined;
    if (stale) {
      const back = this.readPeer(stale)!;
      stale.serializeAttachment(null);
      try {
        stale.close(4000, 'replaced');
      } catch {
        /* already gone */
      }
      existing = existing.filter((ws) => ws !== stale);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(back);
      this.sendJson(server, {
        type: 'welcome',
        id: back.id,
        room: this.roomCode,
        role: back.role,
        suit: back.suit,
        mode: back.mode,
        peers: existing.map((ws) => this.readPeer(ws)).filter((p): p is PeerAttachment => p !== null),
        worldTime: (Date.now() - this.startedAt) / 1000,
      });
      for (const other of existing) this.sendJson(other, { type: 'peerUpdated', peer: back });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (existing.length >= MAX_PLAYERS) {
      return new Response('Room full (max 2 pilots)', { status: 409, headers: CORS_HEADERS });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const hasHost = existing.some((ws) => this.readPeer(ws)?.role === 'host');
    const role: PlayerRole = hasHost ? 'guest' : 'host';
    const hostPeer = existing.map((ws) => this.readPeer(ws)).find((p) => p?.role === 'host');

    const defaultSuit: SuitVariant =
      role === 'guest' && hostPeer?.suit === 'ironman'
        ? 'warmachine'
        : role === 'guest' && hostPeer?.suit === 'warmachine'
          ? 'ironman'
          : 'ironman';

    const peer: PeerAttachment = {
      id: crypto.randomUUID().slice(0, 8),
      role,
      suit: defaultSuit,
      mode: hostPeer?.mode ?? 'coop',
      callsign: defaultSuit === 'warmachine' ? 'RHODES' : 'STARK',
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const peers = existing
      .map((ws) => this.readPeer(ws))
      .filter((p): p is PeerAttachment => p !== null);

    this.sendJson(server, {
      type: 'welcome',
      id: peer.id,
      room: this.roomCode,
      role: peer.role,
      suit: peer.suit,
      mode: peer.mode,
      peers,
      worldTime: (Date.now() - this.startedAt) / 1000,
    });

    for (const other of existing) {
      this.sendJson(other, { type: 'peerJoined', peer });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      // Binary suit kinematic packet: relay raw bytes to the other pilot
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws) {
          try {
            other.send(message);
          } catch {
            /* closing socket */
          }
        }
      }
      return;
    }

    const peer = this.readPeer(ws);
    if (!peer) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ping': {
        this.sendJson(ws, {
          type: 'pong',
          t: typeof msg.t === 'number' ? msg.t : 0,
          serverTime: (Date.now() - this.startedAt) / 1000,
        });
        break;
      }

      case 'hello':
      case 'select': {
        if (msg.suit === 'ironman' || msg.suit === 'warmachine') {
          peer.suit = msg.suit;
          if (!msg.callsign) {
            peer.callsign = peer.suit === 'warmachine' ? 'RHODES' : 'STARK';
          }
        }
        if (typeof msg.callsign === 'string' && msg.callsign.trim()) {
          peer.callsign = msg.callsign.trim().toUpperCase().slice(0, 14);
        }
        if ((msg.mode === 'coop' || msg.mode === 'duel') && (peer.role === 'host' || msg.type === 'select')) {
          peer.mode = msg.mode;
        }
        ws.serializeAttachment(peer);
        for (const other of this.ctx.getWebSockets()) {
          if (other !== ws) {
            this.sendJson(other, { type: 'peerUpdated', peer });
          }
        }
        break;
      }

      case 'event': {
        if (msg.event && typeof msg.event === 'object') {
          for (const other of this.ctx.getWebSockets()) {
            if (other !== ws) {
              this.sendJson(other, { type: 'event', from: peer.id, event: msg.event });
            }
          }
        }
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.handleDisconnect(ws);
  }

  private handleDisconnect(ws: WebSocket): void {
    const leaving = this.readPeer(ws);
    if (!leaving) return;
    // Free the seat at once (a closing socket can still be listed for a while)
    try {
      ws.serializeAttachment(null);
      ws.close(1000, 'bye');
    } catch {
      /* already closed */
    }
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws && this.readPeer(s) !== null);
    let newHostId: string | undefined;

    if (leaving.role === 'host' && remaining.length > 0) {
      const next = this.readPeer(remaining[0]);
      if (next) {
        next.role = 'host';
        remaining[0].serializeAttachment(next);
        newHostId = next.id;
      }
    }

    for (const other of remaining) {
      this.sendJson(other, { type: 'peerLeft', id: leaving.id, newHostId });
    }
  }

  private readPeer(ws: WebSocket): PeerAttachment | null {
    const data = ws.deserializeAttachment() as PeerAttachment | null;
    return data && typeof data.id === 'string' ? data : null;
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* closing socket */
    }
  }
}
