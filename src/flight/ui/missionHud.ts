import * as THREE from 'three';
import type { MissionManager } from '../missions/missionManager';
import type { MissionDefinition, MissionId, MissionTelemetry, MissionTone, WaypointMarker } from '../missions/types';

/**
 * JARVIS Mission Selector Drawer, Live Objective HUD & Projected 3D Waypoints.
 *
 * Completely self-contained (DOM + injected CSS) so it integrates with
 * FlightApp with zero edits to hud.ts or screens.css.
 *  - Toggle the Mission Selector drawer with `KeyJ` or the on-screen button /
 *    pause-menu MISSIONS entry.
 *  - While a mission is active, renders an unobtrusive top-left JARVIS card
 *    (objective, progress, timer, stealth / grapple meter, warnings) plus
 *    screen-projected 3D waypoint markers and off-screen edge arrows.
 */

const STYLE_ID = 'jarvis-mission-hud-styles';

const STYLES = /* css */ `
.mh-root {
  --mh-cyan: #7ee8ff;
  --mh-cyan-rgb: 126, 232, 255;
  --mh-amber: #ffc46b;
  --mh-red: #ff6256;
  --mh-green: #64f5a8;
  --mh-ink: #e8f6ff;
  position: fixed;
  inset: 0;
  z-index: 6;
  pointer-events: none;
  font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  color: var(--mh-ink);
  user-select: none;
  -webkit-user-select: none;
}
.mh-root.mh-hidden { opacity: 0; visibility: hidden; transition: opacity 0.28s ease; }

/* ── Top-left Objective HUD & Launcher Chip ── */
.mh-hud {
  position: absolute;
  top: 20px;
  left: 22px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  max-width: min(340px, 44vw);
  transition: opacity 0.25s ease;
}
.mh-hud.off { opacity: 0; pointer-events: none; }

.mh-pill {
  pointer-events: auto;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(4, 14, 24, 0.52);
  border: 1px solid rgba(var(--mh-cyan-rgb), 0.34);
  color: rgba(232, 246, 255, 0.88);
  font-family: Michroma, sans-serif;
  font-size: 9px;
  letter-spacing: 0.26em;
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  transition: border-color 0.18s, background-color 0.18s, color 0.18s;
}
.mh-pill:hover {
  border-color: var(--mh-cyan);
  background: rgba(var(--mh-cyan-rgb), 0.14);
  color: #fff;
}
.mh-pill kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 600;
  color: var(--mh-cyan);
  border: 1px solid rgba(var(--mh-cyan-rgb), 0.4);
  padding: 1px 5px;
  letter-spacing: 0.04em;
}
.mh-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mh-cyan);
  box-shadow: 0 0 8px var(--mh-cyan);
}
.mh-pill.active .mh-pill-dot { background: var(--mh-amber); box-shadow: 0 0 8px var(--mh-amber); }

.mh-card {
  width: 100%;
  padding: 11px 14px 12px;
  background: linear-gradient(135deg, rgba(4, 16, 28, 0.72), rgba(4, 12, 22, 0.56));
  border: 1px solid rgba(var(--mh-cyan-rgb), 0.34);
  border-left: 2px solid var(--mh-cyan);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), inset 0 0 24px rgba(var(--mh-cyan-rgb), 0.06);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.mh-card.hidden { display: none; }
.mh-card.victory { border-left-color: var(--mh-green); border-color: rgba(100, 245, 168, 0.45); }
.mh-card.failed { border-left-color: var(--mh-red); border-color: rgba(255, 98, 86, 0.48); }

.mh-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
}
.mh-code {
  font-family: Michroma, sans-serif;
  font-size: 8.5px;
  letter-spacing: 0.28em;
  color: rgba(var(--mh-cyan-rgb), 0.85);
}
.mh-timer {
  font-size: 11px;
  font-weight: 600;
  color: var(--mh-amber);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
}
.mh-timer.urgent { color: var(--mh-red); animation: mh-pulse 0.7s ease-in-out infinite; }
.mh-obj {
  font-family: Michroma, sans-serif;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: #fff;
  line-height: 1.35;
}
.mh-sub {
  margin-top: 4px;
  font-size: 9.5px;
  color: rgba(232, 246, 255, 0.7);
  letter-spacing: 0.05em;
  line-height: 1.4;
}
.mh-row {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 9.5px;
  letter-spacing: 0.1em;
}
.mh-prog-txt { color: rgba(var(--mh-cyan-rgb), 0.9); font-variant-numeric: tabular-nums; }
.mh-badge {
  padding: 2px 7px;
  font-family: Michroma, sans-serif;
  font-size: 8px;
  letter-spacing: 0.18em;
  border: 1px solid currentColor;
  border-radius: 2px;
}
.mh-tone-cyan { color: var(--mh-cyan); }
.mh-tone-amber { color: var(--mh-amber); }
.mh-tone-red { color: var(--mh-red); }
.mh-tone-green { color: var(--mh-green); }

.mh-bar {
  margin-top: 5px;
  height: 3px;
  width: 100%;
  background: rgba(var(--mh-cyan-rgb), 0.16);
  overflow: hidden;
}
.mh-bar > i {
  display: block;
  height: 100%;
  background: var(--mh-cyan);
  box-shadow: 0 0 8px var(--mh-cyan);
  transition: width 0.12s linear;
}
.mh-meter {
  margin-top: 9px;
  padding-top: 7px;
  border-top: 1px solid rgba(var(--mh-cyan-rgb), 0.14);
}
.mh-meter-head {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  letter-spacing: 0.16em;
  margin-bottom: 4px;
}
.mh-meter-bar {
  height: 5px;
  width: 100%;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.mh-meter-bar > i {
  display: block;
  height: 100%;
  background: currentColor;
  box-shadow: 0 0 10px currentColor;
  transition: width 0.08s linear;
}
.mh-warn {
  margin-top: 8px;
  padding: 5px 8px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: #fff;
  background: rgba(255, 70, 56, 0.24);
  border: 1px solid rgba(255, 98, 86, 0.72);
  animation: mh-pulse 0.8s ease-in-out infinite;
}

/* ── Projected 3D World Waypoints ── */
.mh-waypoints {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.mh-wp {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
}
.mh-wp.hidden { display: none; }
.mh-wp-diamond {
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  transform: rotate(45deg);
  box-shadow: 0 0 8px currentColor;
  background: rgba(2, 12, 20, 0.45);
}
.mh-wp.pulse .mh-wp-diamond { animation: mh-pulse 0.9s ease-in-out infinite; }
.mh-wp-arrow {
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-bottom: 11px solid currentColor;
  filter: drop-shadow(0 0 6px currentColor);
  display: none;
}
.mh-wp.offscreen .mh-wp-diamond { display: none; }
.mh-wp.offscreen .mh-wp-arrow { display: block; }
.mh-wp-lbl {
  font-family: Michroma, sans-serif;
  font-size: 8px;
  letter-spacing: 0.16em;
  color: currentColor;
}
.mh-wp-dist {
  font-size: 9px;
  color: rgba(235, 250, 255, 0.9);
  font-variant-numeric: tabular-nums;
}

/* ── JARVIS Mission Selector Drawer ── */
.mh-drawer-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  pointer-events: auto;
  transition: opacity 0.24s ease, visibility 0s linear 0s;
}
.mh-drawer-wrap.hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.2s ease, visibility 0s linear 0.2s;
}
.mh-scrim {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% 45%, rgba(4, 14, 24, 0.42), rgba(2, 6, 12, 0.8));
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
  cursor: pointer;
}
html.tc-touch .mh-pill,
html.tc-touch .mh-card,
html.tc-touch .mh-scrim {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
html.tc-touch .mh-pill { background: rgba(4, 14, 24, 0.84); }
html.tc-touch .mh-card { background: linear-gradient(135deg, rgba(4, 16, 28, 0.88), rgba(4, 12, 22, 0.82)); }
html.tc-touch .mh-scrim { background: radial-gradient(ellipse at 50% 45%, rgba(4, 14, 24, 0.72), rgba(2, 6, 12, 0.92)); }
.mh-drawer {
  position: relative;
  width: min(820px, 100%);
  max-height: calc(100dvh - 36px);
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(var(--mh-cyan-rgb), 0.08) 0%, rgba(5, 14, 24, 0.88) 28%);
  border: 1px solid rgba(var(--mh-cyan-rgb), 0.34);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.65), 0 0 50px rgba(var(--mh-cyan-rgb), 0.1);
  clip-path: polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px));
  overflow: hidden;
}
.mh-d-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 18px 24px 14px;
  border-bottom: 1px solid rgba(var(--mh-cyan-rgb), 0.16);
}
.mh-d-eyebrow {
  font-family: Michroma, sans-serif;
  font-size: 8.5px;
  letter-spacing: 0.38em;
  color: rgba(var(--mh-cyan-rgb), 0.78);
}
.mh-d-head h2 {
  margin: 4px 0 0;
  font-family: Michroma, sans-serif;
  font-weight: 400;
  font-size: 19px;
  letter-spacing: 0.34em;
  color: #fff;
  text-shadow: 0 0 18px rgba(var(--mh-cyan-rgb), 0.45);
}
.mh-d-actions { display: flex; align-items: center; gap: 10px; }
.mh-btn {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-family: Michroma, sans-serif;
  font-size: 9.5px;
  letter-spacing: 0.22em;
  color: #e8fcff;
  border: 1px solid rgba(var(--mh-cyan-rgb), 0.45);
  background: rgba(var(--mh-cyan-rgb), 0.1);
  transition: background-color 0.16s, border-color 0.16s, color 0.16s;
}
.mh-btn:hover, .mh-btn:focus-visible {
  background: rgba(var(--mh-cyan-rgb), 0.24);
  border-color: var(--mh-cyan);
  color: #fff;
}
.mh-btn.danger {
  border-color: rgba(255, 98, 86, 0.55);
  background: rgba(255, 98, 86, 0.14);
  color: #ffd7d3;
}
.mh-btn.danger:hover { background: rgba(255, 98, 86, 0.3); border-color: var(--mh-red); }

.mh-d-list {
  padding: 16px 22px 20px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  overflow-y: auto;
}
@media (max-width: 680px) {
  .mh-d-list { grid-template-columns: 1fr; }
}
.mh-item {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 14px 15px;
  background: rgba(4, 16, 28, 0.62);
  border: 1px solid rgba(var(--mh-cyan-rgb), 0.2);
  transition: border-color 0.16s, background-color 0.16s, box-shadow 0.16s;
  outline: none;
  cursor: pointer;
}
.mh-item:hover, .mh-item.selected, .mh-item:focus-visible {
  border-color: rgba(var(--mh-cyan-rgb), 0.75);
  background: rgba(var(--mh-cyan-rgb), 0.1);
  box-shadow: 0 0 22px rgba(var(--mh-cyan-rgb), 0.14);
}
.mh-item.running { border-color: var(--mh-amber); }
.mh-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mh-item-code {
  font-family: Michroma, sans-serif;
  font-size: 8.5px;
  letter-spacing: 0.26em;
  color: var(--mh-cyan);
}
.mh-item-tags { display: flex; gap: 6px; align-items: center; }
.mh-tag {
  font-family: Michroma, sans-serif;
  font-size: 7.5px;
  letter-spacing: 0.18em;
  padding: 2px 6px;
  border: 1px solid rgba(var(--mh-cyan-rgb), 0.3);
  color: rgba(232, 246, 255, 0.72);
}
.mh-tag.cleared { border-color: var(--mh-green); color: var(--mh-green); }
.mh-tag.running { border-color: var(--mh-amber); color: var(--mh-amber); }
.mh-tag.standby { border-color: rgba(255, 196, 107, 0.45); color: var(--mh-amber); }
.mh-tag.extreme { border-color: rgba(255, 98, 86, 0.5); color: var(--mh-red); }
.mh-item-title {
  font-family: Michroma, sans-serif;
  font-size: 12px;
  letter-spacing: 0.16em;
  color: #fff;
}
.mh-item-sub {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: rgba(var(--mh-cyan-rgb), 0.72);
}
.mh-item-desc {
  font-size: 10px;
  line-height: 1.48;
  color: rgba(232, 246, 255, 0.74);
  flex: 1 1 auto;
}
.mh-item-foot {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid rgba(var(--mh-cyan-rgb), 0.12);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mh-reward { font-size: 10px; color: var(--mh-amber); letter-spacing: 0.08em; }
.mh-d-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 10px 22px 12px;
  border-top: 1px solid rgba(var(--mh-cyan-rgb), 0.14);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  color: rgba(232, 246, 255, 0.5);
}
.mh-d-foot b { color: var(--mh-cyan); margin-right: 5px; }

@keyframes mh-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
`;

function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

function formatTimer(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} KM` : `${Math.round(m)} M`;
}

function toneClass(tone: MissionTone): string {
  return `mh-tone-${tone}`;
}

interface WaypointNode {
  el: HTMLElement;
  arrow: HTMLElement;
  label: HTMLElement;
  dist: HTMLElement;
}

export interface MissionHudOptions {
  parent?: HTMLElement;
  onRequestOpen: () => void;
  onClose: () => void;
  onLaunch: (id: MissionId) => void;
  onAbort: () => void;
}

export class MissionHud {
  readonly root: HTMLElement;
  private readonly hudEl: HTMLElement;
  private readonly pillEl: HTMLButtonElement;
  private readonly cardEl: HTMLElement;
  private readonly waypointsEl: HTMLElement;
  private readonly drawerWrap: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly abortBtn: HTMLButtonElement;
  private readonly wpPool: WaypointNode[] = [];
  private readonly _proj = new THREE.Vector3();
  private readonly _camSpace = new THREE.Vector3();
  private selectedIndex = 0;
  private _open = false;
  private lastCardSignature = '';

  constructor(
    private readonly manager: MissionManager,
    private readonly opts: MissionHudOptions,
  ) {
    injectStyles();
    const parent = opts.parent ?? document.getElementById('flight-ui') ?? document.body;
    this.root = document.createElement('div');
    this.root.className = 'mh-root';
    this.root.innerHTML = `
      <div class="mh-waypoints" aria-hidden="true"></div>
      <div class="mh-hud off">
        <button type="button" class="mh-pill" data-open-missions>
          <i class="mh-pill-dot" aria-hidden="true"></i>
          <span>MISSIONS</span>
          <kbd>J</kbd>
        </button>
        <div class="mh-card hidden" role="status" aria-live="polite"></div>
      </div>
      <div class="mh-drawer-wrap hidden" role="dialog" aria-modal="true" aria-label="J.A.R.V.I.S. Mission Selector">
        <div class="mh-scrim" data-close-drawer></div>
        <div class="mh-drawer">
          <header class="mh-d-head">
            <div>
              <div class="mh-d-eyebrow">J.A.R.V.I.S. · TACTICAL OPERATIONS</div>
              <h2>MISSIONS</h2>
            </div>
            <div class="mh-d-actions">
              <button type="button" class="mh-btn danger" data-abort-mission hidden>ABORT ACTIVE</button>
              <button type="button" class="mh-btn" data-close-drawer>CLOSE <kbd>J</kbd></button>
            </div>
          </header>
          <div class="mh-d-list"></div>
          <footer class="mh-d-foot">
            <span><b>&#x2191;&#x2193;</b>SELECT</span>
            <span><b>ENTER</b>LAUNCH</span>
            <span><b>J · ESC</b>CLOSE</span>
          </footer>
        </div>
      </div>
    `;
    parent.appendChild(this.root);

    this.waypointsEl = this.root.querySelector('.mh-waypoints')!;
    this.hudEl = this.root.querySelector('.mh-hud')!;
    this.pillEl = this.root.querySelector('[data-open-missions]')!;
    this.cardEl = this.root.querySelector('.mh-card')!;
    this.drawerWrap = this.root.querySelector('.mh-drawer-wrap')!;
    this.listEl = this.root.querySelector('.mh-d-list')!;
    this.abortBtn = this.root.querySelector('[data-abort-mission]')!;

    this.pillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.opts.onRequestOpen();
    });
    for (const el of this.root.querySelectorAll('[data-close-drawer]')) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.opts.onClose();
      });
    }
    this.abortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.opts.onAbort();
      this.renderDrawer();
    });
    this.listEl.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-mission-id]');
      if (!target) return;
      e.stopPropagation();
      const id = target.dataset.missionId as MissionId;
      this.opts.onLaunch(id);
    });
    window.addEventListener('keydown', this.onKeyDown, true);
    this.renderDrawer();
  }

  get open(): boolean {
    return this._open;
  }

  setOpen(open: boolean): void {
    if (this._open === open) return;
    this._open = open;
    this.drawerWrap.classList.toggle('hidden', !open);
    if (open) this.renderDrawer();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this._open) return;
    const defs = this.manager.definitions;
    let handled = true;
    if (e.code === 'Escape' || (e.code === 'KeyJ' && !e.repeat)) {
      this.opts.onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      this.selectedIndex = (this.selectedIndex + 1) % defs.length;
      this.renderDrawer();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      this.selectedIndex = (this.selectedIndex - 1 + defs.length) % defs.length;
      this.renderDrawer();
    } else if (e.key === 'Enter' || e.key === ' ') {
      const def = defs[this.selectedIndex];
      if (def) this.opts.onLaunch(def.id);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  renderDrawer(): void {
    const defs = this.manager.definitions;
    const activeId = this.manager.activeId;
    this.abortBtn.hidden = activeId === null;

    this.listEl.innerHTML = defs
      .map((d: MissionDefinition, i: number) => {
        const isRunning = activeId === d.id;
        const isCleared = this.manager.completed.has(d.id);
        const standby = d.id === 'rival' && !this.manager.rivalAvailable;
        const diffCls = d.difficulty === 'EXTREME' ? ' extreme' : '';
        return `<div class="mh-item${i === this.selectedIndex ? ' selected' : ''}${isRunning ? ' running' : ''}" data-mission-id="${d.id}" tabindex="0">
          <div class="mh-item-top">
            <span class="mh-item-code">${esc(d.code)}</span>
            <div class="mh-item-tags">
              ${isRunning ? '<span class="mh-tag running">ACTIVE</span>' : ''}
              ${isCleared ? '<span class="mh-tag cleared">CLEARED</span>' : ''}
              ${standby ? '<span class="mh-tag standby">STANDBY</span>' : ''}
              <span class="mh-tag${diffCls}">${esc(d.difficulty)}</span>
            </div>
          </div>
          <div class="mh-item-title">${esc(d.title)}</div>
          <div class="mh-item-sub">${esc(d.subtitle)}</div>
          <div class="mh-item-desc">${esc(d.summary)}</div>
          <div class="mh-item-foot">
            <span class="mh-reward">${esc(d.rewardLabel)}</span>
            <button type="button" class="mh-btn" tabindex="-1">${isRunning ? 'RESTART' : 'LAUNCH'}</button>
          </div>
        </div>`;
      })
      .join('');
  }

  /** Update objective card and projected 3D waypoints each frame. */
  update(
    camera: THREE.PerspectiveCamera,
    suitPos: THREE.Vector3,
    telemetry: MissionTelemetry | null,
    visible: boolean,
  ): void {
    this.hudEl.classList.toggle('off', !visible || this._open);
    this.pillEl.classList.toggle('active', this.manager.activeId !== null);

    if (!visible || !telemetry) {
      this.cardEl.classList.add('hidden');
      this.hideAllWaypoints();
      return;
    }

    this.renderCard(telemetry);
    if (this._open || telemetry.phase !== 'active') {
      this.hideAllWaypoints();
    } else {
      this.renderWaypoints(camera, suitPos, telemetry.waypoints);
    }
  }

  private renderCard(t: MissionTelemetry): void {
    this.cardEl.classList.remove('hidden');
    this.cardEl.classList.toggle('victory', t.phase === 'victory');
    this.cardEl.classList.toggle('failed', t.phase === 'failed');

    const sig = JSON.stringify([
      t.code,
      t.phase,
      t.objective,
      t.subObjective,
      t.progressText,
      t.progress01 !== undefined ? Math.round(t.progress01 * 100) : -1,
      t.timerSec != null ? Math.ceil(t.timerSec) : -1,
      t.warning,
      t.badge,
      t.meter ? [t.meter.label, Math.round(t.meter.value * 100), t.meter.tone, t.meter.detail] : null,
    ]);
    if (sig === this.lastCardSignature) return;
    this.lastCardSignature = sig;

    const timerHtml =
      t.timerSec !== undefined && t.timerSec !== null
        ? `<span class="mh-timer${t.timerSec < 15 ? ' urgent' : ''}">ETA ${formatTimer(t.timerSec)}</span>`
        : '';
    const badgeHtml = t.badge ? `<span class="mh-badge ${toneClass(t.badge.tone)}">${esc(t.badge.text)}</span>` : '';
    const progHtml = t.progressText ? `<span class="mh-prog-txt">${esc(t.progressText)}</span>` : '<span></span>';
    const barHtml =
      t.progress01 !== undefined
        ? `<div class="mh-bar"><i style="width:${Math.round(THREE.MathUtils.clamp(t.progress01, 0, 1) * 100)}%"></i></div>`
        : '';
    const meterHtml = t.meter
      ? `<div class="mh-meter ${toneClass(t.meter.tone)}">
          <div class="mh-meter-head"><span>${esc(t.meter.label)}</span><span>${esc(t.meter.detail ?? `${Math.round(t.meter.value * 100)}%`)}</span></div>
          <div class="mh-meter-bar"><i style="width:${Math.round(THREE.MathUtils.clamp(t.meter.value, 0, 1) * 100)}%"></i></div>
        </div>`
      : '';
    const warnHtml = t.warning ? `<div class="mh-warn">${esc(t.warning)}</div>` : '';

    this.cardEl.innerHTML = `
      <div class="mh-card-top">
        <span class="mh-code">${esc(t.code)} · ${esc(t.title)}</span>
        ${timerHtml}
      </div>
      <div class="mh-obj">${esc(t.objective)}</div>
      ${t.subObjective ? `<div class="mh-sub">${esc(t.subObjective)}</div>` : ''}
      ${t.progressText || t.badge ? `<div class="mh-row">${progHtml}${badgeHtml}</div>` : ''}
      ${barHtml}
      ${meterHtml}
      ${warnHtml}
    `;
  }

  private ensureWaypointNode(index: number): WaypointNode {
    while (this.wpPool.length <= index) {
      const el = document.createElement('div');
      el.className = 'mh-wp hidden';
      el.innerHTML = `<i class="mh-wp-diamond"></i><i class="mh-wp-arrow"></i><span class="mh-wp-lbl"></span><span class="mh-wp-dist"></span>`;
      this.waypointsEl.appendChild(el);
      this.wpPool.push({
        el,
        arrow: el.querySelector('.mh-wp-arrow')!,
        label: el.querySelector('.mh-wp-lbl')!,
        dist: el.querySelector('.mh-wp-dist')!,
      });
    }
    return this.wpPool[index];
  }

  private hideAllWaypoints(): void {
    for (const n of this.wpPool) n.el.classList.add('hidden');
  }

  private renderWaypoints(
    camera: THREE.PerspectiveCamera,
    suitPos: THREE.Vector3,
    waypoints: readonly WaypointMarker[],
  ): void {
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    const pad = 42;

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const node = this.ensureWaypointNode(i);
      const dist = suitPos.distanceTo(wp.pos);

      this._camSpace.copy(wp.pos).applyMatrix4(camera.matrixWorldInverse);
      const behind = this._camSpace.z > -0.1;
      this._proj.copy(wp.pos).project(camera);

      let sx = (this._proj.x * 0.5 + 0.5) * w;
      let sy = (-this._proj.y * 0.5 + 0.5) * h;

      const onScreen = !behind && sx >= pad && sx <= w - pad && sy >= pad && sy <= h - pad;
      if (!onScreen) {
        // Compute screen-edge clamp along direction from screen centre
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
        node.arrow.style.transform = `rotate(${ang + Math.PI / 2}rad)`;
      }

      node.el.className = `mh-wp ${toneClass(wp.color)}${wp.pulse ? ' pulse' : ''}${onScreen ? '' : ' offscreen'}`;
      node.el.style.left = `${sx.toFixed(1)}px`;
      node.el.style.top = `${sy.toFixed(1)}px`;
      node.label.textContent = wp.label;
      node.dist.textContent = wp.detail ? `${formatDist(dist)} · ${wp.detail}` : formatDist(dist);
    }

    for (let i = waypoints.length; i < this.wpPool.length; i++) {
      this.wpPool[i].el.classList.add('hidden');
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.root.remove();
  }
}
