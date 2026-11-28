#!/usr/bin/env node
/**
 * Zero-dependency local WebSocket room relay for testing Iron Man + War Machine
 * multiplayer on localhost without needing Wrangler or any npm packages.
 *
 * Implements the same `/room/:code` protocol as `server/worker.ts`, except the
 * `?rejoin=` seat swap (see README: a reconnect here is an ordinary join).
 * Run with: `npm run mp:dev` (listens on ws://localhost:8787).
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);
const MAX_PLAYERS = 2;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** @typedef {{ socket: import('node:net').Socket, id: string, role: 'host'|'guest', suit: 'ironman'|'warmachine', mode: 'coop'|'duel', callsign: string, buf: Buffer, closed: boolean }} Client */
/** @type {Map<string, { code: string, startedAt: number, clients: Set<Client> }>} */
const rooms = new Map();

function sanitizeRoom(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12) || 'MALIBU';
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function sendFrame(client, opcode, payload) {
  if (client.closed || client.socket.destroyed) return;
  try {
    client.socket.write(encodeFrame(opcode, payload));
  } catch {
    /* ignore write after close */
  }
}

function sendJson(client, obj) {
  sendFrame(client, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function peerPublic(c) {
  return { id: c.id, role: c.role, suit: c.suit, mode: c.mode, callsign: c.callsign };
}

function consumeFrames(client, onMessage, onClose) {
  while (client.buf.length >= 2) {
    const b0 = client.buf[0];
    const b1 = client.buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (client.buf.length < 4) return;
      payloadLen = client.buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (client.buf.length < 10) return;
      payloadLen = Number(client.buf.readBigUInt64BE(2));
      offset = 10;
    }

    const maskOffset = offset;
    if (masked) offset += 4;
    if (client.buf.length < offset + payloadLen) return;

    const payload = Buffer.allocUnsafe(payloadLen);
    if (masked) {
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = client.buf[offset + i] ^ client.buf[maskOffset + (i & 3)];
      }
    } else {
      client.buf.copy(payload, 0, offset, offset + payloadLen);
    }

    client.buf = client.buf.subarray(offset + payloadLen);

    if (opcode === 0x8) {
      sendFrame(client, 0x8, Buffer.alloc(0));
      onClose();
      return;
    }
    if (opcode === 0x9) {
      sendFrame(client, 0xa, payload);
      continue;
    }
    if (opcode === 0xa) continue;
    if (opcode === 0x1 || opcode === 0x2) {
      onMessage(opcode, payload);
    }
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'stark-mp-dev', rooms: rooms.size, maxPlayers: MAX_PLAYERS }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const match = url.pathname.match(/^\/room\/([^/]+)$/);
  const key = req.headers['sec-websocket-key'];
  if (!match || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const code = sanitizeRoom(decodeURIComponent(match[1]));
  let room = rooms.get(code);
  if (!room) {
    room = { code, startedAt: Date.now(), clients: new Set() };
    rooms.set(code, room);
  }
  if (room.clients.size >= MAX_PLAYERS) {
    socket.write('HTTP/1.1 409 Conflict\r\nContent-Type: text/plain\r\n\r\nRoom full');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const existing = [...room.clients];
  const host = existing.find((c) => c.role === 'host');
  const role = host ? 'guest' : 'host';
  const defaultSuit = role === 'guest' && host?.suit === 'ironman' ? 'warmachine' : 'ironman';

  /** @type {Client} */
  const client = {
    socket,
    id: crypto.randomUUID().slice(0, 8),
    role,
    suit: defaultSuit,
    mode: host?.mode ?? 'coop',
    callsign: defaultSuit === 'warmachine' ? 'RHODES' : 'STARK',
    buf: Buffer.alloc(0),
    closed: false,
  };
  room.clients.add(client);

  sendJson(client, {
    type: 'welcome',
    id: client.id,
    room: code,
    role: client.role,
    suit: client.suit,
    mode: client.mode,
    peers: existing.map(peerPublic),
    worldTime: (Date.now() - room.startedAt) / 1000,
  });

  for (const other of existing) {
    sendJson(other, { type: 'peerJoined', peer: peerPublic(client) });
  }

  const cleanup = () => {
    if (client.closed) return;
    client.closed = true;
    room.clients.delete(client);
    const remaining = [...room.clients];
    let newHostId;
    if (client.role === 'host' && remaining.length > 0) {
      remaining[0].role = 'host';
      newHostId = remaining[0].id;
    }
    for (const other of remaining) {
      sendJson(other, { type: 'peerLeft', id: client.id, newHostId });
    }
    if (room.clients.size === 0) rooms.delete(code);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    consumeFrames(
      client,
      (opcode, payload) => {
        if (opcode === 0x2) {
          for (const other of room.clients) {
            if (other !== client) sendFrame(other, 0x2, payload);
          }
          return;
        }
        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        if (msg.type === 'ping') {
          sendJson(client, { type: 'pong', t: typeof msg.t === 'number' ? msg.t : 0, serverTime: (Date.now() - room.startedAt) / 1000 });
        } else if (msg.type === 'hello' || msg.type === 'select') {
          if (msg.suit === 'ironman' || msg.suit === 'warmachine') {
            client.suit = msg.suit;
            if (!msg.callsign) client.callsign = client.suit === 'warmachine' ? 'RHODES' : 'STARK';
          }
          if (typeof msg.callsign === 'string' && msg.callsign.trim()) {
            client.callsign = msg.callsign.trim().toUpperCase().slice(0, 14);
          }
          if (msg.mode === 'coop' || msg.mode === 'duel') {
            client.mode = msg.mode;
          }
          for (const other of room.clients) {
            if (other !== client) sendJson(other, { type: 'peerUpdated', peer: peerPublic(client) });
          }
        } else if (msg.type === 'event' && msg.event && typeof msg.event === 'object') {
          for (const other of room.clients) {
            if (other !== client) sendJson(other, { type: 'event', from: client.id, event: msg.event });
          }
        }
      },
      cleanup,
    );
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`[stark-mp-dev] WebSocket room relay listening on ws://localhost:${PORT}`);
});
