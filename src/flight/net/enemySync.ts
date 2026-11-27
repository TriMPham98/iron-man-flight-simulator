import * as THREE from 'three';
import type { Combat } from '../combat/combat';
import { Dreadnought } from '../combat/dreadnought';
import { Drone, type DroneType } from '../combat/drones';
import { Frigate } from '../combat/frigate';
import { RivalSuit } from '../combat/rivalSuit';
import { SamSite } from '../combat/sams';
import type { DamageKind, Hostile } from '../combat/types';
import { inCosmeticScope } from './netDamage';
import { encodeWorldState, NetBodyClass, type NetBody, type NetEvent, type PlayerRole, type WorldNetState } from './protocol';

/** Host → guest enemy snapshots (Hz). */
const WORLD_HZ = 15;
/** Guest → host damage batches (Hz). */
const DAMAGE_HZ = 20;
/** Dead reckoning past the last snapshot, at most (s). */
const MAX_EXTRAPOLATE = 0.35;
/** The puppet closes on the host's pose with this time constant (s)… */
const CONVERGE = 0.08;
/** …unless it is this far off (m): then it jumps. */
const SNAP_DIST = 80;
/** Gone from the host's snapshots this long (s): gone here too. */
const VANISH_AFTER = 0.6;

type Body = Drone | SamSite | Frigate | Dreadnought | RivalSuit;
type DamageFn = (amount: number, at: THREE.Vector3, kind: DamageKind) => boolean;

const DRONE_CLS: Record<DroneType, number> = {
  drone: NetBodyClass.DRONE,
  interceptor: NetBodyClass.INTERCEPTOR,
  bomber: NetBodyClass.BOMBER,
  jammer: NetBodyClass.JAMMER,
};
const CLS_DRONE: Record<number, DroneType> = {
  [NetBodyClass.DRONE]: 'drone',
  [NetBodyClass.INTERCEPTOR]: 'interceptor',
  [NetBodyClass.BOMBER]: 'bomber',
  [NetBodyClass.JAMMER]: 'jammer',
};

function partsOf(b: Body): readonly Hostile[] | null {
  return b instanceof Frigate || b instanceof Dreadnought ? b.parts : null;
}

/** A guest's puppet of one host enemy, and the last pose the host sent for it. */
interface Puppet {
  id: number;
  cls: number;
  body: Body;
  tgt: NetBody;
  /** Local clock when {@link tgt} arrived. */
  at: number;
  lastSeen: number;
  readonly pos: THREE.Vector3;
  readonly meshQ: THREE.Quaternion;
}

/**
 * One fight across two sims. The host runs the only real enemy AI and streams
 * every enemy's pose, health and life; the guest flies puppets of the same
 * classes (same models, same exhaust, same deaths) at those poses. Each
 * pilot scores their own shots: the guest's hits on a puppet are sent to the
 * host to land on the real enemy, and a wingman's cosmetic weapon copy hits
 * nothing (see netDamage). Each pilot takes enemy fire in their own sim.
 */
export class EnemySync {
  role: PlayerRole = 'host';
  private clock = 0;
  private worldAcc = 0;
  private dmgAcc = 0;

  // Host: stable network ids for live enemies
  private nextId = 1;
  private readonly ids = new WeakMap<Body, number>();
  private readonly byId = new Map<number, Body>();

  // Guest: puppets by host id, and where each puppet hostile reports its damage
  private readonly puppets = new Map<number, Puppet>();
  private readonly route = new WeakMap<Hostile, [number, number]>();
  private readonly pending = new Map<string, [number, number, number, string]>();

  // Both: every hostile's own damage(), under the authority wrapper
  private readonly own = new WeakMap<Hostile, DamageFn>();

  constructor(private readonly combat: Combat) {}

  /** Re-seat for a new room / role: puppets dropped, ids fresh. */
  reset(role: PlayerRole): void {
    this.role = role;
    this.puppets.clear();
    this.pending.clear();
    this.byId.clear();
    this.worldAcc = this.dmgAcc = 0;
    this.combat.puppet = role === 'guest';
    if (role === 'guest') this.combat.clearHostiles();
  }

  /** Back to solo: the enemies (if any are left) are this sim's own again. */
  detach(): void {
    this.role = 'host';
    this.combat.puppet = false;
    this.puppets.clear();
    this.pending.clear();
  }

  /** The guest became the host (the host left): the puppets fly on as real enemies. */
  promote(): void {
    this.role = 'host';
    this.combat.puppet = false;
    this.puppets.clear();
    this.pending.clear();
  }

  /**
   * Per frame, after the combat update. Returns a world snapshot to send
   * (host) and/or a damage batch (guest), when one is due.
   */
  update(dt: number, connected: boolean): { world?: ArrayBuffer; damage?: NetEvent } {
    this.clock += dt;
    this.guardAll();
    const out: { world?: ArrayBuffer; damage?: NetEvent } = {};
    if (!connected) return out;
    if (this.role === 'host') {
      this.worldAcc += dt;
      if (this.worldAcc >= 1 / WORLD_HZ) {
        this.worldAcc %= 1 / WORLD_HZ;
        out.world = encodeWorldState(this.snapshot());
      }
    } else {
      this.posePuppets(dt);
      this.dmgAcc += dt;
      if (this.dmgAcc >= 1 / DAMAGE_HZ) {
        this.dmgAcc %= 1 / DAMAGE_HZ;
        if (this.pending.size) {
          out.damage = { kind: 'dmg', hits: [...this.pending.values()] };
          this.pending.clear();
        }
      }
    }
    return out;
  }

  // ── Damage authority ──────────────────────────────────────────────────────

  /** Every hostile's damage() goes through {@link gate} (wrapped once, on first sight). */
  private guardAll(): void {
    for (const h of this.combat.hostiles) this.guard(h);
  }

  private guard(h: Hostile): void {
    if (this.own.has(h)) return;
    const own = h.damage.bind(h) as DamageFn;
    this.own.set(h, own);
    (h as { damage: DamageFn }).damage = (amount, at, kind) => this.gate(h, own, amount, at, kind);
  }

  private gate(h: Hostile, own: DamageFn, amount: number, at: THREE.Vector3, kind: DamageKind): boolean {
    if (inCosmeticScope()) return false;
    if (this.role === 'guest' && this.combat.puppet) {
      const r = this.route.get(h);
      if (r && h.alive && amount > 0) {
        const key = `${r[0]}:${r[1]}:${kind}`;
        const e = this.pending.get(key);
        if (e) e[2] += amount;
        else this.pending.set(key, [r[0], r[1], amount, kind]);
      }
      return false;
    }
    return own(amount, at, kind);
  }

  /** Host: the guest's hits, onto the real enemies. */
  applyDamage(hits: readonly [number, number, number, string][]): void {
    if (this.role !== 'host') return;
    for (const [id, part, amount, kind] of hits) {
      const body = this.byId.get(id);
      if (!body || !(amount > 0) || !Number.isFinite(amount)) continue;
      const parts = partsOf(body);
      const h = part >= 0 && parts ? parts[part] : parts ? null : (body as Hostile);
      if (!h || !h.alive) continue;
      (this.own.get(h) ?? h.damage.bind(h))(Math.min(amount, 1e5), h.pos, kind as DamageKind);
    }
  }

  // ── Host: snapshots ───────────────────────────────────────────────────────

  private idOf(b: Body): number {
    let id = this.ids.get(b);
    if (id === undefined) {
      id = this.nextId;
      this.nextId = (this.nextId % 0xfffe) + 1;
      this.ids.set(b, id);
    }
    this.byId.set(id, b);
    return id;
  }

  private snapshot(): WorldNetState {
    const c = this.combat;
    const bodies: NetBody[] = [];
    this.byId.clear();
    const add = (b: Body, cls: number, alive: boolean, hp: number) => {
      const parts = partsOf(b);
      bodies.push({
        id: this.idOf(b),
        cls,
        alive,
        hp,
        pos: b.pos,
        vel: b.vel,
        meshPos: b.mesh.position,
        meshQ: b.mesh.quaternion,
        parts: parts ? parts.map((p) => ({ alive: p.alive, hp: p.hp })) : [],
      });
    };
    for (const d of c.drones) add(d, DRONE_CLS[d.type], d.alive, d.hp);
    for (const s of c.sams) add(s, NetBodyClass.SAM, s.alive, s.hp);
    for (const f of c.ships) add(f, NetBodyClass.FRIGATE, !f.sunk, 0);
    if (c.boss) add(c.boss, NetBodyClass.BOSS, !c.boss.gone, 0);
    if (c.rival) add(c.rival, NetBodyClass.RIVAL, c.rival.alive, c.rival.hp);
    return { t: this.clock, wave: c.wave, houseHp: c.houseHp, bodies };
  }

  // ── Guest: puppets ────────────────────────────────────────────────────────

  /** Guest: a host snapshot in. */
  onWorld(w: WorldNetState): void {
    if (this.role !== 'guest') return;
    const c = this.combat;
    c.wave = w.wave;
    c.houseHp = w.houseHp;
    for (const b of w.bodies) {
      let p = this.puppets.get(b.id);
      // Our own copy went (a redeploy cleared the sky here, or it fell out of it)
      if (p && !this.present(p.body)) {
        this.puppets.delete(b.id);
        p = undefined;
      }
      if (!p) {
        if (!b.alive) continue;
        const body = this.spawn(b);
        if (!body) continue;
        p = { id: b.id, cls: b.cls, body, tgt: b, at: this.clock, lastSeen: this.clock, pos: b.pos.clone(), meshQ: b.meshQ.clone() };
        this.puppets.set(b.id, p);
        const parts = partsOf(body);
        if (parts) parts.forEach((h, i) => (this.guard(h), this.route.set(h, [b.id, i])));
        else (this.guard(body as Hostile), this.route.set(body as Hostile, [b.id, -1]));
        body.netPose(b.pos, b.vel, b.meshPos, b.meshQ);
      }
      p.tgt = b;
      p.at = p.lastSeen = this.clock;
      this.syncLife(p, b);
    }
  }

  private spawn(b: NetBody): Body | null {
    const c = this.combat;
    const drone = CLS_DRONE[b.cls];
    if (drone) return c.spawnDrone(b.pos, b.vel.lengthSq() > 1 ? b.vel : new THREE.Vector3(0, 0, 1), drone);
    switch (b.cls) {
      case NetBodyClass.SAM:
        return c.spawnSam(b.meshPos.clone());
      case NetBodyClass.FRIGATE:
        return c.spawnFrigate(b.pos);
      case NetBodyClass.BOSS:
        return c.spawnBoss();
      case NetBodyClass.RIVAL:
        return c.spawnRival(b.pos);
    }
    return null;
  }

  private present(body: Body): boolean {
    const c = this.combat;
    if (body instanceof Frigate) return c.ships.includes(body);
    if (body instanceof Dreadnought) return c.boss === body;
    if (body instanceof RivalSuit) return c.rival === body;
    if (body instanceof SamSite) return c.sams.includes(body);
    return c.drones.includes(body);
  }

  /** The host's hp and deaths onto the puppet (a death here runs the class's own: the spiral, the blast, the sinking). */
  private syncLife(p: Puppet, b: NetBody): void {
    const kill = (h: Hostile) => (this.own.get(h) ?? h.damage.bind(h))(h.hp + h.maxHp * 10 + 1e4, h.pos, 'ram');
    const parts = partsOf(p.body);
    if (parts) {
      b.parts.forEach((s, i) => {
        const h = parts[i];
        if (!h) return;
        if (h.alive && !s.alive) kill(h);
        else if (h.alive) h.hp = s.hp;
      });
      return;
    }
    const h = p.body as Hostile;
    if (h.alive && !b.alive) kill(h);
    else if (h.alive) h.hp = b.hp;
  }

  private readonly _v = new THREE.Vector3();
  private readonly _m = new THREE.Vector3();

  /** Each puppet onto the host's pose, dead-reckoned to now; anything the host dropped, dropped. */
  private posePuppets(dt: number): void {
    const k = 1 - Math.exp(-dt / CONVERGE);
    for (const [id, p] of this.puppets) {
      if (!this.present(p.body)) {
        this.puppets.delete(id);
        continue;
      }
      if (this.clock - p.lastSeen > VANISH_AFTER) {
        this.vanish(p);
        this.puppets.delete(id);
        continue;
      }
      const t = p.tgt;
      const age = Math.min(MAX_EXTRAPOLATE, this.clock - p.at);
      const goal = this._v.copy(t.pos).addScaledVector(t.vel, age);
      if (p.pos.distanceToSquared(goal) > SNAP_DIST * SNAP_DIST) p.pos.copy(goal);
      else p.pos.addScaledVector(t.vel, dt).lerp(goal, k);
      p.meshQ.slerp(t.meshQ, k);
      const meshPos = this._m.copy(t.meshPos).sub(t.pos).add(p.pos);
      p.body.netPose(p.pos, t.vel, meshPos, p.meshQ);
    }
  }

  /** The host dropped it: a SAM only goes when it's destroyed (blow it here); anything else just leaves. */
  private vanish(p: Puppet): void {
    const b = p.body;
    if (b instanceof SamSite && b.alive) {
      (this.own.get(b) ?? b.damage.bind(b))(b.hp + 1e4, b.pos, 'ram');
      return;
    }
    if (b instanceof Drone && !b.alive) return; // falling: it crashes here on its own
    this.combat.removeBody(b);
  }
}
