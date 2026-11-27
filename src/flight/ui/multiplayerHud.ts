import * as THREE from 'three';
import type { MultiplayerSession, MultiplayerSnapshot } from '../net/multiplayer';
import { sanitizeRoomCode } from '../net/protocol';
import { ensureTacticalDock } from './tacticalDock';

/**
 * Self-contained JARVIS Multiplayer Lobby Drawer, Top-Left Uplink Chip, and
 * Live 3D Projected Wingman / Opponent Marker Overlay.
 *
 * Mounts its uplink pill and live peer chip into the shared top-left tactical
 * dock (`tacticalDock.ts`) and matches the chamfered holographic drawer style.
 */

const STYLE_ID = 'jarvis-mp-hud-styles';

const STYLES = /* css */ `
.mp-root {
  --mp-cyan: #7ee8ff;
  --mp-cyan-rgb: 126, 232, 255;
  --mp-amber: #ffc46b;
  --mp-red: #ff6256;
  --mp-green: #64f5a8;
  --mp-ink: #e8f6ff;
  position: fixed;
  inset: 0;
  z-index: 7;
  pointer-events: none;
  font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  color: var(--mp-ink);
  user-select: none;
  -webkit-user-select: none;
}

/* ── Top-left Uplink Pill State & Sub-chip ── */
.mp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(var(--mp-cyan-rgb), 0.5);
}
.mp-pill.online .mp-dot { background: var(--mp-green); box-shadow: 0 0 8px var(--mp-green); }
.mp-pill.duel.online .mp-dot { background: var(--mp-red); box-shadow: 0 0 8px var(--mp-red); }
.mp-pill.connecting .mp-dot { background: var(--mp-amber); box-shadow: 0 0 8px var(--mp-amber); }

.mp-chip-sub {
  font-size: 9px;
  line-height: 1.35;
  letter-spacing: 0.08em;
  padding: 7px 14px;
  background: rgba(4, 14, 24, 0.62);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.25);
  border-left: 2px solid var(--mp-green);
  color: rgba(232, 246, 255, 0.88);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  transition: opacity 0.2s ease;
}
.mp-chip-sub.duel { border-left-color: var(--mp-red); }
.mp-chip-sub.hidden { display: none; }
.mp-chip-sub.off { opacity: 0; pointer-events: none; }

/* ── 3D Projected Wingman / Opponent Marker ── */
.mp-marker {
  position: fixed;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  pointer-events: none;
  color: var(--mp-green);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.9);
}
.mp-marker.duel { color: var(--mp-red); }
.mp-marker.hidden { display: none; }

.mp-diamond {
  width: 15px;
  height: 15px;
  border: 1.5px solid currentColor;
  transform: rotate(45deg);
  box-shadow: 0 0 10px currentColor, inset 0 0 6px currentColor;
}
.mp-marker.offscreen .mp-diamond { display: none; }

.mp-arrow {
  display: none;
  width: 0;
  height: 0;
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  border-bottom: 13px solid currentColor;
  filter: drop-shadow(0 0 6px currentColor);
}
.mp-marker.offscreen .mp-arrow { display: block; }

.mp-m-lbl {
  font-family: Michroma, sans-serif;
  font-size: 9px;
  letter-spacing: 0.16em;
  white-space: nowrap;
}
.mp-m-dist {
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  opacity: 0.88;
  white-space: nowrap;
}

/* ── JARVIS Multiplayer Drawer ── */
.mp-drawer {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(2, 8, 16, 0.62);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  pointer-events: auto;
  opacity: 1;
  transition: opacity 0.2s ease;
}
html.tc-touch .mp-chip-sub,
html.tc-touch .mp-drawer {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
html.tc-touch .mp-chip-sub { background: rgba(4, 14, 24, 0.86); }
html.tc-touch .mp-drawer { background: rgba(2, 8, 16, 0.86); }
.mp-drawer.hidden {
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0s linear 0.2s;
}

.mp-panel {
  position: relative;
  box-sizing: border-box;
  width: min(720px, 94vw);
  max-height: calc(100dvh - 36px);
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(var(--mp-cyan-rgb), 0.08) 0%, rgba(5, 14, 24, 0.88) 28%);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.34);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 28px 80px rgba(0, 0, 0, 0.65), 0 0 50px rgba(var(--mp-cyan-rgb), 0.1);
  clip-path: polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 22px 100%, 0 calc(100% - 22px));
  overflow: hidden;
}
.mp-corner {
  position: absolute;
  width: 16px;
  height: 16px;
  border: 0 solid var(--mp-cyan);
  opacity: 0.8;
  pointer-events: none;
}
.mp-corner.tl { top: 6px; left: 6px; border-top-width: 1px; border-left-width: 1px; }
.mp-corner.br { bottom: 6px; right: 6px; border-bottom-width: 1px; border-right-width: 1px; }

.mp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 18px 24px 14px;
  border-bottom: 1px solid rgba(var(--mp-cyan-rgb), 0.16);
  flex: none;
}
.mp-body {
  padding: 16px 24px 18px;
  overflow-y: auto;
  min-height: 0;
}
.mp-eyebrow {
  font-family: Michroma, sans-serif;
  font-size: 8.5px;
  letter-spacing: 0.36em;
  color: rgba(var(--mp-cyan-rgb), 0.78);
}
.mp-title {
  margin: 4px 0 0;
  font-family: Michroma, sans-serif;
  font-weight: 400;
  font-size: 18px;
  letter-spacing: 0.26em;
  color: #fff;
  text-shadow: 0 0 18px rgba(var(--mp-cyan-rgb), 0.4);
}
.mp-close {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(var(--mp-cyan-rgb), 0.1);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.42);
  color: #e8fcff;
  font-family: Michroma, sans-serif;
  font-size: 9.5px;
  letter-spacing: 0.22em;
  padding: 8px 14px;
  transition: background-color 0.16s, border-color 0.16s, color 0.16s;
}
.mp-close:hover,
.mp-close:focus-visible {
  outline: none;
  background: rgba(var(--mp-cyan-rgb), 0.24);
  border-color: var(--mp-cyan);
  color: #fff;
}
.mp-close kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: rgba(var(--mp-cyan-rgb), 0.75);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.35);
  padding: 1px 5px;
}

.mp-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 16px;
}
@media (max-width: 640px) {
  .mp-cols { grid-template-columns: 1fr; }
  .mp-grid2 { grid-template-columns: 1fr; }
}
.mp-section { margin-top: 14px; }
.mp-section:first-child { margin-top: 0; }
.mp-label {
  font-family: Michroma, sans-serif;
  font-size: 8.5px;
  letter-spacing: 0.28em;
  color: rgba(var(--mp-cyan-rgb), 0.75);
  margin-bottom: 8px;
}

.mp-grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.mp-choice {
  cursor: pointer;
  text-align: left;
  padding: 11px 13px;
  background: rgba(8, 22, 36, 0.65);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.24);
  color: var(--mp-ink);
  transition: border-color 0.16s, background-color 0.16s, box-shadow 0.16s;
}
.mp-choice:hover { border-color: rgba(var(--mp-cyan-rgb), 0.65); }
.mp-choice.on {
  border-color: var(--mp-cyan);
  background: rgba(var(--mp-cyan-rgb), 0.14);
  box-shadow: inset 0 0 18px rgba(var(--mp-cyan-rgb), 0.14);
}
.mp-choice.wm.on {
  border-color: var(--mp-amber);
  background: rgba(255, 196, 107, 0.12);
  box-shadow: inset 0 0 18px rgba(255, 196, 107, 0.14);
}
.mp-choice.duel.on {
  border-color: var(--mp-red);
  background: rgba(255, 98, 86, 0.12);
  box-shadow: inset 0 0 18px rgba(255, 98, 86, 0.14);
}
.mp-choice-title {
  font-family: Michroma, sans-serif;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: #fff;
}
.mp-choice-sub {
  margin-top: 4px;
  font-size: 10px;
  color: rgba(232, 246, 255, 0.68);
  line-height: 1.35;
}

.mp-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.mp-input {
  flex: 1;
  min-width: 140px;
  background: rgba(3, 12, 22, 0.85);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.36);
  color: #fff;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 9px 12px;
  outline: none;
}
.mp-input:focus { border-color: var(--mp-cyan); box-shadow: 0 0 12px rgba(var(--mp-cyan-rgb), 0.2); }

.mp-btn {
  cursor: pointer;
  padding: 9px 14px;
  background: rgba(var(--mp-cyan-rgb), 0.12);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.45);
  color: #fff;
  font-family: Michroma, sans-serif;
  font-size: 9.5px;
  letter-spacing: 0.18em;
  transition: background-color 0.15s, border-color 0.15s;
}
.mp-btn:hover { background: rgba(var(--mp-cyan-rgb), 0.24); border-color: var(--mp-cyan); }
.mp-btn.primary {
  background: rgba(var(--mp-cyan-rgb), 0.24);
  border-color: var(--mp-cyan);
}
.mp-btn.danger {
  background: rgba(255, 98, 86, 0.14);
  border-color: rgba(255, 98, 86, 0.55);
  color: #ffd3cf;
}
.mp-btn.danger:hover { background: rgba(255, 98, 86, 0.28); }

.mp-status-box {
  margin-top: 14px;
  padding: 12px 14px;
  background: rgba(3, 12, 22, 0.72);
  border: 1px solid rgba(var(--mp-cyan-rgb), 0.24);
  border-left: 2px solid var(--mp-cyan);
  font-size: 10.5px;
  line-height: 1.55;
}
.mp-status-box.online { border-left-color: var(--mp-green); }
.mp-status-box.error { border-left-color: var(--mp-red); }
.mp-status-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-family: Michroma, sans-serif;
  font-size: 9.5px;
  letter-spacing: 0.16em;
}
.mp-room-code {
  color: var(--mp-cyan);
  font-size: 13px;
  letter-spacing: 0.22em;
}
.mp-note {
  margin-top: 10px;
  font-size: 10px;
  color: rgba(232, 246, 255, 0.62);
  line-height: 1.45;
}
.mp-copied {
  color: var(--mp-green);
  font-size: 10px;
  letter-spacing: 0.1em;
}
`;

export interface MultiplayerHudCallbacks {
  onRequestOpen: () => void;
  onClose: () => void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export class MultiplayerHud {
  private readonly root: HTMLElement;
  private readonly pillEl: HTMLButtonElement;
  private readonly chipSubEl: HTMLElement;
  private readonly markerEl: HTMLElement;
  private readonly arrowEl: HTMLElement;
  private readonly mLabelEl: HTMLElement;
  private readonly mDistEl: HTMLElement;
  private readonly drawerEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private _open = false;
  private copiedMsg = '';
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsub: () => void;
  private readonly _camSpace = new THREE.Vector3();
  private readonly _proj = new THREE.Vector3();

  constructor(
    private readonly session: MultiplayerSession,
    private readonly cb: MultiplayerHudCallbacks,
  ) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    const parent = document.getElementById('flight-ui') ?? document.body;
    const dock = ensureTacticalDock(parent);

    this.root = document.createElement('div');
    this.root.className = 'mp-root';
    this.root.innerHTML = `
      <div class="mp-marker hidden">
        <i class="mp-diamond"></i>
        <i class="mp-arrow"></i>
        <span class="mp-m-lbl"></span>
        <span class="mp-m-dist"></span>
      </div>
      <div class="mp-drawer hidden" role="dialog" aria-modal="true" aria-label="Multiplayer Uplink">
        <div class="mp-panel">
          <i class="mp-corner tl" aria-hidden="true"></i><i class="mp-corner br" aria-hidden="true"></i>
          <div class="mp-head">
            <div>
              <div class="mp-eyebrow">J.A.R.V.I.S. · TACTICAL UPLINK</div>
              <h2 class="mp-title">IRON MAN + WAR MACHINE</h2>
            </div>
            <button type="button" class="mp-close" data-act="close">CLOSE <kbd>ESC</kbd></button>
          </div>
          <div class="mp-body"></div>
        </div>
      </div>
    `;
    // Inside the flight UI layer (as the missions HUD is): on the workshop
    // handoff, everything else on <body> is faded out and sits under the sim.
    parent.appendChild(this.root);

    this.pillEl = document.createElement('button');
    this.pillEl.type = 'button';
    this.pillEl.className = 'ftd-pill mp-pill off';
    this.pillEl.innerHTML = `<i class="mp-dot" aria-hidden="true"></i><span class="mp-pill-txt">MULTIPLAYER</span><kbd>M</kbd>`;
    dock.pills.appendChild(this.pillEl);

    this.chipSubEl = document.createElement('div');
    this.chipSubEl.className = 'mp-chip-sub hidden';
    dock.stack.appendChild(this.chipSubEl);

    this.markerEl = this.root.querySelector('.mp-marker')!;
    this.arrowEl = this.root.querySelector('.mp-arrow')!;
    this.mLabelEl = this.root.querySelector('.mp-m-lbl')!;
    this.mDistEl = this.root.querySelector('.mp-m-dist')!;
    this.drawerEl = this.root.querySelector('.mp-drawer')!;
    this.bodyEl = this.root.querySelector('.mp-body')!;

    this.pillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onRequestOpen();
    });

    this.drawerEl.addEventListener('click', (e) => {
      if (e.target === this.drawerEl) {
        this.cb.onClose();
        return;
      }
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!btn) return;
      this.handleAction(btn.dataset.act!, btn.dataset.val);
    });

    this.drawerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).classList.contains('mp-input')) {
        e.preventDefault();
        this.handleAction('join');
      }
    });

    window.addEventListener('keydown', this.onKeyDown, true);
    this.unsub = this.session.onChange(() => this.render());
    this.render();
  }

  get open(): boolean {
    return this._open;
  }

  setOpen(open: boolean): void {
    this._open = open;
    this.drawerEl.classList.toggle('hidden', !open);
    if (open) this.render();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this._open) return;
    const inInput = (document.activeElement as HTMLElement | null)?.tagName === 'INPUT';
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cb.onClose();
      return;
    }
    if (e.code === 'KeyM' && !e.repeat && !inInput) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cb.onClose();
    }
  };

  private handleAction(act: string, val?: string): void {
    switch (act) {
      case 'close':
        this.cb.onClose();
        break;
      case 'suit':
        if (val === 'ironman' || val === 'warmachine') this.session.setSuit(val);
        break;
      case 'mode':
        if (val === 'coop' || val === 'duel') this.session.setMode(val);
        break;
      case 'backend':
        if (val === 'websocket' || val === 'local') this.session.setBackend(val);
        break;
      case 'host':
        this.session.hostRoom();
        break;
      case 'join': {
        const input = this.bodyEl.querySelector<HTMLInputElement>('.mp-input:not(.mp-invite)');
        const code = sanitizeRoomCode(input?.value ?? '');
        if (code) this.session.joinRoom(code);
        break;
      }
      case 'leave':
        this.session.leaveRoom();
        break;
      case 'copy': {
        const url = this.session.inviteUrl();
        if (!url) break;
        // navigator.clipboard only exists on secure origins (https / localhost), not http://<LAN-IP>.
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(url).then(
            () => this.flashCopied('INVITE LINK COPIED'),
            () => this.copyFallback(url),
          );
        } else {
          this.copyFallback(url);
        }
        break;
      }
      case 'openTab': {
        const url = this.session.inviteUrl();
        if (url) window.open(url, '_blank');
        break;
      }
    }
  }

  /** Legacy execCommand copy for insecure origins; if even that fails, the link stays visible to copy by hand. */
  private copyFallback(url: string): void {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    this.flashCopied(ok ? 'INVITE LINK COPIED' : 'COPY BLOCKED · SELECT LINK BELOW');
  }

  private flashCopied(msg: string): void {
    this.copiedMsg = msg;
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.copiedMsg = '';
      this.render();
    }, 2400);
    this.render();
  }

  private render(): void {
    const s: MultiplayerSnapshot = this.session.snapshot();

    // Update top-left pill
    this.pillEl.classList.toggle('online', s.connected);
    this.pillEl.classList.toggle('connecting', s.status === 'connecting');
    this.pillEl.classList.toggle('duel', s.mode === 'duel');
    const pillTxt = this.pillEl.querySelector('.mp-pill-txt')!;
    pillTxt.textContent = s.connected
      ? `ROOM ${s.room}${s.peer ? ' · 2/2' : ' · 1/2'}`
      : s.suit === 'warmachine'
        ? 'WAR MACHINE'
        : 'MULTIPLAYER';

    if (s.connected) {
      this.chipSubEl.classList.remove('hidden');
      this.chipSubEl.classList.toggle('duel', s.mode === 'duel');
      const score = this.session.duel;
      const modeTag = s.mode === 'duel' ? (score ? `1v1 DUEL ${score.me}–${score.them}` : '1v1 DUEL') : 'CO-OP';
      const peerText = s.peer
        ? `${s.peer.suit === 'warmachine' ? 'WAR MACHINE' : 'IRON MAN'} (${s.peer.callsign}) · ${s.rttMs} ms`
        : 'WAITING FOR 2ND PILOT...';
      this.chipSubEl.textContent = `${modeTag} · ${peerText}`;
    } else {
      this.chipSubEl.classList.add('hidden');
    }

    if (!this._open) return;

    const prevInput = this.bodyEl.querySelector<HTMLInputElement>('.mp-input:not(.mp-invite)')?.value ?? '';
    const statusCls = s.status === 'connected' ? 'online' : s.status === 'error' ? 'error' : '';
    const peerHtml = s.peer
      ? `<div>PEER: <strong>${s.peer.suit === 'warmachine' ? 'WAR MACHINE MK II' : 'IRON MAN MK III'}</strong> (${esc(s.peer.callsign)}) · ${formatDist(s.peer.distance)} · ${s.rttMs} ms</div>`
      : s.connected
        ? `<div>PEER: <em>Awaiting second pilot — copy invite link or open a 2nd tab</em></div>`
        : '';

    this.bodyEl.innerHTML = `
      <div class="mp-section">
        <div class="mp-label">ARMOUR CHASSIS (LIVE SWAP)</div>
        <div class="mp-grid2">
          <button type="button" class="mp-choice${s.suit === 'ironman' ? ' on' : ''}" data-act="suit" data-val="ironman">
            <div class="mp-choice-title">IRON MAN · MK III</div>
            <div class="mp-choice-sub">Repulsors, chest unibeam, micro-missiles, agile interceptor</div>
          </button>
          <button type="button" class="mp-choice wm${s.suit === 'warmachine' ? ' on' : ''}" data-act="suit" data-val="warmachine">
            <div class="mp-choice-title">WAR MACHINE · MK II</div>
            <div class="mp-choice-sub">Twin 20 mm cannons, M134 Vulcan, 6-tube pod, bunker-busters</div>
          </button>
        </div>
      </div>

      <div class="mp-section mp-cols">
        <div>
          <div class="mp-label">SORTIE PROTOCOL</div>
          <div class="mp-grid2">
            <button type="button" class="mp-choice${s.mode === 'coop' ? ' on' : ''}" data-act="mode" data-val="coop">
              <div class="mp-choice-title">CO-OP</div>
              <div class="mp-choice-sub">Friendly formation &amp; shared airspace</div>
            </button>
            <button type="button" class="mp-choice duel${s.mode === 'duel' ? ' on' : ''}" data-act="mode" data-val="duel">
              <div class="mp-choice-title">1V1 DUEL</div>
              <div class="mp-choice-sub">Head-to-head combat with hostile IFF</div>
            </button>
          </div>
        </div>
        <div>
          <div class="mp-label">NETWORK LINK</div>
          <div class="mp-grid2">
            <button type="button" class="mp-choice${s.backend === 'websocket' ? ' on' : ''}" data-act="backend" data-val="websocket">
              <div class="mp-choice-title">ONLINE (WS)</div>
              <div class="mp-choice-sub">Relay server or <code>npm run mp:dev</code></div>
            </button>
            <button type="button" class="mp-choice${s.backend === 'local' ? ' on' : ''}" data-act="backend" data-val="local">
              <div class="mp-choice-title">LOCAL 2-TAB</div>
              <div class="mp-choice-sub">Same-browser BroadcastChannel test</div>
            </button>
          </div>
        </div>
      </div>

      <div class="mp-section">
        <div class="mp-label">ROOM UPLINK</div>
        ${
          s.connected || s.status === 'connecting'
            ? `<div class="mp-row">
                <button type="button" class="mp-btn primary" data-act="copy">COPY INVITE LINK</button>
                <button type="button" class="mp-btn" data-act="openTab">OPEN 2ND TAB</button>
                <button type="button" class="mp-btn danger" data-act="leave">LEAVE ROOM</button>
                ${this.copiedMsg ? `<span class="mp-copied">${esc(this.copiedMsg)}</span>` : ''}
              </div>
              <input class="mp-input mp-invite" type="text" readonly value="${esc(this.session.inviteUrl())}" aria-label="Invite link" style="width:100%;margin-top:8px;text-transform:none;letter-spacing:normal" onfocus="this.select()">`
            : `<div class="mp-row">
                <button type="button" class="mp-btn primary" data-act="host">HOST NEW ROOM</button>
                <input class="mp-input" type="text" maxlength="12" placeholder="ROOM CODE" value="${esc(prevInput)}" aria-label="Room code">
                <button type="button" class="mp-btn" data-act="join">JOIN ROOM</button>
              </div>`
        }
      </div>

      <div class="mp-status-box ${statusCls}">
        <div class="mp-status-top">
          <span>STATUS · ${esc(s.detail)}</span>
          ${s.room ? `<span class="mp-room-code">ROOM ${esc(s.room)} (${s.role.toUpperCase()})</span>` : `<span>${esc(s.endpoint)}</span>`}
        </div>
        ${peerHtml}
      </div>

      <div class="mp-note">
        Sim stays live while connected. Press <strong>ESC</strong> or <strong>M</strong> to return to flight, or click <strong>HOST NEW ROOM</strong> then <strong>OPEN 2ND TAB</strong> to test solo.
      </div>
    `;
  }

  /** Update top-left chip visibility and projected 3D marker for the remote pilot. */
  update(camera: THREE.PerspectiveCamera, localPos: THREE.Vector3, visible: boolean, menuOpen = false): void {
    const show = visible && !this._open;
    this.pillEl.classList.toggle('off', !show);
    this.chipSubEl.classList.toggle('off', !show);

    const peer = this.session.peer;
    if (!visible || menuOpen || this._open || !peer || !peer.mesh.visible) {
      this.markerEl.classList.add('hidden');
      return;
    }

    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    const pad = 44;

    const targetPos = peer.pos;
    const dist = localPos.distanceTo(targetPos);

    this._camSpace.copy(targetPos).applyMatrix4(camera.matrixWorldInverse);
    const behind = this._camSpace.z > -0.1;
    this._proj.copy(targetPos).project(camera);

    let sx = (this._proj.x * 0.5 + 0.5) * w;
    let sy = (-this._proj.y * 0.5 + 0.5) * h;

    const onScreen = !behind && sx >= pad && sx <= w - pad && sy >= pad && sy <= h - pad;
    if (!onScreen) {
      const dx = this._camSpace.x;
      const dy = -this._camSpace.y;
      const ang = Math.atan2(dy, dx);
      const rx = w * 0.5 - pad;
      const ry = h * 0.5 - pad;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const scale = Math.min(Math.abs(rx / (c || 1e-6)), Math.abs(ry / (s || 1e-6)));
      sx = w * 0.5 + c * scale;
      sy = h * 0.5 + s * scale;
      this.arrowEl.style.transform = `rotate(${ang + Math.PI / 2}rad)`;
    }

    const isDuel = this.session.mode === 'duel';
    this.markerEl.className = `mp-marker${isDuel ? ' duel' : ''}${onScreen ? '' : ' offscreen'}`;
    this.markerEl.style.left = `${sx.toFixed(1)}px`;
    this.markerEl.style.top = `${sy.toFixed(1)}px`;

    const suitTag = peer.variant === 'warmachine' ? 'WAR MACHINE' : 'IRON MAN';
    this.mLabelEl.textContent = `${suitTag} · ${peer.callsign}`;
    // (just the range: their airspeed is theirs to know)
    this.mDistEl.textContent = formatDist(dist);
  }

  dispose(): void {
    this.unsub();
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.pillEl.remove();
    this.chipSubEl.remove();
    this.root.remove();
  }
}
