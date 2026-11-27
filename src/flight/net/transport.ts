import type {
  ClientControlMessage,
  MatchMode,
  PeerInfo,
  ServerControlMessage,
  SuitVariant,
} from './protocol';
import { sanitizeRoomCode } from './protocol';

export type TransportStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type TransportBackend = 'websocket' | 'local';

export interface ConnectOptions {
  room: string;
  suit: SuitVariant;
  mode: MatchMode;
  callsign?: string;
  /** Override server base URL (e.g. wss://stark-flight-mp.workers.dev). */
  serverUrl?: string;
}

/**
 * Transport abstraction so the game can run over Cloudflare Durable Objects
 * WebSockets today, a same-browser BroadcastChannel for instant 2-tab tests,
 * or a WebRTC DataChannel in the future without touching sim code.
 */
export interface NetTransport {
  readonly backend: TransportBackend;
  readonly status: TransportStatus;
  readonly rttMs: number;
  readonly endpointLabel: string;
  onStatus: (status: TransportStatus, detail?: string) => void;
  onControl: (msg: ServerControlMessage) => void;
  onBinary: (buf: ArrayBuffer) => void;
  connect(opts: ConnectOptions): void;
  disconnect(): void;
  sendControl(msg: ClientControlMessage): void;
  sendBinary(buf: ArrayBuffer): void;
}

/** Resolve the WebSocket server base URL from query param, Vite env, or localhost default. */
export function resolveServerBaseUrl(override?: string): string | null {
  const clean = (s: string) => s.trim().replace(/\/+$/, '');
  if (override && override.trim()) return clean(override);

  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('server');
    if (q && q.trim()) return clean(q);
  }

  const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MP_SERVER;
  if (envUrl && envUrl.trim()) return clean(envUrl);

  if (typeof location !== 'undefined') {
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return 'ws://localhost:8787';
    }
    // Page served over the LAN (e.g. a friend opening http://10.0.0.x:5173): the dev relay runs on the same machine.
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local')) {
      return `ws://${host}:8787`;
    }
  }
  return null;
}

function toWsUrl(base: string, room: string): string {
  const wsBase = base.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  return `${wsBase}/room/${encodeURIComponent(sanitizeRoomCode(room) || 'MALIBU')}`;
}

/**
 * Production & local-relay WebSocket transport targeting `server/worker.ts`
 * (Cloudflare Durable Objects) or `server/dev-relay.mjs` (`ws://localhost:8787`).
 */
export class WebSocketTransport implements NetTransport {
  readonly backend: TransportBackend = 'websocket';
  status: TransportStatus = 'disconnected';
  rttMs = 0;
  endpointLabel = '';

  onStatus: (status: TransportStatus, detail?: string) => void = () => {};
  onControl: (msg: ServerControlMessage) => void = () => {};
  onBinary: (buf: ArrayBuffer) => void = () => {};

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  connect(opts: ConnectOptions): void {
    this.disconnect();
    const base = resolveServerBaseUrl(opts.serverUrl);
    if (!base) {
      this.setStatus('error', 'NO SERVER CONFIGURED · SET VITE_MP_SERVER OR USE LOCAL 2-TAB');
      return;
    }
    const url = toWsUrl(base, opts.room);
    this.endpointLabel = base.replace(/^wss?:\/\//, '');
    this.setStatus('connecting', `LINKING ${this.endpointLabel}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : 'WEBSOCKET INIT FAILED');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.setStatus('connected', 'ONLINE');
      this.sendControl({
        type: 'hello',
        suit: opts.suit,
        mode: opts.mode,
        callsign: opts.callsign,
      });
      this.startPing();
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        this.onBinary(ev.data);
        return;
      }
      if (typeof ev.data === 'string') {
        let parsed: ServerControlMessage;
        try {
          parsed = JSON.parse(ev.data) as ServerControlMessage;
        } catch {
          return;
        }
        if (parsed.type === 'pong') {
          const rtt = Math.max(0, Math.round(performance.now() - parsed.t));
          this.rttMs = this.rttMs > 0 ? Math.round(this.rttMs * 0.65 + rtt * 0.35) : rtt;
        }
        this.onControl(parsed);
      }
    });

    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.stopPing();
      this.ws = null;
      // Keep the actionable 'error' detail (e.g. "RUN npm run mp:dev") instead of
      // overwriting it with a generic LINK LOST (1006) when the failed socket closes.
      if (this.status !== 'disconnected' && this.status !== 'error') {
        const reason = ev.code === 1000 ? 'DISCONNECTED' : `LINK LOST (${ev.code})`;
        this.setStatus('disconnected', reason);
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.setStatus('error', `UNREACHABLE (${this.endpointLabel}) · RUN npm run mp:dev`);
    });
  }

  disconnect(): void {
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'leave');
      } catch {
        /* ignore */
      }
    }
    this.rttMs = 0;
    if (this.status !== 'disconnected') this.setStatus('disconnected');
  }

  sendControl(msg: ClientControlMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendBinary(buf: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.sendControl({ type: 'ping', t: performance.now() });
    this.pingTimer = setInterval(() => {
      this.sendControl({ type: 'ping', t: performance.now() });
    }, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setStatus(next: TransportStatus, detail?: string): void {
    this.status = next;
    this.onStatus(next, detail);
  }
}

type LocalEnvelope =
  | { kind: 'join'; from: string; peer: PeerInfo; startedAt: number }
  | { kind: 'here'; from: string; to: string; peer: PeerInfo; startedAt: number }
  | { kind: 'update'; from: string; peer: PeerInfo }
  | { kind: 'leave'; from: string }
  | { kind: 'event'; from: string; event: unknown }
  | { kind: 'bin'; from: string; data: ArrayBuffer };

/**
 * Zero-server same-browser transport backed by `BroadcastChannel`.
 * Open two tabs on the same origin (even on Vercel without a Worker deployed)
 * and fly Iron Man + War Machine together immediately.
 */
export class BroadcastChannelTransport implements NetTransport {
  readonly backend: TransportBackend = 'local';
  status: TransportStatus = 'disconnected';
  rttMs = 1;
  endpointLabel = 'LOCAL 2-TAB';

  onStatus: (status: TransportStatus, detail?: string) => void = () => {};
  onControl: (msg: ServerControlMessage) => void = () => {};
  onBinary: (buf: ArrayBuffer) => void = () => {};

  private ch: BroadcastChannel | null = null;
  private selfId = '';
  private selfPeer: PeerInfo | null = null;
  private room = '';
  private startedAt = 0;
  private remotePeer: PeerInfo | null = null;
  private unloadHandler: (() => void) | null = null;

  connect(opts: ConnectOptions): void {
    this.disconnect();
    if (typeof BroadcastChannel === 'undefined') {
      this.setStatus('error', 'BROADCAST CHANNEL UNSUPPORTED');
      return;
    }
    this.room = sanitizeRoomCode(opts.room) || 'MALIBU';
    this.selfId = Math.random().toString(36).slice(2, 10);
    this.startedAt = Date.now();
    this.remotePeer = null;

    this.selfPeer = {
      id: this.selfId,
      role: 'host',
      suit: opts.suit,
      mode: opts.mode,
      callsign: opts.callsign ?? (opts.suit === 'warmachine' ? 'RHODES' : 'STARK'),
    };

    const ch = new BroadcastChannel(`stark-flight-mp:${this.room}`);
    this.ch = ch;
    this.setStatus('connected', 'LOCAL 2-TAB');

    ch.onmessage = (ev: MessageEvent<LocalEnvelope>) => {
      const m = ev.data;
      if (!m || m.from === this.selfId) return;

      if (m.kind === 'bin') {
        this.onBinary(m.data);
        return;
      }

      if (m.kind === 'join') {
        // An existing tab hears a new tab arrive -> reply with `here`
        const incoming: PeerInfo = { ...m.peer, role: 'guest' };
        this.remotePeer = incoming;
        if (this.selfPeer) {
          ch.postMessage({
            kind: 'here',
            from: this.selfId,
            to: m.from,
            peer: this.selfPeer,
            startedAt: this.startedAt,
          } satisfies LocalEnvelope);
        }
        this.onControl({ type: 'peerJoined', peer: incoming });
        return;
      }

      if (m.kind === 'here' && m.to === this.selfId) {
        // We joined an existing host tab -> adopt guest role & host's clock
        this.remotePeer = m.peer;
        if (this.selfPeer) {
          this.selfPeer.role = 'guest';
          this.selfPeer.mode = m.peer.mode;
        }
        this.startedAt = m.startedAt;
        this.onControl({
          type: 'welcome',
          id: this.selfId,
          room: this.room,
          role: 'guest',
          suit: this.selfPeer?.suit ?? opts.suit,
          mode: m.peer.mode,
          peers: [m.peer],
          worldTime: (Date.now() - this.startedAt) / 1000,
        });
        return;
      }

      if (m.kind === 'update') {
        this.remotePeer = m.peer;
        this.onControl({ type: 'peerUpdated', peer: m.peer });
        return;
      }

      if (m.kind === 'leave') {
        if (this.remotePeer?.id === m.from) {
          this.remotePeer = null;
          let newHostId: string | undefined;
          if (this.selfPeer && this.selfPeer.role !== 'host') {
            this.selfPeer.role = 'host';
            newHostId = this.selfId;
          }
          this.onControl({ type: 'peerLeft', id: m.from, newHostId });
        }
        return;
      }

      if (m.kind === 'event') {
        this.onControl({ type: 'event', from: m.from, event: m.event as never });
      }
    };

    // Emit initial welcome as host; if another tab responds with `here`, we transition cleanly to guest
    this.onControl({
      type: 'welcome',
      id: this.selfId,
      room: this.room,
      role: 'host',
      suit: this.selfPeer.suit,
      mode: this.selfPeer.mode,
      peers: [],
      worldTime: 0,
    });

    ch.postMessage({
      kind: 'join',
      from: this.selfId,
      peer: this.selfPeer,
      startedAt: this.startedAt,
    } satisfies LocalEnvelope);

    if (typeof window !== 'undefined') {
      this.unloadHandler = () => this.disconnect();
      window.addEventListener('beforeunload', this.unloadHandler);
    }
  }

  disconnect(): void {
    if (this.unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    if (this.ch) {
      try {
        this.ch.postMessage({ kind: 'leave', from: this.selfId } satisfies LocalEnvelope);
        this.ch.close();
      } catch {
        /* ignore */
      }
      this.ch = null;
    }
    this.remotePeer = null;
    if (this.status !== 'disconnected') this.setStatus('disconnected');
  }

  sendControl(msg: ClientControlMessage): void {
    if (!this.ch || !this.selfPeer) return;
    if (msg.type === 'hello' || msg.type === 'select') {
      if (msg.suit) {
        this.selfPeer.suit = msg.suit;
        if (!msg.callsign) this.selfPeer.callsign = msg.suit === 'warmachine' ? 'RHODES' : 'STARK';
      }
      if (msg.callsign) this.selfPeer.callsign = msg.callsign;
      if (msg.mode) this.selfPeer.mode = msg.mode;
      this.ch.postMessage({ kind: 'update', from: this.selfId, peer: { ...this.selfPeer } } satisfies LocalEnvelope);
    } else if (msg.type === 'event') {
      this.ch.postMessage({ kind: 'event', from: this.selfId, event: msg.event } satisfies LocalEnvelope);
    }
  }

  sendBinary(buf: ArrayBuffer): void {
    if (!this.ch) return;
    this.ch.postMessage({ kind: 'bin', from: this.selfId, data: buf } satisfies LocalEnvelope);
  }

  private setStatus(next: TransportStatus, detail?: string): void {
    this.status = next;
    this.onStatus(next, detail);
  }
}
