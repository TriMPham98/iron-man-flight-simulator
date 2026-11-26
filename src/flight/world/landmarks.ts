import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HOME, HOME_HEIGHT, coastZ } from './heightfield';

/** Minimal heightfield contract so Landmarks works with real or mocked terrain. */
export interface HeightSampler {
  heightAt(x: number, z: number): number;
}

export interface ClearanceResult {
  dist: number;
  label: string;
}

export interface GatePassResult {
  index: number;
  total: number;
  splitSec: number;
  courseComplete: boolean;
  bestSec: number;
}

export interface LandmarksUpdateResult {
  gatePassed?: GatePassResult;
  activeGatePos: THREE.Vector3 | null;
  gatesCleared: number;
  totalGates: number;
}

export interface FlightGate {
  readonly index: number;
  readonly label: string;
  readonly pos: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly radius: number;
}

export interface LandmarkSummary {
  readonly id: string;
  readonly label: string;
  readonly pos: THREE.Vector3;
}

type Collider =
  | {
      kind: 'box';
      label: string;
      center: THREE.Vector3;
      half: THREE.Vector3;
      cos: number;
      sin: number;
    }
  | {
      kind: 'segment';
      label: string;
      a: THREE.Vector3;
      b: THREE.Vector3;
      ab: THREE.Vector3;
      lenSq: number;
      radius: number;
    };

interface GateVisual {
  group: THREE.Group;
  outerRing: THREE.Mesh;
  innerRing: THREE.Mesh;
  outerMat: THREE.MeshBasicMaterial;
  innerMat: THREE.MeshBasicMaterial;
  beacon: THREE.Mesh;
  beaconMat: THREE.MeshBasicMaterial;
}

const UP = new THREE.Vector3(0, 1, 0);
const GATE_RADIUS = 28;
const GATE_PASS_RADIUS = 30;
const COURSE_RESET_DELAY = 6.0;

/** Collects non-indexed BufferGeometries with matching attributes for 1-draw merging. */
class PartBatch {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(g: THREE.BufferGeometry): void {
    const geo = g.index ? g.toNonIndexed() : g;
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    if (!geo.getAttribute('uv')) {
      const n = geo.getAttribute('position').count;
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    for (const k of Object.keys(geo.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
    }
    geo.morphAttributes = {};
    geo.groups = [];
    this.parts.push(geo);
  }

  build(material: THREE.Material, name: string): THREE.Mesh | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts);
    if (!merged) return null;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    return mesh;
  }
}

function boxGeo(w: number, h: number, d: number, x: number, y: number, z: number, yaw = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (yaw) g.rotateY(yaw);
  return g.translate(x, y, z);
}

function cylBetween(a: THREE.Vector3, b: THREE.Vector3, rBot: number, rTop = rBot, segs = 10): THREE.BufferGeometry {
  const delta = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(0.01, delta.length());
  const g = new THREE.CylinderGeometry(rTop, rBot, len, segs);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, delta.clone().divideScalar(len));
  g.applyQuaternion(q);
  g.translate((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
  return g;
}

function pointToBoxDist(p: THREE.Vector3, c: Extract<Collider, { kind: 'box' }>): number {
  const dx = p.x - c.center.x;
  const dz = p.z - c.center.z;
  // Rotate world offset into box-local XZ frame (inverse of yaw)
  const lx = dx * c.cos - dz * c.sin;
  const lz = dx * c.sin + dz * c.cos;
  const ly = p.y - c.center.y;
  const qx = Math.max(Math.abs(lx) - c.half.x, 0);
  const qy = Math.max(Math.abs(ly) - c.half.y, 0);
  const qz = Math.max(Math.abs(lz) - c.half.z, 0);
  return Math.hypot(qx, qy, qz);
}

function pointToSegmentDist(p: THREE.Vector3, c: Extract<Collider, { kind: 'segment' }>): number {
  if (c.lenSq <= 1e-6) return Math.max(0, p.distanceTo(c.a) - c.radius);
  const apx = p.x - c.a.x;
  const apy = p.y - c.a.y;
  const apz = p.z - c.a.z;
  const t = THREE.MathUtils.clamp((apx * c.ab.x + apy * c.ab.y + apz * c.ab.z) / c.lenSq, 0, 1);
  const cx = c.a.x + c.ab.x * t - p.x;
  const cy = c.a.y + c.ab.y * t - p.y;
  const cz = c.a.z + c.ab.z * t - p.z;
  return Math.max(0, Math.hypot(cx, cy, cz) - c.radius);
}

/** Distance from segment P0->P1 to point Q, plus crossing check on gate plane. */
function segmentPassesGate(p0: THREE.Vector3, p1: THREE.Vector3, gate: FlightGate, passRadius: number): boolean {
  if (p1.distanceTo(gate.pos) <= passRadius) return true;
  const seg = _tmpSeg.subVectors(p1, p0);
  const segLenSq = seg.lengthSq();
  if (segLenSq < 1e-8) return false;
  // Closest point on segment to gate.pos
  const t = THREE.MathUtils.clamp(_tmpVec.subVectors(gate.pos, p0).dot(seg) / segLenSq, 0, 1);
  const closest = _tmpVec.copy(p0).addScaledVector(seg, t);
  if (closest.distanceTo(gate.pos) <= passRadius) return true;
  // Also check plane intersection in case of oblique high-speed pass
  const d0 = _tmpPlane0.subVectors(p0, gate.pos).dot(gate.normal);
  const d1 = _tmpPlane1.subVectors(p1, gate.pos).dot(gate.normal);
  if ((d0 <= 0 && d1 >= 0) || (d0 >= 0 && d1 <= 0)) {
    const denom = d0 - d1;
    if (Math.abs(denom) > 1e-6) {
      const u = d0 / denom;
      const hit = _tmpVec.copy(p0).lerp(p1, u);
      return hit.distanceTo(gate.pos) <= passRadius;
    }
  }
  return false;
}

const _tmpSeg = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _tmpPlane0 = new THREE.Vector3();
const _tmpPlane1 = new THREE.Vector3();

/**
 * 3D Night Ops flight playground: offshore Stark oil rig, coastal suspension
 * bridge, inland canyon radar arches, and a holographic JARVIS flight gate
 * course with proximity clearance queries and split/best-time tracking.
 */
export class Landmarks {
  readonly group = new THREE.Group();
  readonly gates: FlightGate[] = [];
  readonly structures: LandmarkSummary[] = [];

  private readonly colliders: Collider[] = [];
  private readonly gateVisuals: GateVisual[] = [];
  private readonly beacons: Array<{ mat: THREE.MeshBasicMaterial; phase: number; base: THREE.Color }> = [];
  private readonly radarRotors: THREE.Object3D[] = [];

  private readonly steel = new PartBatch();
  private readonly concrete = new PartBatch();
  private readonly trim = new PartBatch();
  private readonly warmGlow = new PartBatch();
  private readonly cyanGlow = new PartBatch();

  private time = 0;
  private gatesCleared = 0;
  private courseElapsed = 0;
  private splitElapsed = 0;
  private _bestSec = Infinity;
  private completedCooldown = -1;
  private hasPrevPos = false;
  private readonly prevPos = new THREE.Vector3();
  private updatedThisTick = false;

  constructor(private readonly field?: HeightSampler) {
    this.group.name = 'landmarks';

    const rigPos = this.buildOffshoreRig();
    const bridgeInfo = this.buildCoastalBridge();
    const arches = this.buildCanyonArches();
    this.buildFlightCourse(rigPos, bridgeInfo, arches);
    this.commitBatches();
    this.refreshGateVisuals();
  }

  private sampleHeight(x: number, z: number): number {
    if (this.field) return this.field.heightAt(x, z);
    // Analytical fallback when no Heightfield is passed (e.g. unit tests)
    const shore = coastZ(x);
    return z > shore ? -60 : 54 + Math.max(0, (shore - z) * 0.08);
  }

  private addBoxCollider(label: string, cx: number, cy: number, cz: number, w: number, h: number, d: number, yaw = 0): void {
    this.colliders.push({
      kind: 'box',
      label,
      center: new THREE.Vector3(cx, cy, cz),
      half: new THREE.Vector3(w * 0.5, h * 0.5, d * 0.5),
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
    });
  }

  private addSegmentCollider(label: string, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
    this.colliders.push({
      kind: 'segment',
      label,
      a: a.clone(),
      b: b.clone(),
      ab: new THREE.Vector3().subVectors(b, a),
      lenSq: a.distanceToSquared(b),
      radius,
    });
  }

  private addBeacon(x: number, y: number, z: number, colorHex: number, radius = 0.85, phase = 0): void {
    const base = new THREE.Color(colorHex);
    const mat = new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(2.6), toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), mat);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    this.beacons.push({ mat, phase, base });
  }

  // ── 1. Offshore Stark / Oil Rig Platform (~3.6 km out to sea) ───────────

  private buildOffshoreRig(): THREE.Vector3 {
    const label = 'Offshore Stark Rig';
    let rx = -1600;
    let rz = 4400;
    // Step seaward if warped terrain put an island/shoal at the nominal point
    for (let i = 0; i < 10 && this.sampleHeight(rx, rz) > -8; i++) rz += 220;

    const seabed = Math.min(-35, this.sampleHeight(rx, rz) - 6);
    const deckBotY = 33;
    const deckTopY = 40.5;
    const legX = 26;
    const legZ = 24;

    // 4 heavy steel jacket legs leaving a clean 47 m wide × 33 m high under-deck gap
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = rx + sx * legX;
        const lz = rz + sz * legZ;
        const a = new THREE.Vector3(lx, seabed, lz);
        const b = new THREE.Vector3(lx, deckBotY + 3, lz);
        this.steel.add(cylBetween(a, b, 2.5, 2.3, 12));
        // Waterline hazard collar
        this.trim.add(new THREE.CylinderGeometry(2.75, 2.75, 4.5, 12).translate(lx, 2.2, lz));
        this.addSegmentCollider('Offshore Rig Leg', a, b, 2.5);
      }
      // Side X-bracing only on the outer ±X faces so north-south under-deck flight stays wide open
      const lx = rx + sx * legX;
      this.steel.add(cylBetween(new THREE.Vector3(lx, 2, rz - legZ), new THREE.Vector3(lx, deckBotY, rz + legZ), 0.7, 0.7, 8));
      this.steel.add(cylBetween(new THREE.Vector3(lx, 2, rz + legZ), new THREE.Vector3(lx, deckBotY, rz - legZ), 0.7, 0.7, 8));
    }

    // Lower and upper platform decks
    this.steel.add(boxGeo(68, 2.4, 62, rx, deckBotY + 1.2, rz));
    this.concrete.add(boxGeo(72, 2.5, 66, rx, deckTopY - 1.25, rz));
    this.addBoxCollider('Offshore Rig Deck', rx, (deckBotY + deckTopY) * 0.5, rz, 72, deckTopY - deckBotY, 66);

    // Glowing cyan/amber deck perimeter strips
    for (const sz of [-1, 1]) {
      this.warmGlow.add(boxGeo(72.4, 0.45, 0.4, rx, deckTopY - 0.3, rz + sz * 33.1));
    }
    for (const sx of [-1, 1]) {
      this.warmGlow.add(boxGeo(0.4, 0.45, 66.4, rx + sx * 36.1, deckTopY - 0.3, rz));
    }

    // Cantilevered Helipad on the northeast corner
    const hx = rx + 40;
    const hz = rz - 18;
    this.steel.add(cylBetween(new THREE.Vector3(rx + 28, deckBotY + 1, hz), new THREE.Vector3(hx, deckTopY - 1, hz), 1.1, 1.1, 8));
    this.concrete.add(new THREE.CylinderGeometry(13, 12, 1.4, 24).translate(hx, deckTopY + 0.5, hz));
    this.cyanGlow.add(new THREE.RingGeometry(11.6, 12.4, 32).rotateX(-Math.PI / 2).translate(hx, deckTopY + 1.25, hz));
    this.cyanGlow.add(boxGeo(1.0, 0.1, 7.5, hx - 2.6, deckTopY + 1.25, hz));
    this.cyanGlow.add(boxGeo(1.0, 0.1, 7.5, hx + 2.6, deckTopY + 1.25, hz));
    this.cyanGlow.add(boxGeo(5.2, 0.1, 1.0, hx, deckTopY + 1.25, hz));
    this.addBoxCollider('Offshore Rig Helipad', hx, deckTopY + 0.5, hz, 25, 2, 25);

    // Control module & living quarters on the west deck
    this.trim.add(boxGeo(20, 14, 24, rx - 20, deckTopY + 7, rz + 6));
    this.warmGlow.add(boxGeo(0.25, 2.2, 18, rx - 9.9, deckTopY + 10.5, rz + 6));
    this.cyanGlow.add(boxGeo(16, 1.8, 0.25, rx - 20, deckTopY + 10.5, rz - 6.1));
    this.addBoxCollider('Offshore Rig Superstructure', rx - 20, deckTopY + 7, rz + 6, 20, 14, 24);

    // Derrick / Flare Tower rising to y = 94 m
    const tx = rx + 8;
    const tz = rz + 6;
    const tBaseY = deckTopY;
    const tTopY = 92;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.steel.add(
          cylBetween(
            new THREE.Vector3(tx + sx * 6.5, tBaseY, tz + sz * 6.5),
            new THREE.Vector3(tx + sx * 2.1, tTopY, tz + sz * 2.1),
            0.55,
            0.35,
            8,
          ),
        );
      }
    }
    for (const h of [56, 72, 86]) {
      const k = 1 - (h - tBaseY) / (tTopY - tBaseY);
      const w = THREE.MathUtils.lerp(4.2, 13, k);
      this.steel.add(boxGeo(w, 1.1, w, tx, h, tz));
    }
    // Flare tip & glowing orange flame cone
    this.warmGlow.add(new THREE.ConeGeometry(2.6, 8.5, 10).translate(tx, tTopY + 4.5, tz));
    this.addBoxCollider('Offshore Rig Tower', tx, (tBaseY + tTopY) * 0.5, tz, 11, tTopY - tBaseY, 11);

    // Crane boom on SE deck
    const craneBase = new THREE.Vector3(rx + 24, deckTopY + 4, rz + 20);
    const craneTip = new THREE.Vector3(rx + 46, deckTopY + 24, rz + 32);
    this.trim.add(boxGeo(4, 6, 4, craneBase.x, craneBase.y - 1, craneBase.z));
    this.trim.add(cylBetween(craneBase, craneTip, 0.75, 0.45, 8));
    this.addSegmentCollider('Offshore Rig Crane', craneBase, craneTip, 1.2);

    // Aviation beacons & rig floodlight
    this.addBeacon(tx, tTopY + 9.2, tz, 0xff3b24, 1.1, 0);
    this.addBeacon(craneTip.x, craneTip.y + 0.6, craneTip.z, 0xff9f2e, 0.85, 1.4);
    this.addBeacon(hx + 12, deckTopY + 1.8, hz, 0x30f0ff, 0.7, 2.2);

    const rigLight = new THREE.PointLight(0xffad5c, 95, 240, 1.4);
    rigLight.position.set(rx, deckTopY + 18, rz);
    rigLight.castShadow = false;
    this.group.add(rigLight);

    const center = new THREE.Vector3(rx, 0, rz);
    this.structures.push({ id: 'offshore-rig', label, pos: center });
    return center;
  }

  // ── 2. Coastal Suspension Bridge spanning the bay west of HOME ──────────

  private buildCoastalBridge(): { center: THREE.Vector3; dir: THREE.Vector3; perp: THREE.Vector3; deckY: number } {
    const label = 'Coastal Suspension Bridge';
    const start = new THREE.Vector2(-620, 1060);
    const end = new THREE.Vector2(-1460, 820);
    const centerXZ = start.clone().add(end).multiplyScalar(0.5);
    const spanVec = end.clone().sub(start);
    const spanLen = spanVec.length();
    const dir2 = spanVec.clone().divideScalar(spanLen);
    const perp2 = new THREE.Vector2(-dir2.y, dir2.x);
    const yaw = -Math.atan2(dir2.y, dir2.x);

    const towerHalfSpan = 195;
    const towerGroundL = this.sampleHeight(centerXZ.x - dir2.x * towerHalfSpan, centerXZ.y - dir2.y * towerHalfSpan);
    const towerGroundR = this.sampleHeight(centerXZ.x + dir2.x * towerHalfSpan, centerXZ.y + dir2.y * towerHalfSpan);
    const deckY = Math.max(58, Math.max(towerGroundL, towerGroundR, 0) + 18);
    const towerTopY = deckY + 84;
    const halfWidth = 14;
    const pylonOffset = 16;

    const toWorld = (s: number, l: number, y: number) =>
      new THREE.Vector3(centerXZ.x + dir2.x * s + perp2.x * l, y, centerXZ.y + dir2.y * s + perp2.y * l);

    // Roadway deck & collider
    this.concrete.add(boxGeo(spanLen, 3.6, halfWidth * 2, centerXZ.x, deckY - 1.8, centerXZ.y, yaw));
    this.addBoxCollider('Coastal Bridge Deck', centerXZ.x, deckY - 1.8, centerXZ.y, spanLen, 3.6, halfWidth * 2, yaw);

    // Warm streetlights & edge strips along the deck
    for (let s = -spanLen * 0.46; s <= spanLen * 0.46; s += 38) {
      for (const side of [-1, 1]) {
        const lp = toWorld(s, side * (halfWidth - 1.2), deckY + 4.2);
        this.steel.add(boxGeo(0.35, 4.2, 0.35, lp.x, deckY + 2.1, lp.z, yaw));
        this.warmGlow.add(new THREE.SphereGeometry(0.65, 8, 6).translate(lp.x, lp.y, lp.z));
      }
    }

    // Twin main suspension towers
    for (const sgn of [-1, 1]) {
      const s = sgn * towerHalfSpan;
      const gnd = this.sampleHeight(centerXZ.x + dir2.x * s, centerXZ.y + dir2.y * s);
      const caissonBot = Math.min(-28, gnd - 8);
      const caissonTop = Math.max(8, gnd + 4);
      const caissonCenter = toWorld(s, 0, (caissonBot + caissonTop) * 0.5);
      this.concrete.add(boxGeo(16, caissonTop - caissonBot, 40, caissonCenter.x, caissonCenter.y, caissonCenter.z, yaw));
      this.addBoxCollider('Coastal Bridge Caisson', caissonCenter.x, caissonCenter.y, caissonCenter.z, 16, caissonTop - caissonBot, 40, yaw);

      // Pylon legs spaced ±16 m laterally so the suit can fly cleanly through the portal above the deck
      for (const side of [-1, 1]) {
        const l = side * pylonOffset;
        const bot = toWorld(s, l, caissonTop);
        const top = toWorld(s, l, towerTopY);
        this.trim.add(cylBetween(bot, top, 2.8, 2.0, 10));
        this.addSegmentCollider('Coastal Bridge Tower', bot, top, 2.6);
        this.addBeacon(top.x, top.y + 1.4, top.z, 0xff3b24, 1.1, sgn + side * 0.6);
      }

      // Horizontal portal struts (leaving deckY .. deckY + 38 m clear portal opening!)
      for (const py of [deckY - 6, deckY + 42, towerTopY - 4]) {
        const p = toWorld(s, 0, py);
        this.trim.add(boxGeo(4.2, 3.8, pylonOffset * 2, p.x, p.y, p.z, yaw));
        this.addBoxCollider('Coastal Bridge Tower Strut', p.x, p.y, p.z, 4.2, 3.8, pylonOffset * 2, yaw);
      }
    }

    // End anchorages & approach piers
    for (const sgn of [-1, 1]) {
      const s = sgn * (spanLen * 0.5 - 12);
      const gnd = this.sampleHeight(centerXZ.x + dir2.x * s, centerXZ.y + dir2.y * s);
      const bot = Math.min(-22, gnd - 8);
      const p = toWorld(s, 0, (bot + deckY) * 0.5);
      this.concrete.add(boxGeo(20, deckY - bot, 32, p.x, p.y, p.z, yaw));
      this.addBoxCollider('Coastal Bridge Anchorage', p.x, p.y, p.z, 20, deckY - bot, 32, yaw);
    }

    // Main catenary cables & vertical suspender cables
    const cableY = (s: number): number => {
      const absS = Math.abs(s);
      if (absS <= towerHalfSpan) {
        const u = absS / towerHalfSpan;
        return THREE.MathUtils.lerp(deckY + 10, towerTopY - 2, u * u);
      }
      const u = (absS - towerHalfSpan) / (spanLen * 0.5 - 12 - towerHalfSpan);
      return THREE.MathUtils.lerp(towerTopY - 2, deckY + 1, Math.min(1, u));
    };

    const segs = 28;
    for (const side of [-1, 1]) {
      const l = side * pylonOffset;
      for (let i = 0; i < segs; i++) {
        const s0 = THREE.MathUtils.lerp(-spanLen * 0.5 + 12, spanLen * 0.5 - 12, i / segs);
        const s1 = THREE.MathUtils.lerp(-spanLen * 0.5 + 12, spanLen * 0.5 - 12, (i + 1) / segs);
        const a = toWorld(s0, l, cableY(s0));
        const b = toWorld(s1, l, cableY(s1));
        this.steel.add(cylBetween(a, b, 0.55, 0.55, 6));
        if (i % 2 === 0) {
          const mid = a.clone().lerp(b, 0.5);
          this.warmGlow.add(new THREE.SphereGeometry(0.55, 6, 5).translate(mid.x, mid.y + 0.4, mid.z));
          const deckAttach = toWorld((s0 + s1) * 0.5, l * 0.88, deckY);
          this.steel.add(cylBetween(deckAttach, mid, 0.16, 0.16, 5));
        }
      }
    }

    const center = new THREE.Vector3(centerXZ.x, deckY, centerXZ.y);
    this.structures.push({ id: 'coastal-bridge', label, pos: center });
    return {
      center,
      dir: new THREE.Vector3(dir2.x, 0, dir2.y),
      perp: new THREE.Vector3(perp2.x, 0, perp2.y),
      deckY,
    };
  }

  // ── 3. Inland Canyon Radar Arches (3 monumental canyon spans) ───────────

  private findCanyonSite(nomX: number, nomZ: number): { x: number; z: number; floorY: number; spanYaw: number } {
    if (!this.field) {
      return { x: nomX, z: nomZ, floorY: this.sampleHeight(nomX, nomZ), spanYaw: 0 };
    }
    let bestScore = -Infinity;
    let bestX = nomX;
    let bestZ = nomZ;
    let bestFloor = this.sampleHeight(nomX, nomZ);
    let bestYaw = 0;

    for (let gx = -3; gx <= 3; gx++) {
      for (let gz = -3; gz <= 3; gz++) {
        const cx = nomX + gx * 115;
        const cz = nomZ + gz * 115;
        const floor = this.sampleHeight(cx, cz);
        if (floor < 35 || floor > 580) continue;
        for (let k = 0; k < 8; k++) {
          const yaw = (k / 8) * Math.PI;
          const ax = Math.cos(yaw);
          const az = Math.sin(yaw);
          const hL = this.sampleHeight(cx - ax * 95, cz - az * 95);
          const hR = this.sampleHeight(cx + ax * 95, cz + az * 95);
          const minWall = Math.min(hL, hR) - floor;
          const avgWall = (hL + hR) * 0.5 - floor;
          // Prefer a deep symmetric canyon saddle where both walls rise cleanly above the floor
          const score = minWall * 1.4 + avgWall - Math.abs(hL - hR) * 0.35;
          if (score > bestScore) {
            bestScore = score;
            bestX = cx;
            bestZ = cz;
            bestFloor = floor;
            bestYaw = yaw;
          }
        }
      }
    }
    return { x: bestX, z: bestZ, floorY: bestFloor, spanYaw: bestYaw };
  }

  private buildCanyonArches(): Array<{ center: THREE.Vector3; floorY: number; axis: THREE.Vector3 }> {
    const seeds: Array<[number, number, string]> = [
      [-1350, -780, 'Canyon Radar Arch Alpha'],
      [180, -1880, 'Canyon Radar Arch Bravo'],
      [1620, -960, 'Canyon Radar Arch Charlie'],
    ];
    const results: Array<{ center: THREE.Vector3; floorY: number; axis: THREE.Vector3 }> = [];

    seeds.forEach(([sx, sz, label], idx) => {
      const site = this.findCanyonSite(sx, sz);
      const halfSpan = 92;
      const crownRise = 114;
      const crownY = site.floorY + crownRise;
      // Span vector runs across the canyon; flight axis is perpendicular
      const spanDir = new THREE.Vector3(Math.cos(site.spanYaw), 0, Math.sin(site.spanYaw));
      const flightAxis = new THREE.Vector3(-spanDir.z, 0, spanDir.x);

      const segs = 16;
      const archPoint = (u: number): THREE.Vector3 => {
        // u in [-1, 1]
        const x = site.x + spanDir.x * (u * halfSpan);
        const z = site.z + spanDir.z * (u * halfSpan);
        const y = site.floorY + crownRise * (1 - u * u);
        return new THREE.Vector3(x, y, z);
      };

      // Deep concrete footings anchored into both canyon walls
      for (const sgn of [-1, 1]) {
        const fx = site.x + spanDir.x * (sgn * halfSpan);
        const fz = site.z + spanDir.z * (sgn * halfSpan);
        const wallY = this.sampleHeight(fx, fz);
        const bot = Math.min(site.floorY, wallY) - 24;
        const top = Math.max(site.floorY + 14, wallY + 8);
        this.concrete.add(boxGeo(14, top - bot, 14, fx, (bot + top) * 0.5, fz, -site.spanYaw));
        this.addBoxCollider(label, fx, (bot + top) * 0.5, fz, 14, top - bot, 14, -site.spanYaw);
      }

      // Parabolic monumental concrete/steel arch rib + glowing cyan edge nodes
      for (let i = 0; i < segs; i++) {
        const u0 = -1 + (2 * i) / segs;
        const u1 = -1 + (2 * (i + 1)) / segs;
        const a = archPoint(u0);
        const b = archPoint(u1);
        this.concrete.add(cylBetween(a, b, 3.8, 3.8, 8));
        this.addSegmentCollider(label, a, b, 3.8);
        if (i % 2 === 1) {
          this.cyanGlow.add(new THREE.SphereGeometry(0.95, 8, 6).translate(a.x, a.y - 3.6, a.z));
        }
      }

      // Crown radar housing + rotating dish array
      const crown = new THREE.Vector3(site.x, crownY + 4, site.z);
      this.trim.add(boxGeo(14, 7, 10, crown.x, crown.y, crown.z, -site.spanYaw));
      this.addBoxCollider(label, crown.x, crown.y, crown.z, 14, 7, 10, -site.spanYaw);

      const rotor = new THREE.Group();
      rotor.position.set(crown.x, crown.y + 6.5, crown.z);
      const dishMat = new THREE.MeshStandardMaterial({ color: 0x3b4858, metalness: 0.75, roughness: 0.35 });
      const dish = new THREE.Mesh(new THREE.BoxGeometry(16, 3.2, 1.4), dishMat);
      const tipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.2, 2.8), toneMapped: false });
      const tipL = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), tipMat);
      const tipR = tipL.clone();
      tipL.position.set(-8, 0, 0);
      tipR.position.set(8, 0, 0);
      rotor.add(dish, tipL, tipR);
      this.group.add(rotor);
      this.radarRotors.push(rotor);

      this.addBeacon(crown.x, crown.y + 10.5, crown.z, 0xff3b24, 1.0, idx * 1.3);
      const pos = new THREE.Vector3(site.x, site.floorY, site.z);
      this.structures.push({ id: `canyon-arch-${idx + 1}`, label, pos });
      results.push({ center: pos, floorY: site.floorY, axis: flightAxis });
    });

    return results;
  }

  // ── 4. Holographic JARVIS Flight Gate Course (11 gates) ─────────────────

  private buildFlightCourse(
    rigPos: THREE.Vector3,
    bridge: { center: THREE.Vector3; dir: THREE.Vector3; perp: THREE.Vector3; deckY: number },
    arches: Array<{ center: THREE.Vector3; floorY: number; axis: THREE.Vector3 }>,
  ): void {
    const gnd = (x: number, z: number) => Math.max(0, this.sampleHeight(x, z));

    const gateSpecs: Array<{ label: string; pos: THREE.Vector3; aimNext?: THREE.Vector3; normal?: THREE.Vector3 }> = [
      { label: 'Malibu Cliff Launch', pos: new THREE.Vector3(HOME.x - 160, HOME_HEIGHT + 34, HOME.y + 240) },
      { label: 'Sea Stack Skim', pos: new THREE.Vector3(-640, 48, 1280) },
      {
        label: 'Bridge Under-Span',
        pos: new THREE.Vector3(bridge.center.x, Math.max(22, bridge.deckY - 26), bridge.center.y),
        normal: bridge.perp.clone(),
      },
      { label: 'Pacific Sprint', pos: new THREE.Vector3(-1480, 42, 2650) },
      {
        label: 'Stark Rig Under-Deck',
        pos: new THREE.Vector3(rigPos.x, 18, rigPos.z),
        normal: new THREE.Vector3(0, 0, 1),
      },
      { label: 'Rig Flare Climb', pos: new THREE.Vector3(rigPos.x + 280, 145, rigPos.z - 520) },
      { label: 'Coastal Bluff Climb', pos: new THREE.Vector3(-1240, gnd(-1240, 220) + 75, 220) },
      {
        label: 'Canyon Arch Alpha',
        pos: new THREE.Vector3(arches[0].center.x, arches[0].floorY + 52, arches[0].center.y),
        normal: arches[0].axis.clone(),
      },
      {
        label: 'Canyon Arch Bravo',
        pos: new THREE.Vector3(arches[1].center.x, arches[1].floorY + 54, arches[1].center.y),
        normal: arches[1].axis.clone(),
      },
      {
        label: 'Canyon Arch Charlie',
        pos: new THREE.Vector3(arches[2].center.x, arches[2].floorY + 52, arches[2].center.y),
        normal: arches[2].axis.clone(),
      },
      { label: 'Malibu Terrace Finish', pos: new THREE.Vector3(HOME.x + 90, HOME_HEIGHT + 44, HOME.y - 140) },
    ];

    const outerGeo = new THREE.TorusGeometry(GATE_RADIUS, 0.72, 8, 48);
    const innerGeo = new THREE.TorusGeometry(GATE_RADIUS * 0.82, 0.38, 6, 36);
    const beaconGeo = new THREE.CylinderGeometry(0.35, 1.1, 110, 8, 1, true).translate(0, 55, 0);

    for (let i = 0; i < gateSpecs.length; i++) {
      const spec = gateSpecs[i];
      let normal = spec.normal;
      if (!normal) {
        const nextPos = gateSpecs[(i + 1) % gateSpecs.length].pos;
        normal = new THREE.Vector3().subVectors(nextPos, spec.pos);
        if (normal.lengthSq() < 1e-4) normal.set(0, 0, 1);
        normal.normalize();
      }
      // Make sure canyon/bridge normals point roughly along course flow
      if (i > 0 && spec.normal) {
        const flow = new THREE.Vector3().subVectors(spec.pos, gateSpecs[i - 1].pos);
        if (flow.dot(normal) < 0) normal.negate();
      }

      const gate: FlightGate = {
        index: i,
        label: spec.label,
        pos: spec.pos.clone(),
        normal: normal.normalize(),
        radius: GATE_PASS_RADIUS,
      };
      this.gates.push(gate);

      const gGroup = new THREE.Group();
      gGroup.position.copy(gate.pos);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), gate.normal);
      gGroup.quaternion.copy(q);

      const outerMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.2, 1.8, 2.2),
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
      });
      const innerMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(2.2, 1.35, 0.25),
        transparent: true,
        opacity: 0.85,
        toneMapped: false,
        wireframe: true,
      });
      const beaconMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.25, 1.9, 2.3),
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });

      const outerRing = new THREE.Mesh(outerGeo, outerMat);
      const innerRing = new THREE.Mesh(innerGeo, innerMat);
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      // Keep beacon upright in world space
      beacon.quaternion.copy(q).invert();

      gGroup.add(outerRing, innerRing, beacon);
      this.group.add(gGroup);
      this.gateVisuals.push({ group: gGroup, outerRing, innerRing, outerMat, innerMat, beacon, beaconMat });
    }
  }

  private commitBatches(): void {
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x26303c, metalness: 0.72, roughness: 0.42 });
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x6c727a, metalness: 0.12, roughness: 0.78 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x8b6226, metalness: 0.48, roughness: 0.48 });
    const warmMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.45, 0.55), toneMapped: false });
    const cyanMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 2.1, 2.5), toneMapped: false });

    const meshes = [
      this.steel.build(steelMat, 'landmarks-steel'),
      this.concrete.build(concreteMat, 'landmarks-concrete'),
      this.trim.build(trimMat, 'landmarks-trim'),
      this.warmGlow.build(warmMat, 'landmarks-warm-glow'),
      this.cyanGlow.build(cyanMat, 'landmarks-cyan-glow'),
    ];
    for (const m of meshes) if (m) this.group.add(m);
  }

  private refreshGateVisuals(): void {
    for (let i = 0; i < this.gateVisuals.length; i++) {
      const v = this.gateVisuals[i];
      const cleared = i < this.gatesCleared;
      const active = i === this.gatesCleared;
      if (active) {
        v.outerMat.color.setRGB(0.35, 2.2, 2.6);
        v.outerMat.opacity = 0.95;
        v.innerMat.color.setRGB(2.4, 1.45, 0.25);
        v.innerMat.opacity = 0.9;
        v.beacon.visible = true;
        v.beaconMat.opacity = 0.32;
        v.group.scale.setScalar(1);
      } else if (cleared) {
        v.outerMat.color.setRGB(0.25, 1.4, 0.7);
        v.outerMat.opacity = 0.26;
        v.innerMat.color.setRGB(0.25, 1.4, 0.7);
        v.innerMat.opacity = 0.18;
        v.beacon.visible = false;
        v.group.scale.setScalar(0.95);
      } else {
        v.outerMat.color.setRGB(0.18, 0.85, 1.25);
        v.outerMat.opacity = 0.36;
        v.innerMat.color.setRGB(0.25, 0.95, 1.35);
        v.innerMat.opacity = 0.24;
        v.beacon.visible = false;
        v.group.scale.setScalar(0.95);
      }
    }
  }

  private stepVisuals(dt: number, playerSpeed = 0): void {
    this.time += dt;
    const t = this.time;
    for (const b of this.beacons) {
      const pulse = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * 3.1 + b.phase), 4);
      b.mat.color.copy(b.base).multiplyScalar(0.6 + 2.4 * pulse);
    }
    for (let i = 0; i < this.radarRotors.length; i++) {
      this.radarRotors[i].rotation.y += dt * (0.65 + i * 0.12);
    }
    const active = this.gateVisuals[this.gatesCleared];
    if (active) {
      const spin = 0.9 + Math.min(2.0, playerSpeed / 180);
      active.innerRing.rotation.z += dt * spin;
      const pulse = 1 + 0.04 * Math.sin(t * 4.5);
      active.group.scale.setScalar(pulse);
      active.beaconMat.opacity = 0.24 + 0.12 * Math.sin(t * 5.0);
    }
  }

  /** Advance beacon/radar animations when `update` isn't driven directly by gameplay. */
  animate(dt: number): void {
    if (this.updatedThisTick) {
      this.updatedThisTick = false;
      return;
    }
    this.stepVisuals(dt);
  }

  /** Reset flight gate course progression while preserving `bestSec`. */
  resetCourse(): void {
    this.gatesCleared = 0;
    this.courseElapsed = 0;
    this.splitElapsed = 0;
    this.completedCooldown = -1;
    this.hasPrevPos = false;
    this.refreshGateVisuals();
  }

  /** Closest distance from `pos` to any physical landmark surface, or null if none. */
  nearestClearance(pos: THREE.Vector3): ClearanceResult | null {
    let bestDist = Infinity;
    let bestLabel = '';
    for (const c of this.colliders) {
      const d = c.kind === 'box' ? pointToBoxDist(pos, c) : pointToSegmentDist(pos, c);
      if (d < bestDist) {
        bestDist = d;
        bestLabel = c.label;
      }
    }
    return bestDist < Infinity ? { dist: bestDist, label: bestLabel } : null;
  }

  update(dt: number, playerPos: THREE.Vector3, playerSpeed: number): LandmarksUpdateResult {
    this.updatedThisTick = true;
    this.stepVisuals(dt, playerSpeed);

    const total = this.gates.length;
    if (this.completedCooldown >= 0) {
      this.completedCooldown -= dt;
      if (this.completedCooldown <= 0) this.resetCourse();
    }

    if (this.gatesCleared > 0 && this.gatesCleared < total) {
      this.courseElapsed += dt;
    }
    this.splitElapsed += dt;

    let gatePassed: GatePassResult | undefined;
    if (this.gatesCleared < total) {
      const gate = this.gates[this.gatesCleared];
      const p0 = this.hasPrevPos ? this.prevPos : playerPos;
      if (segmentPassesGate(p0, playerPos, gate, gate.radius)) {
        const index = this.gatesCleared;
        const splitSec = index === 0 ? 0 : this.splitElapsed;
        this.splitElapsed = 0;
        this.gatesCleared++;
        const courseComplete = this.gatesCleared >= total;
        if (courseComplete) {
          this._bestSec = Math.min(this._bestSec, this.courseElapsed);
          this.completedCooldown = COURSE_RESET_DELAY;
        }
        gatePassed = {
          index,
          total,
          splitSec,
          courseComplete,
          bestSec: Number.isFinite(this._bestSec) ? this._bestSec : 0,
        };
        this.refreshGateVisuals();
      }
    }

    this.prevPos.copy(playerPos);
    this.hasPrevPos = true;

    const activeGate = this.gatesCleared < total ? this.gates[this.gatesCleared] : null;
    return {
      ...(gatePassed ? { gatePassed } : {}),
      activeGatePos: activeGate ? activeGate.pos.clone() : null,
      gatesCleared: this.gatesCleared,
      totalGates: total,
    };
  }
}
