import * as THREE from 'three';
import type { Particles } from '../fx/particles';
import { Streaks } from '../fx/streaks';
import type { EventBus } from '../sim/events';
import type { FlightModel } from '../sim/flightModel';
import { ACTION_KEYS, type Controls } from '../sim/input';
import type { HitStop } from '../sim/hitStop';
import type { Suit } from '../../suit/Suit';
import { HOME, type Heightfield } from '../world/heightfield';
import { strikeMarks, structureTop } from '../world/house';
import { CloseQuarters } from './closeQuarters';
import { Dreadnought, type BossPart } from './dreadnought';
import { BOMB_CHAIN_DAMAGE, BOMB_CHAIN_RADIUS, Drone, Guns, JAM_RANGE, type DroneType } from './drones';
import { Explosions, type SurfaceQuery } from './explosions';
import { Frigate, type ShipPart } from './frigate';
import { HouseCiws } from './houseCiws';
import { HOUSE_PARTY_KEY, HousePartyManager } from './houseParty';
import { Missiles, type Missile } from './missiles';
import { PhysicsWeapons } from './physicsWeapons';
import { PlayerWeapons } from './playerWeapons';
import { RivalSuit } from './rivalSuit';
import { SamSite, samSites } from './sams';
import type { Hostile, HouseTarget, PlayerTarget } from './types';
import { STOCK_SPEC, type SuitSpec } from '../sim/upgrades';
import { ReactorPower } from '../sim/reactorPower';
import { emitOverchargeArcs } from './laserCutterFx';
import { waveAt } from './waves';
import { hazeAll } from '../render/haze';

/**
 * The fight: the suit's armour and the hostiles that wear it down, in
 * escalating waves. Free flight until the pilot calls a wave (N, or the
 * touch WAVE button, offered whenever the sky is clear; once a run is going
 * the next one comes on its own {@link AUTO_WAVE} s after a clear): drones from over
 * the ridges, then the mobile SAM launchers wake up, then a frigate comes
 * in off the sea (and again every third wave after). Armour regenerates out of combat; at zero the suit drops
 * dead for a few seconds and reboots in the air, on its one reserve (a cleared
 * wave earns it back). With that spent the suit is lost:
 * it stays down until the pilot redeploys, back to wave one on the pad.
 * Later waves bring faster and stranger aircraft (see ./drones), and every
 * tenth-odd one the dreadnought (./dreadnought).
 *
 * The house is the other thing to lose. With the suit out of their sight the
 * SAMs shell it, bombers fly runs on it and the dreadnought's cannon is laid
 * on nothing else; every round that lands takes a piece of it
 * ({@link Combat.houseHp}), a cleared wave puts a little back, and R&D spent
 * on the pad the rest. JARVIS runs from the house: when it goes, the suit
 * goes dark with it and the run is over.
 */

/** The one reboot the suit holds at the start of a run. */
export const RESERVES = 1;
/** Seconds after the sky clears before the next wave comes uncalled (time to get down on the pad and refit). */
export const AUTO_WAVE = 45;
/** Seconds after the suit is lost before a redeploy is offered (it's seen to fall). */
const REDEPLOY_AFTER = 2.5;
/** The share of the house a launcher's round takes (bombs and the dreadnought's shells bring their own). */
const SAM_DAMAGE = 0.05;
/** A round counts against the house when it comes down this near one of its roofs (m). */
const HOUSE_HIT_R = 45;
/** The house's own battery engages a round this far out (m). */
const HOUSE_GUARD_R = 420;
/** Scorch marks the roofs keep before the oldest goes. */
const MAX_SCORCH = 24;

let scorchMat: THREE.MeshStandardMaterial | null = null;
const SCORCH_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
/** A ragged soot splash: alpha falls off from the middle, broken up round the rim. */
function scorchMaterial(): THREE.MeshStandardMaterial {
  if (scorchMat) return scorchMat;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  const lobes = Array.from({ length: 7 }, () => [Math.random() * Math.PI * 2, 0.08 + Math.random() * 0.12] as const);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n - 0.5;
      const y = (j + 0.5) / n - 0.5;
      const a = Math.atan2(y, x);
      const rim = 0.34 + lobes.reduce((r, [p, k]) => r + k * Math.max(0, Math.cos(a * 3 + p)) ** 4, 0) * 0.5;
      const r = Math.hypot(x, y) / rim;
      const alpha = Math.max(0, Math.min(1, 1.15 - r * r)) * (0.75 + 0.25 * Math.random());
      data.set([14, 12, 10, Math.round(alpha * 235)], (j * n + i) * 4);
    }
  }
  const map = new THREE.DataTexture(data, n, n);
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  scorchMat = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 });
  return scorchMat;
}

export class Combat {
  readonly group = new THREE.Group();
  readonly streaks = new Streaks();
  readonly explosions: Explosions;
  readonly missiles: Missiles;
  readonly guns = new Guns();
  readonly weapons: PlayerWeapons;
  readonly physics = new PhysicsWeapons();
  /** Live Arc Reactor 3-way power allocation & 400% overcharge manager. */
  readonly reactor: ReactorPower;
  /** House Party Protocol: autonomous spare suits (KeyP) + mid-air Hot-Swap rescue. */
  readonly houseParty: HousePartyManager;
  /** Malibu Automated CIWS Terrace Turrets (House Defences L3/L5 capstone). */
  readonly houseCiws: HouseCiws;
  /** Close-Quarters combat: targeted dive-slam + mid-air grapple/throw + thruster punch. */
  readonly closeQuarters = new CloseQuarters();
  /** Optional micro hit-stop tracker wired by Game. */
  hitStop: HitStop | null = null;
  /** Armour L3/L5 Reactive Pulse state (cooldown & active 2 s damage brace). */
  reactivePulseCd = 0;
  reactiveBraceT = 0;
  /** Fitted upgrade level count (synced from app to scale House Party deployment 1 vs 2 suits). */
  fittedLevels = 0;
  readonly drones: Drone[] = [];
  readonly sams: SamSite[] = [];
  readonly ships: Frigate[] = [];
  /** The dreadnought, while there is one. */
  boss: Dreadnought | null = null;
  /** The supersonic rival powered-armour ace, while there is one. */
  rival: RivalSuit | null = null;
  readonly hostiles: Hostile[] = [];
  /** Armour 0–1. */
  armor = 1;
  /** Seconds since the last hit. */
  sinceHit = 99;
  /** Seconds left with the suit powered down. */
  down = 0;
  damageFlash = 0;
  wave = -1;
  kills = 0;
  /** Reboots left this run. */
  reserves = RESERVES;
  /** The suit's upgrades (the app shares the live one; stock until then). */
  spec: SuitSpec = STOCK_SPEC();
  /** The R&D has a refit waiting and the suit is off the pad (set by the app): the all-clear calls it home. */
  refitDue: () => boolean = () => false;
  /** Knocked out with no reserve left: down for good until {@link resetRun}. */
  lost = false;
  /** Seconds since the suit was lost. */
  lostT = 0;
  /** What ended the run: the suit shot out of the sky, or the house brought down. */
  lostWhy: 'suit' | 'house' = 'suit';
  /** What's left of the house (0–1), and a flash as it takes a hit. */
  houseHp = 1;
  houseFlash = 0;
  /** How hard a jammer has the seekers right now (0–1, after the suit's own resistance). */
  jam = 0;
  /** Seconds to the point defence's next shot. */
  private pdT = 0;
  /** Inbound rounds the house's battery has had its try at. */
  private readonly engaged = new WeakSet<Missile>();
  /** Interception beams still on screen. */
  private readonly zaps: { a: THREE.Vector3; b: THREE.Vector3; t: number }[] = [];
  private waveT = 0;
  private readonly samSpots: THREE.Vector3[];
  private readonly player: PlayerTarget;
  readonly house: HouseTarget;
  private readonly scorch: THREE.Mesh[] = [];
  /** Seconds since JARVIS last called out the shelling. */
  private shellCallT = 99;

  constructor(
    private readonly field: Heightfield,
    private readonly ground: SurfaceQuery,
    private readonly model: FlightModel,
    suit: Suit,
    private readonly particles: Particles,
    private readonly events: EventBus,
    onHit: (amount: number, at: THREE.Vector3) => void,
    private readonly hazeUniforms: Record<string, THREE.IUniform>,
  ) {
    this.explosions = new Explosions(particles, ground, events);
    this.missiles = new Missiles(particles, this.explosions, ground, events);
    this.weapons = new PlayerWeapons(suit, model, field, particles, this.streaks, this.missiles, this.explosions, events);
    this.reactor = new ReactorPower(events);
    this.houseParty = new HousePartyManager(hazeUniforms);
    this.houseCiws = new HouseCiws(field, hazeUniforms);
    this.weapons.reactor = this.reactor;
    this.model.reactor = this.reactor.modifiers;
    this.group.add(
      this.streaks.mesh,
      this.explosions.group,
      this.missiles.group,
      this.weapons.group,
      this.physics.group,
      this.closeQuarters.group,
      this.houseParty.group,
      this.houseCiws.group,
    );
    this.group.name = 'combat';
    this.samSpots = samSites(field, HOME, 6, 3);
    this.house = { marks: strikeMarks(field), struck: (at, damage) => this.houseStruck(at, damage ?? SAM_DAMAGE) };
    const self = this;
    this.player = {
      pos: model.pos,
      vel: model.vel,
      get alive() {
        return self.down <= 0;
      },
      hit(amount: number, at: THREE.Vector3, kind: 'bullet' | 'missile' | 'beam') {
        if (self.down > 0) return;
        const brace = self.reactiveBraceT > 0 ? 0.55 : 1;
        self.armor = Math.max(0, self.armor - (amount * self.spec.damageTaken * self.reactor.modifiers.damageTaken * brace) / 100);
        if (kind === 'beam') {
          // Absorbing the Rival Ace's Unibeam in SHIELDS mode rapidly surges the 400% capacitor
          if (self.reactor.mode === 'SHIELDS') {
            self.reactor.feedOvercharge(Math.min(0.4, amount * 0.055), 'rivalBeam', at);
          }
        } else {
          self.reactor.onArmorHit(amount, at);
        }
        self.sinceHit = 0;
        self.damageFlash = Math.min(1, self.damageFlash + (kind === 'missile' ? 0.9 : kind === 'beam' ? 0.45 : 0.25));
        onHit(amount, at);
        events.emit('hitArmor', { at, value: amount });

        // Armour L3/L5 Capstone: Reactive EMP Pulse when dropping below 25% armour
        if (self.armor > 0 && self.armor <= 0.25 && self.spec.armorOverdriveTier > 0 && self.reactivePulseCd <= 0) {
          self.triggerReactivePulse(at);
        }

        if (self.armor <= 0) {
          events.emit('suitCritical', { at: model.pos });
          // Scripted runs (waves off) always reboot
          if (!self.wavesEnabled || self.reserves > 0) {
            self.down = 3.2;
            if (self.wavesEnabled) self.reserves--;
            const left = !self.wavesEnabled ? '' : self.reserves === 0 ? ' That was the last reserve, sir.' : self.reserves === 1 ? ' One reserve left.' : ` ${self.reserves} reserves left.`;
            events.emit('jarvis', { text: `Armour critical. Rerouting power. Hold on, sir.${left}` });
          } else if (self.houseParty.tryStartHotSwap(model, self.ground, self.particles, events)) {
            // Mid-Air Hot-Swap Rescue: hold suit down while the emergency spare pod intercepts!
            self.down = 7.5;
          } else {
            self.markSuitLost();
          }
        }
      },
    };
  }

  get playerTarget(): PlayerTarget {
    return this.player;
  }

  /** The pilot can call waves (off for scripted runs). */
  wavesEnabled = true;

  /** A wave can be called now: the sky is clear and the suit is up. */
  get waveReady(): boolean {
    return this.wavesEnabled && this.down <= 0 && !this.hostiles.some((h) => h.alive);
  }

  /** Seconds until the next wave comes on its own, or null when none is due (free flight, mid-wave, lost). */
  get autoWaveIn(): number | null {
    return this.wave >= 0 && this.waveReady && !this.lost ? Math.max(0, AUTO_WAVE - this.waveT) : null;
  }

  /** The suit is lost and has been seen to fall: a redeploy is on offer. */
  get redeployReady(): boolean {
    return this.lost && this.lostT > REDEPLOY_AFTER;
  }

  /** A fresh run: the sky cleared, wave one next, full armour and reserves. */
  resetRun(): void {
    for (const d of this.drones) this.group.remove(d.mesh);
    for (const s of this.sams) this.group.remove(s.mesh);
    for (const f of this.ships) this.group.remove(f.mesh);
    if (this.boss) this.group.remove(this.boss.mesh);
    this.boss = null;
    if (this.rival) {
      this.rival.disposeFlares(this.group);
      this.group.remove(this.rival.mesh);
      this.rival = null;
    }
    this.houseHp = 1;
    this.houseFlash = 0;
    this.jam = this.weapons.jam = 0;
    this.pdT = 0;
    this.zaps.length = 0;
    this.drones.length = this.sams.length = this.ships.length = this.hostiles.length = 0;
    this.missiles.clear();
    this.physics.reset();
    this.closeQuarters.reset();
    this.houseParty.reset();
    this.houseCiws.reset();
    this.reactivePulseCd = 0;
    this.reactiveBraceT = 0;
    this.guns.rounds.length = 0;
    this.counted.clear();
    this.wave = -1;
    this.kills = 0;
    this.armor = 1;
    this.sinceHit = 99;
    this.down = 0;
    this.damageFlash = 0;
    this.reserves = this.maxReserves;
    this.lost = false;
    this.lostT = 0;
    this.waveT = 0;
    this.reactor.reset();
    this.weapons.laserCutter.reset();
    for (const m of this.scorch) this.group.remove(m);
    this.scorch.length = 0;
    this.events.emit('redeploy', { at: this.model.pos });
  }

  /** Reboots a full run carries. */
  get maxReserves(): number {
    return RESERVES + this.spec.reserves;
  }

  /** One drone at a point, flying a heading (scripted encounters, the dreadnought's hangar). */
  spawnDrone(at: THREE.Vector3, heading: THREE.Vector3, type: DroneType = 'drone'): Drone {
    const d = new Drone(at, heading, type);
    d.mode = 'attack';
    this.drones.push(d);
    this.hostiles.push(d);
    hazeAll(d.mesh, this.hazeUniforms);
    this.group.add(d.mesh);
    return d;
  }

  /** A frigate on patrol offshore of the suit (or of another stretch of coast). */
  spawnFrigate(near: THREE.Vector3 = this.model.pos): Frigate {
    const f = new Frigate(this.field, near);
    this.ships.push(f);
    this.hostiles.push(...f.parts);
    hazeAll(f.mesh, this.hazeUniforms);
    this.group.add(f.mesh);
    return f;
  }

  /** The dreadnought, in off the sea toward the house (one at a time). */
  spawnBoss(): Dreadnought {
    if (this.boss) return this.boss;
    const b = new Dreadnought(HOME, (at, heading) => this.spawnDrone(at, heading));
    this.boss = b;
    this.hostiles.push(...b.parts);
    hazeAll(b.mesh, this.hazeUniforms);
    this.group.add(b.mesh);
    return b;
  }

  /** The supersonic Rival Ace powered-armour boss (one at a time). */
  spawnRival(near: THREE.Vector3 = this.model.pos): RivalSuit {
    if (this.rival && this.rival.alive) return this.rival;
    if (this.rival) {
      this.rival.disposeFlares(this.group);
      this.group.remove(this.rival.mesh);
      const idx = this.hostiles.indexOf(this.rival);
      if (idx >= 0) this.hostiles.splice(idx, 1);
      this.rival = null;
    }
    const angle = Math.atan2(1, -0.3) + (Math.random() - 0.5) * 0.9;
    const range = 1800 + Math.random() * 500;
    const at = new THREE.Vector3(near.x + Math.cos(angle) * range, 0, near.z + Math.sin(angle) * range);
    at.y = Math.max(this.field.surfaceAt(at.x, at.z), near.y, 0) + 550;
    const heading = near.clone().sub(at).setY(0);
    const r = new RivalSuit(at, heading);
    this.rival = r;
    this.hostiles.push(r);
    hazeAll(r.mesh, this.hazeUniforms);
    this.group.add(r.mesh);
    return r;
  }

  /** The house is whole again by `share` (0–1) of itself; returns what that actually put back. */
  repairHouse(share: number): number {
    const before = this.houseHp;
    this.houseHp = Math.min(1, this.houseHp + Math.max(0, share));
    return this.houseHp - before;
  }

  /** Start the next wave, if one is on offer. */
  callWave(): void {
    if (!this.waveReady) return;
    this.waveT = 0;
    this.wave++;
    const w = waveAt(this.wave);
    if (w.frigate) this.spawnFrigate();
    if (w.boss) this.spawnBoss();
    if (w.rival) this.spawnRival();
    // From inland, over the ridges, 2.6–3.5 km out (a few seconds' dash, not half a minute's wait)
    const base = Math.atan2(-1, 0.2) + (Math.random() - 0.5) * 1.2;
    const flight: DroneType[] = [
      ...Array<DroneType>(w.drones).fill('drone'),
      ...Array<DroneType>(w.interceptors ?? 0).fill('interceptor'),
      ...Array<DroneType>(w.jammers ?? 0).fill('jammer'),
    ];
    const n = flight.length;
    flight.forEach((type, i) => {
      const a = base + (i - n / 2) * 0.12;
      // (the fast ones start further back, so they arrive with the rest, not before)
      const r = (type === 'interceptor' ? 4200 : 2600) + Math.random() * 900;
      const at = new THREE.Vector3(this.model.pos.x + Math.cos(a) * r, 0, this.model.pos.z + Math.sin(a) * r);
      at.y = Math.max(this.field.surfaceAt(at.x, at.z), 0) + 450 + Math.random() * 400;
      this.addDrone(new Drone(at, this.model.pos.clone().sub(at).setY(0), type));
    });
    // Bombers: from far inland of the house, strung out so the runs come one after another
    for (let i = 0; i < (w.bombers ?? 0); i++) {
      const a = Math.atan2(-1, 0.2) + (Math.random() - 0.5) * 1.6;
      const r = 6000 + i * 1800 + Math.random() * 800;
      const at = new THREE.Vector3(HOME.x + Math.cos(a) * r, 0, HOME.y + Math.sin(a) * r);
      at.y = Math.max(this.field.surfaceAt(at.x, at.z), 0) + 600;
      this.addDrone(new Drone(at, new THREE.Vector3(HOME.x - at.x, 0, HOME.y - at.z), 'bomber'));
    }
    for (let i = 0; i < w.sams; i++) {
      const spot = this.samSpots.find((p) => !this.sams.some((s) => s.alive && s.pos.distanceTo(p) < 20));
      if (!spot) break;
      const s = new SamSite(spot, HOME);
      this.sams.push(s);
      this.hostiles.push(s);
      hazeAll(s.mesh, this.hazeUniforms);
      this.group.add(s.mesh);
    }
    this.events.emit('waveStart', { value: this.wave + 1 });
    this.events.emit('jarvis', { text: w.line });
  }

  private addDrone(d: Drone): void {
    this.drones.push(d);
    this.hostiles.push(d);
    hazeAll(d.mesh, this.hazeUniforms);
    this.group.add(d.mesh);
  }

  update(dt: number, t: number, c: Controls, aim: THREE.Vector3, eye: THREE.Vector3): void {
    this.sinceHit += dt;
    this.shellCallT += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    this.houseFlash = Math.max(0, this.houseFlash - dt * 1.2);
    this.reactivePulseCd = Math.max(0, this.reactivePulseCd - dt);
    this.reactiveBraceT = Math.max(0, this.reactiveBraceT - dt);
    this.reactor.capTier = this.spec.reactorCapTier;
    if (this.down <= 0 && !this.lost) {
      this.reactor.handleInput(c.pressed, this.model.pos);
      if (c.pressed.has(HOUSE_PARTY_KEY)) {
        const count: 1 | 2 = this.fittedLevels >= 10 || this.wave >= 3 ? 2 : 1;
        this.houseParty.deploy(count, this.particles, this.events);
      }
    }
    this.reactor.update(dt, this.down > 0 || this.lost);
    if (this.lost) this.lostT += dt;
    else if (this.down > 0 && !this.houseParty.hotSwapActive) {
      this.down -= dt;
      if (this.down <= 0) {
        this.armor = 0.5;
        this.events.emit('reboot', { at: this.model.pos });
        this.events.emit('jarvis', { text: 'Systems restored. Fifty percent armour.' });
      }
    } else if (this.down <= 0 && this.sinceHit > 6 * this.spec.regenDelay * this.reactor.modifiers.regenDelay) {
      this.armor = Math.min(1, this.armor + dt * 0.035 * this.spec.regenRate * this.reactor.modifiers.regenRate);
    }

    // A clear sky gets announced (and a cleared wave earns back a reserve);
    // the next wave comes when called (N) or AUTO_WAVE s on. Free flight
    // before the first wave stays free.
    if (this.wavesEnabled && !this.lost && this.wave >= 0 && !this.hostiles.some((h) => h.alive)) {
      this.waveT += dt;
      if (this.waveT > 1.5 && this.waveT - dt <= 1.5) {
        const earned = this.reserves < this.maxReserves;
        if (earned) this.reserves++;
        this.houseParty.onWaveClear();
        // (the bots get a little of the house back up between waves)
        this.repairHouse(this.spec.houseRepair);
        this.events.emit('waveClear', { value: this.wave + 1 });
        const home = this.refitDue() ? ' R&D has a refit ready — bring her down on the pad.' : this.houseHp < 0.6 ? ' The house needs work, sir: R&D can patch it from the pad.' : '';
        this.events.emit('jarvis', { text: `Area clear, sir.${earned ? ' A reserve is back online.' : ''}${home} Next formation in forty-five seconds.` });
      }
      if (this.waveT >= AUTO_WAVE) this.callWave();
    }

    this.streaks.begin();
    // A jammer in reach has the seekers (less whatever the suit's sensors shrug off)
    const jammed = this.drones.some((d) => d.alive && d.type === 'jammer' && d.pos.distanceToSquared(this.model.pos) < JAM_RANGE * JAM_RANGE);
    this.jam += ((jammed ? 1 - this.spec.jamResist : 0) - this.jam) * Math.min(1, dt * 3);
    this.weapons.jam = this.jam;
    this.weapons.update(dt, c, aim, eye, this.hostiles, this.down <= 0);
    if (this.down <= 0 && !this.lost) {
      if (c.grapple || c.pressed.has(ACTION_KEYS.GRAPPLE)) {
        const res = this.closeQuarters.tryMeleeAction(this.model, aim, this.hostiles, this.ground, this.explosions, this.particles, {
          mode: 'grab',
          events: this.events,
        });
        if (res.action === 'grab') this.events.emit('grappleGrab', { at: res.target?.pos ?? this.model.pos, text: res.target?.kind });
        else if (res.action === 'throw') this.events.emit('grappleThrow', { at: res.target?.pos ?? this.model.pos, text: res.target?.kind });
      } else if (c.punch || c.pressed.has(ACTION_KEYS.PUNCH)) {
        const res = this.closeQuarters.tryMeleeAction(this.model, aim, this.hostiles, this.ground, this.explosions, this.particles, {
          mode: 'punch',
          events: this.events,
        });
        if (res.action === 'punch') this.events.emit('thrusterPunch', { at: res.target?.pos ?? this.model.pos, text: res.target?.kind });
      }
    }
    this.closeQuarters.update(dt, this.model, aim, this.hostiles, this.ground, this.explosions, this.particles, this.events);
    for (const d of this.drones) {
      d.update(dt, t, this.player, this.ground, this.guns.rounds, this.missiles, this.particles, this.explosions, this.events, this.house);
      if (!d.flybyDone && d.alive && d.pos.distanceTo(this.model.pos) < 120) {
        d.flybyDone = true;
        this.events.emit('droneFlyby', { at: d.pos, value: d.vel.length() });
      }
      if (d.flybyDone && d.pos.distanceTo(this.model.pos) > 400) d.flybyDone = false;
    }
    for (const s of this.sams) s.update(dt, t, this.player, this.house, this.field, this.missiles, this.events, this.explosions, this.particles);
    for (const f of this.ships) {
      f.update(dt, t, this.player, this.field, this.guns.rounds, this.missiles, this.particles, this.explosions, this.events);
      f.collide(this.model.pos, this.model.vel);
    }
    if (this.boss) {
      this.boss.update(dt, t, this.player, this.field, this.guns.rounds, this.missiles, this.particles, this.explosions, this.events, this.house);
      this.boss.collide(this.model.pos, this.model.vel);
      // Flying close to an exposed Dreadnought reactor core siphons energy into overcharge
      if (!this.boss.falling && !this.boss.shielded && this.boss.core.alive && this.down <= 0) {
        const dCore = this.model.pos.distanceTo(this.boss.core.pos);
        if (dCore < 180) {
          this.reactor.feedOvercharge(dt * 0.25 * (1 - dCore / 180), 'bossCore', this.boss.core.pos);
        }
      }
    }
    if (this.rival) {
      this.rival.update(dt, t, this.player, this.ground, this.missiles, this.particles, this.streaks, this.explosions, this.events, this.group);
    }
    this.physics.update(dt, this.model, this.weapons, this.drones, this.missiles, this.player, this.ground, this.particles, this.explosions, this.events);
    const swapRes = this.houseParty.update(
      dt,
      t,
      this.model,
      this.hostiles,
      this.ground,
      this.missiles,
      this.particles,
      this.streaks,
      this.explosions,
      this.events,
      c.pressed.has(HOUSE_PARTY_KEY) || c.unibeam,
      (h) => this.events.emit('kill', { at: h.pos, text: h.kind }),
    );
    if (swapRes === 'caught') {
      this.down = 0;
      this.armor = 1;
      this.reactiveBraceT = Math.max(this.reactiveBraceT, 3.0);
      this.reactor.feedOvercharge(0.35, 'hotSwap', this.model.pos);
      this.hitStop?.trigger(0.05, 0.12);
    } else if (swapRes === 'missed' && !this.lost) {
      this.markSuitLost();
    }
    this.houseCiws.update(
      dt,
      this.spec.houseCiwsTier,
      this.hostiles,
      this.particles,
      this.streaks,
      this.events,
      (h) => this.events.emit('kill', { at: h.pos, text: h.kind }),
      this.lost || this.houseHp <= 0,
    );
    this.intercept(dt);
    this.guns.update(dt, this.player, this.ground, this.particles, this.streaks, this.events);
    this.missiles.update(dt, this.hostiles, this.player);
    // Kills: count, blow the SAMs (drones crash on their own)
    for (let i = this.hostiles.length - 1; i >= 0; i--) {
      const h = this.hostiles[i];
      if (!h.alive && !this.counted.has(h.id)) {
        this.counted.add(h.id);
        // (what was still on the dreadnought when it fell isn't a kill of its own)
        if (h.kind === 'boss' && (h as BossPart).scuttled) continue;
        this.kills++;
        this.events.emit('destroyed', { at: h.pos, text: h.kind });
        if (h.kind === 'sam') {
          this.explosions.blast(h.pos, 10, { debris: 14, burn: true });
          const sam = h as SamSite;
          sam.mesh.visible = false;
        } else if (h.kind === 'ship') {
          const part = h as ShipPart;
          part.ship.partDestroyed(part, this.explosions, this.events);
          if (part.role === 'hull' && this.model.pos.distanceTo(part.pos) < 550) {
            this.reactor.feedOvercharge(0.45, 'frigateExplosion', part.pos);
          }
        } else if (h.kind === 'boss') {
          const part = h as BossPart;
          part.owner.partDestroyed(part, this.explosions, this.events);
          if (part.role === 'core') this.hitStop?.trigger(0.055, 0.12);
          if ((part.role === 'core' || part.role === 'engine') && this.model.pos.distanceTo(part.pos) < 550) {
            this.reactor.feedOvercharge(part.role === 'core' ? 0.65 : 0.2, 'bossExplosion', part.pos);
          }
        } else if (h.kind === 'rival') {
          (h as RivalSuit).onDestroyed(this.explosions, this.events);
          this.reactor.feedOvercharge(0.5, 'rivalDefeated', h.pos);
          this.hitStop?.trigger(0.055, 0.12);
        } else {
          if (h.kind === 'bomber' && (h as Drone).payloadDetonated) {
            this.detonateBomberPayload(h as Drone);
          } else {
            this.explosions.blast(h.pos, 4, { debris: 5, vel: h.vel.clone().multiplyScalar(0.3) });
          }
        }
      }
    }
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.crashed || d.pos.y < -50) {
        this.group.remove(d.mesh);
        this.drones.splice(i, 1);
        this.hostiles.splice(this.hostiles.indexOf(d), 1);
      }
    }
    for (let i = this.sams.length - 1; i >= 0; i--) {
      const s = this.sams[i];
      if (!s.alive) {
        this.group.remove(s.mesh);
        this.sams.splice(i, 1);
        this.hostiles.splice(this.hostiles.indexOf(s), 1);
      }
    }
    // Ship parts leave the target list as they go; the ship stays until it's under
    for (let i = this.hostiles.length - 1; i >= 0; i--) {
      const h = this.hostiles[i];
      if ((h.kind === 'ship' || h.kind === 'boss') && !h.alive) this.hostiles.splice(i, 1);
    }
    if (this.boss?.gone) {
      this.events.emit('destroyed', { at: this.boss.pos, text: 'dreadnought' });
      this.group.remove(this.boss.mesh);
      this.boss = null;
    }
    if (this.rival && (this.rival.crashed || this.rival.pos.y < -50)) {
      this.rival.disposeFlares(this.group);
      this.group.remove(this.rival.mesh);
      const idx = this.hostiles.indexOf(this.rival);
      if (idx >= 0) this.hostiles.splice(idx, 1);
      this.rival = null;
    }
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const f = this.ships[i];
      if (f.sunk) {
        this.events.emit('destroyed', { at: f.mesh.position, text: 'frigate' });
        this.group.remove(f.mesh);
        this.ships.splice(i, 1);
      }
    }
    if (this.reactor.overchargeActive && this.down <= 0) {
      emitOverchargeArcs(dt, this.model.pos, this.model.vel, this.particles, this.streaks);
    }
    this.explosions.update(dt);
    this.streaks.end();
  }

  /**
   * Once the suit is posed for the frame: the player's shots leave their
   * hardware (muzzles where the suit is now, not a frame behind) and the
   * streaks are closed for drawing.
   */
  afterPose(): void {
    this.weapons.afterPose();
    this.streaks.end();
  }

  /** Hero-landing ground-slam shockwave; returns extra camera shake. */
  onHeroLanding(at: THREE.Vector3, impactSpeed: number): number {
    return this.physics.onHeroLanding(at, impactSpeed, this.hostiles, this.ground, this.particles, this.events).shake;
  }

  /** Mach 1 physical shockwave cone: knocks light aircraft off course & detonates nearby enemy missiles. */
  onSonicBoom(at: THREE.Vector3, vel: THREE.Vector3): void {
    this.physics.onSonicBoom(at, vel, this.drones, this.missiles, this.particles);
  }

  /** Pending camera shake from physics-weapon and close-quarters impacts. */
  consumeShake(): number {
    return this.physics.consumeShake() + this.closeQuarters.consumeShake();
  }

  private readonly counted = new Set<number>();

  /** Enemy seekers on the suit right now. */
  get incoming(): number {
    return this.missiles.threats().length;
  }

  /** Where whatever is going for the house is: launchers laid on it, bombers running in, the dreadnought's cannon. */
  *shellers(): Generator<THREE.Vector3> {
    for (const s of this.sams) if (s.shelling) yield s.pos;
    for (const d of this.drones) if (d.alive && d.type === 'bomber') yield d.pos;
    if (this.boss?.shelling) yield this.boss.cannon.pos;
  }

  /** The house is under attack: something is laid on it or a round is on its way. */
  get houseUnderFire(): boolean {
    return this.sams.some((s) => s.shelling) || !!this.boss?.shelling || this.missiles.strikes().length > 0;
  }

  /**
   * Rounds burned out of the air before they land: the suit's point defence
   * takes the nearest one inside its reach every few seconds (a seeker on the
   * suit, or a strike on its way past to the house), and the house's own
   * battery has one try at each round that comes in on it.
   */
  private intercept(dt: number): void {
    const S = this.spec;
    this.pdT = Math.max(0, this.pdT - dt);
    const inbound = S.pdInterval > 0 || S.houseIntercept > 0 ? this.missiles.inbound() : [];
    if (S.pdInterval > 0 && this.pdT <= 0 && this.down <= 0) {
      const maxShots = S.pdChainTier >= 1 ? 2 : 1;
      const picked: Missile[] = [];
      for (let shot = 0; shot < maxShots; shot++) {
        let best: Missile | null = null;
        let bestD = S.pdRange * S.pdRange;
        for (const m of inbound) {
          if (picked.includes(m)) continue;
          const d = m.pos.distanceToSquared(this.model.pos);
          // (not the instant it leaves the rail: there has to be something to see)
          if (m.age > 0.4 && d < bestD) {
            bestD = d;
            best = m;
          }
        }
        if (best) picked.push(best);
      }
      if (picked.length > 0) {
        this.pdT = S.pdInterval;
        for (const m of picked) {
          this.zap(this.model.pos.clone().add(new THREE.Vector3(0, 0.45, 0)), m, 'suit');
        }
      } else if (S.pdChainTier === 2) {
        // Point Defence L5 Active Interception Grid: zap enemy drones inside 180 m
        let closeDrone: Drone | null = null;
        let bestD2 = 180 * 180;
        for (const d of this.drones) {
          if (!d.alive) continue;
          const d2 = d.pos.distanceToSquared(this.model.pos);
          if (d2 < bestD2) {
            bestD2 = d2;
            closeDrone = d;
          }
        }
        if (closeDrone) {
          this.pdT = S.pdInterval;
          const from = this.model.pos.clone().add(new THREE.Vector3(0, 0.45, 0));
          this.zaps.push({ a: from, b: closeDrone.pos.clone(), t: 0.16 });
          this.particles.burst('spark', closeDrone.pos, 10, 14, undefined, 1);
          if (closeDrone.damage(35, closeDrone.pos, 'repulsor')) {
            this.events.emit('kill', { at: closeDrone.pos, text: closeDrone.kind });
          }
          this.events.emit('intercept', { at: closeDrone.pos, text: 'suit' });
        }
      }
    }
    if (S.houseIntercept > 0 && !this.lost) {
      for (const m of inbound) {
        if (m.onImpact === null || this.engaged.has(m)) continue;
        if (Math.hypot(m.pos.x - HOME.x, m.pos.z - HOME.y) > HOUSE_GUARD_R) continue;
        this.engaged.add(m);
        if (Math.random() < S.houseIntercept) {
          const from = this.house.marks.length ? this.house.marks[0].clone().add(new THREE.Vector3(0, 3, 0)) : new THREE.Vector3(HOME.x, m.pos.y - 100, HOME.y);
          this.zap(from, m, 'house');
        }
      }
    }
    // The beams: a white-hot line for a few frames
    for (let i = this.zaps.length - 1; i >= 0; i--) {
      const z = this.zaps[i];
      z.t -= dt;
      if (z.t <= 0) {
        this.zaps.splice(i, 1);
        continue;
      }
      const k = z.t / 0.16;
      this.streaks.add(z.a, z.b, 6 * k, 9 * k, 14 * k, k, 0.1, 0.22);
    }
  }

  private zap(from: THREE.Vector3, m: Missile, by: 'suit' | 'house'): void {
    this.zaps.push({ a: from, b: m.pos.clone(), t: 0.16 });
    this.events.emit('intercept', { at: m.pos, text: by });
    this.missiles.shootDown(m);
  }

  /** A round came down on (or short of) the house: fire and smoke, soot where it hit the roof, and a piece of the house gone. */
  private houseStruck(at: THREE.Vector3, damage: number): void {
    this.houseDamaged(at, damage);
    this.explosions.burn(at, 30, 4);
    const top = structureTop(this.field, at.x, at.z);
    if (top > -Infinity && at.y < top + 3) {
      const m = new THREE.Mesh(SCORCH_GEO, scorchMaterial());
      m.position.set(at.x, top + 0.04, at.z);
      m.rotation.y = Math.random() * Math.PI * 2;
      m.scale.setScalar(5 + Math.random() * 3);
      hazeAll(m, this.hazeUniforms);
      this.group.add(m);
      this.scorch.push(m);
      if (this.scorch.length > MAX_SCORCH) this.group.remove(this.scorch.shift()!);
    }
    if (this.shellCallT > 30 && !this.lost) {
      this.shellCallT = 0;
      this.events.emit('jarvis', { text: 'They’re shelling the house, sir. Show them the suit and they’ll turn back on you.' });
    }
  }

  /** What a round on the house costs it. Nothing in a scripted run, or once the run is over; at nothing left, the run ends. */
  private houseDamaged(at: THREE.Vector3, damage: number): void {
    if (!this.wavesEnabled || this.lost || this.houseHp <= 0) return;
    if (!this.house.marks.some((p) => p.distanceToSquared(at) < HOUSE_HIT_R * HOUSE_HIT_R)) return;
    const before = this.houseHp;
    this.houseHp = Math.max(0, this.houseHp - damage * this.spec.houseDamage);
    this.houseFlash = 1;
    this.events.emit('houseHit', { at, value: this.houseHp });
    // The worse off it is, the longer each hit burns
    this.explosions.burn(at, 40 + 160 * (1 - this.houseHp), 5);
    for (const [mark, line] of [
      [0.75, 'The house is taking hits, sir.'],
      [0.5, 'Half the house is gone, sir. I would rather like to keep the other half.'],
      [0.25, 'The house will not take much more of this. Nor will I.'],
    ] as const) {
      if (before > mark && this.houseHp <= mark) {
        this.shellCallT = 0;
        this.events.emit('jarvis', { text: line });
      }
    }
    if (this.houseHp > 0) return;
    // JARVIS runs from the house: with it gone the suit goes dark, and that's the run
    for (const p of this.house.marks) this.explosions.blast(p, 14, { debris: 16, burn: true });
    this.lost = true;
    this.lostWhy = 'house';
    this.lostT = 0;
    this.down = Infinity;
    this.events.emit('houseLost', { at });
    this.events.emit('suitCritical', { at: this.model.pos });
    this.events.emit('suitLost', { at: this.model.pos, value: this.wave + 1, text: 'house' });
    this.events.emit('jarvis', { text: 'The house is gone, sir. My servers with it. I am losing y—' });
  }

  private markSuitLost(): void {
    this.lost = true;
    this.lostWhy = 'suit';
    this.lostT = 0;
    this.down = Infinity;
    this.events.emit('suitLost', { at: this.model.pos, value: this.wave + 1 });
    this.events.emit('jarvis', { text: 'Reserves exhausted. I’m losing the suit, sir.' });
  }

  /** Armour L3/L5 Capstone: Reactive EMP pulse below 25% armour. */
  private triggerReactivePulse(at: THREE.Vector3): void {
    const tier = this.spec.armorOverdriveTier;
    this.reactivePulseCd = 25;
    this.reactiveBraceT = 2.0;
    const radius = tier === 2 ? 120 : 85;
    for (const d of this.drones) {
      if (!d.alive) continue;
      const off = d.pos.clone().sub(this.model.pos);
      const dist = off.length();
      if (dist > radius || dist < 1e-3) continue;
      d.vel.addScaledVector(off.divideScalar(dist), 55);
      d.destabilized = Math.max(d.destabilized, 2.0);
    }
    const nearMissiles = this.missiles.live.filter((m) => m.team === 'enemy' && m.pos.distanceTo(this.model.pos) <= radius * 0.7);
    for (const m of nearMissiles) this.missiles.shootDown(m);
    if (tier === 2) {
      this.armor = Math.min(1, this.armor + 0.15);
      this.reactor.feedOvercharge(0.25, 'naniteSurge', at);
    }
    this.particles.burst('plasma', this.model.pos, 26, 28, undefined, 1.1, { scale: 1.4 });
    this.events.emit('reactivePulse', { at: this.model.pos, value: tier });
    this.events.emit('jarvis', {
      text: tier === 2 ? 'Auto-nanite surge engaged, sir. Armour reinforced.' : 'Reactive EMP pulse discharged. Brace active.',
    });
  }

  /** Bomber Open-Bay Payload Chain-Detonation (Pillar 6B): massive airburst that wipes nearby escort drones. */
  private detonateBomberPayload(bomber: Drone): void {
    const at = bomber.pos.clone();
    this.explosions.blast(at, 14, { debris: 24, burn: true, vel: bomber.vel.clone().multiplyScalar(0.2) });
    this.particles.burst('plasma', at, 32, 34, undefined, 1.2, { scale: 2.0 });
    this.particles.burst('spark', at, 28, 30, undefined, 1.2, { scale: 1.5 });
    let chainKills = 0;
    for (const d of this.drones) {
      if (!d.alive || d === bomber) continue;
      const dist = d.pos.distanceTo(at);
      if (dist > BOMB_CHAIN_RADIUS) continue;
      const fall = 1 - 0.65 * (dist / BOMB_CHAIN_RADIUS);
      const killed = d.damage(BOMB_CHAIN_DAMAGE * fall, at, 'missile');
      const push = d.pos.clone().sub(at);
      if (push.lengthSq() > 1e-4) d.vel.addScaledVector(push.normalize(), 65 * fall);
      if (killed) {
        chainKills++;
        this.events.emit('kill', { at: d.pos, text: d.kind });
      }
    }
    this.events.emit('payloadDetonation', { at, value: chainKills });
    this.events.emit('jarvis', {
      text:
        chainKills > 0
          ? `Direct hit on the bomb bay — ${chainKills === 1 ? 'an escort went' : `${chainKills} escorts went`} up with it, sir.`
          : 'Direct hit on the open bomb bay, sir. Saved us a lot of drywall.',
    });
  }

  /** Where the radars holding the suit right now are (SAM trucks, the frigate's gun directors, the dreadnought's turrets). */
  *trackers(): Generator<THREE.Vector3> {
    for (const s of this.sams) if (s.alive && s.track > 0.5) yield s.pos;
    for (const f of this.ships) if (!f.sinking) yield* f.trackers();
    if (this.boss && !this.boss.falling) yield* this.boss.trackers();
    if (this.rival && this.rival.alive && (this.rival.chargingBeam || this.rival.firingBeam)) yield this.rival.pos;
  }
}
