/**
 * Shared top-left tactical dock for floating flight HUD chips (`MISSIONS`,
 * `MULTIPLAYER`) and their stacked status cards. Keeps chips side-by-side
 * without hardcoded pixel offsets and shifts cleanly below touch buttons.
 */

const DOCK_STYLE_ID = 'flight-tactical-dock-styles';

const DOCK_STYLES = /* css */ `
.ftd-dock {
  --ftd-cyan: #7ee8ff;
  --ftd-cyan-rgb: 126, 232, 255;
  position: fixed;
  top: calc(18px + env(safe-area-inset-top, 0px));
  left: calc(22px + env(safe-area-inset-left, 0px));
  z-index: 7;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  max-width: min(360px, calc(100vw - 44px));
  pointer-events: none;
  font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  color: #e8f6ff;
  user-select: none;
  -webkit-user-select: none;
}
#flight-ui.touch .ftd-dock {
  top: calc(68px + env(safe-area-inset-top, 0px));
  left: calc(14px + env(safe-area-inset-left, 0px));
}
.ftd-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ftd-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
}
.ftd-pill {
  pointer-events: auto;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 11px;
  line-height: 1;
  background: rgba(4, 14, 24, 0.54);
  border: 1px solid rgba(var(--ftd-cyan-rgb), 0.34);
  color: rgba(232, 246, 255, 0.9);
  font-family: Michroma, sans-serif;
  font-size: 9px;
  letter-spacing: 0.22em;
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
  transition: border-color 0.18s, background-color 0.18s, color 0.18s, opacity 0.25s;
}
.ftd-pill:hover,
.ftd-pill:focus-visible {
  outline: none;
  border-color: var(--ftd-cyan);
  background: rgba(var(--ftd-cyan-rgb), 0.14);
  color: #fff;
}
.ftd-pill.off {
  opacity: 0;
  pointer-events: none;
}
.ftd-pill kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 600;
  color: var(--ftd-cyan);
  border: 1px solid rgba(var(--ftd-cyan-rgb), 0.4);
  padding: 1px 5px;
  letter-spacing: 0.04em;
}
/* The face's tracking trails the last letter: pulled back so the label
   sits centred between the dot and the key cap, the same in every browser */
.ftd-pill > span {
  display: inline-block;
  line-height: 1;
  margin-right: -0.22em;
  padding-top: 1px;
}
/* Status dots stay round (a squeezed flex item drew them as ovals) */
.ftd-pill > i {
  flex: none;
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.ftd-pill kbd { line-height: 1.3; flex: none; }
/* Cards under the pills share one width and inset */
.ftd-stack > * {
  box-sizing: border-box;
  width: min(330px, 44vw);
  max-width: 100%;
}
html.tc-touch .ftd-pill {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background: rgba(4, 14, 24, 0.84);
}
html.tc-touch .ftd-pill kbd {
  display: none;
}
`;

export interface TacticalDock {
  dock: HTMLElement;
  pills: HTMLElement;
  stack: HTMLElement;
}

export function ensureTacticalDock(parent: HTMLElement): TacticalDock {
  if (typeof document !== 'undefined' && !document.getElementById(DOCK_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = DOCK_STYLE_ID;
    style.textContent = DOCK_STYLES;
    document.head.appendChild(style);
  }
  let dock = parent.querySelector<HTMLElement>(':scope > .ftd-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'ftd-dock';
    dock.innerHTML = `<div class="ftd-pills"></div><div class="ftd-stack"></div>`;
    parent.appendChild(dock);
  }
  return {
    dock,
    pills: dock.querySelector<HTMLElement>('.ftd-pills')!,
    stack: dock.querySelector<HTMLElement>('.ftd-stack')!,
  };
}
