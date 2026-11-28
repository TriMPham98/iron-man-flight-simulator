import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketTransport } from './transport';

/** Just enough of a browser WebSocket to drive the transport by hand. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  private readonly handlers = new Map<string, ((ev: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string, ev: unknown = {}): void {
    if (type === 'open') this.readyState = 1;
    for (const fn of this.handlers.get(type) ?? []) fn(ev);
  }
  send(d: unknown): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
  }
}

describe('WebSocketTransport reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeSocket.all = [];
  });

  it('takes its own seat back after the link drops, and stops when the pilot leaves', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const t = new WebSocketTransport();
    const statuses: string[] = [];
    t.onStatus = (s) => statuses.push(s);
    t.connect({ room: 'ABC123', suit: 'ironman', mode: 'coop', serverUrl: 'wss://relay.test' });
    const first = FakeSocket.all[0];
    first.fire('open');
    first.fire('message', { data: JSON.stringify({ type: 'welcome', id: 'me42', room: 'ABC123', role: 'host', suit: 'ironman', mode: 'coop', peers: [], worldTime: 0 }) });

    first.fire('close', { code: 1006 });
    expect(t.status).toBe('connecting');
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all.length).toBe(2);
    expect(FakeSocket.all[1].url).toBe('wss://relay.test/room/ABC123?rejoin=me42');

    // A socket that goes silent is called lost too
    const second = FakeSocket.all[1];
    second.fire('open');
    vi.advanceTimersByTime(12000);
    expect(FakeSocket.all.length).toBeGreaterThan(2);

    t.disconnect();
    const n = FakeSocket.all.length;
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all.length).toBe(n);
    expect(t.status).toBe('disconnected');
    expect(statuses).toContain('connected');
  });
});

describe('WebSocketTransport first contact', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeSocket.all = [];
  });

  it('says how to start the relay instead of retrying when it was never reached', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const t = new WebSocketTransport();
    let detail = '';
    t.onStatus = (_s, d) => (detail = d ?? '');
    t.connect({ room: 'ABC123', suit: 'ironman', mode: 'coop', serverUrl: 'ws://localhost:8787' });
    FakeSocket.all[0].fire('error');
    FakeSocket.all[0].fire('close', { code: 1006 });
    expect(t.status).toBe('error');
    expect(detail).toContain('mp:dev');
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all.length).toBe(1);
  });
});
