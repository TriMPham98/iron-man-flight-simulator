# Stark Flight Multiplayer Server

Lightweight 2-player room relay (Iron Man + War Machine) built for **Cloudflare Workers + Durable Objects** (Free Plan: $0/mo, ~14 match-hours/day free) with a zero-dependency local Node dev relay.

## 1. Local Development (No Cloudflare Account Needed)

```bash
# Terminal 1 — Vite frontend
npm run dev

# Terminal 2 — Local WebSocket relay on ws://localhost:8787
npm run mp:dev
```

Open two browser tabs to `http://localhost:5173/flight.html`, press **M** (Multiplayer), host a room in Tab 1, and join with the room code in Tab 2.

*(Tip: You can also pick **LOCAL 2-TAB** mode inside the Multiplayer drawer to test two tabs on the same browser via `BroadcastChannel` without even starting the relay!)*

## 2. Free Production Deploy (Cloudflare Workers + Vercel)

1. Deploy the Durable Object Worker once (free Cloudflare account):
   ```bash
   cd server
   npx wrangler login
   npx wrangler deploy
   ```
2. Copy the deployed URL (e.g. `wss://stark-flight-mp.<your-subdomain>.workers.dev`).
3. In your **Vercel** project settings, add the environment variable:
   ```
   VITE_MP_SERVER=wss://stark-flight-mp.<your-subdomain>.workers.dev
   ```
4. Redeploy on Vercel. Both players can now join via `?room=XXXXX` invite links from anywhere!
