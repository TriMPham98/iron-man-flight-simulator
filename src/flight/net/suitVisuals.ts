import * as THREE from 'three';
import { forearmAxis, forearmNormal } from '../../suit/flightFlaps';
import { boneSpec } from '../../suit/rig';
import type { Suit } from '../../suit/Suit';
import { beam, box, frustum, glowMaterial, merge, paint } from '../combat/modelKit';
import { patchLogDepth } from '../render/depth';
import { hazeAll } from '../render/haze';
import type { SuitVariant } from './protocol';

/**
 * War Machine (Mk II) visual conversion & articulated weapons hardware for
 * both the local rigged GLB suit and remote multiplayer suits:
 *  - Re-tones the Mark III albedo atlas once into tactical gunmetal charcoal
 *    + brushed titanium silver (preserving all panel lines, scratches & AO)
 *  - Shifts the arc reactor / eye slits / repulsor emissive tint to War
 *    Machine's signature crimson-amber glow
 *  - Mounts an articulated 6-barrel M134 rotary minigun on a hydraulic right-
 *    shoulder servo pylon (with 2-axis gimbal tracking, barrel spin inertia,
 *    reciprocating breech recoil, cherry-hot barrel glow, star muzzle flash,
 *    and brass casing ejection port)
 *  - Mounts an elevating 6-tube armored micro-missile box pod on the left
 *    shoulder (with hinged blast lid, 6 animated warheads, and arming LEDs)
 *  - Mounts dorsal thermal radiator vent fins on the ammo spine (flare open
 *    during Thermal Unibeam discharge & overheat venting)
 *  - Mounts twin heavy forearm gauntlet cannon / Bunker-Buster rail pods on
 *    `forearm.L` and `forearm.R` (with sliding autocannon rails, hinged
 *    shrouds, Bunker-Buster warheads, crimson targeting lasers, and recoil).
 */

export const WM_POD_TUBES = 6;

export interface WarMachineWristPod {
  readonly side: 'L' | 'R';
  readonly root: THREE.Group;
  /** Sliding twin-barrel autocannon + rail carriage (translates along +Y). */
  readonly slide: THREE.Group;
  /** Hinged armored top cowl over the Bunker-Buster warhead. */
  readonly shroud: THREE.Group;
  /** Heavy Bunker-Buster warhead seated on the rail (hidden while bay reloads). */
  readonly warhead: THREE.Object3D;
  /** Amber-orange muzzle flash cone for twin wrist autocannons / launch blast. */
  readonly muzzleGlow: THREE.Mesh;
  /** Crimson targeting laser beam during Bunker-Buster lock. */
  readonly laser: THREE.Mesh;
  /** World-space muzzle position and bore direction (along forearm +Y). */
  muzzleWorld(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
}

export interface WarMachineAnimState {
  /** Normalized world-space aim direction (or null to hold neutral). */
  aimWorld: THREE.Vector3 | null;
  /** World quaternion of the chest / torso carrier for local gimbal math. */
  chestWorldQuat: THREE.Quaternion;
  /** M134 minigun is actively spooling / firing. */
  minigunFiring: boolean;
  /** One-frame impulse (0–1) when a minigun round just fired (triggers breech kick & flash). */
  minigunShot: boolean;
  /** Left-shoulder 6-tube missile pod deploy amount (0 stowed → 1 elevated & lid open). */
  podOpen: number;
  /** Armed rocket count in the 6-tube pod (0–6) for sequential slide-out & LEDs. */
  podArmed: number;
  /** Loaded rockets remaining in the 6-tube pod (0–6). */
  podLoaded: number;
  /** Dorsal thermal radiator vent flare (0 closed → 1 wide open during unibeam / venting). */
  ventOpen: number;
  /** Forearm Bunker-Buster deploy (0 stowed → 1 rails extended & shroud open). */
  wristDeploy: number;
  /** Bunker-Buster warhead loaded per arm [L, R]. */
  wristLoaded: readonly [boolean, boolean];
  /** Crimson target laser intensity per arm [L, R] (0–1). */
  wristLock: readonly [number, number];
  /** Dual-gauntlet flak sweep active (drives rapid reciprocating wrist barrel fire). */
  flakSweepActive: boolean;
  /** One-frame launch recoil kick on wrist [L, R]. */
  wristKickL?: boolean;
  wristKickR?: boolean;
}

export interface WarMachinePack {
  readonly root: THREE.Group;
  /** Hydraulic dorsal servo arm supporting the M134 turret. */
  readonly pylon: THREE.Group;
  /** Articulated right-shoulder minigun turret pivot (yaw + pitch). */
  readonly turret: THREE.Group;
  /** Reciprocating breech + barrel carriage inside `turret`. */
  readonly carriage: THREE.Group;
  /** Spinning 6-barrel cluster. */
  readonly barrels: THREE.Group;
  /** Muzzle flash star mesh. */
  readonly muzzleGlow: THREE.Mesh;
  /** Barrel-tip heat-glow material (emissive cherry-orange under sustained fire). */
  readonly barrelHeatMat: THREE.MeshStandardMaterial;
  /** Elevating left-shoulder 6-tube missile box pod. */
  readonly podPivot: THREE.Group;
  /** Hinged armored blast door over the 6 missile tubes. */
  readonly podLid: THREE.Group;
  /** 6 individual warheads inside the left-shoulder pod tubes. */
  readonly podMissiles: THREE.Object3D[];
  /** 6 LED status materials on the pod bezel. */
  readonly podLeds: THREE.MeshBasicMaterial[];
  /** Dorsal thermal radiator cooling vents (L / R). */
  readonly ventL: THREE.Group;
  readonly ventR: THREE.Group;
  /** Twin forearm armored autocannon + Bunker-Buster pods. */
  readonly wristL: WarMachineWristPod;
  readonly wristR: WarMachineWristPod;
  /** Live animation state (updated by `animateWarMachinePack`). */
  readonly anim: {
    time: number;
    barrelSpeed: number;
    barrelHeat: number;
    recoil: number;
    muzzleFlashT: number;
    podOpen: number;
    ventOpen: number;
    wristDeploy: number;
    wristRecoilL: number;
    wristRecoilR: number;
  };
  /** World-space M134 barrel tip position and firing axis. */
  minigunMuzzle(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
  /** World-space M134 shell ejection port position and outward throw vector. */
  ejectionPort(outPos: THREE.Vector3, outDir: THREE.Vector3): void;
  /** World-space launch point and bore axis for left-shoulder missile tube `cell` (0–5). */
  podMuzzle(cell: number, outPos: THREE.Vector3, outDir: THREE.Vector3): void;
}

const WM = {
  gunmetal: 0x3b424c,
  plate: 0x5c6674,
  silver: 0x9aa4b2,
  dark: 0x20252c,
  barrel: 0x2a2f37,
  accent: 0xb82820,
  brass: 0xc89a40,
};

const LED_OFF = new THREE.Color(0x160a08);
const LED_ARMING = new THREE.Color(0xff9b26).multiplyScalar(2.2);
const LED_ARMED = new THREE.Color(0xff3824).multiplyScalar(2.6);

/** Local tube offsets (relative to `podPivot`) for the 6-tube left-shoulder pod. */
const POD_TUBE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.04, 0.022, 0.11],
  [0.0, 0.022, 0.11],
  [0.04, 0.022, 0.11],
  [-0.04, -0.022, 0.11],
  [0.0, -0.022, 0.11],
  [0.04, -0.022, 0.11],
];

interface PackGeo {
  chassis: THREE.BufferGeometry;
  pylonArm: THREE.BufferGeometry;
  turretBody: THREE.BufferGeometry;
  barrels: THREE.BufferGeometry;
  barrelTips: THREE.BufferGeometry;
  muzzleGlow: THREE.BufferGeometry;
  podBody: THREE.BufferGeometry;
  podLid: THREE.BufferGeometry;
  podMissile: THREE.BufferGeometry;
  ventFin: THREE.BufferGeometry;
  wristHousing: THREE.BufferGeometry;
  wristSlide: THREE.BufferGeometry;
  wristShroud: THREE.BufferGeometry;
  wristWarhead: THREE.BufferGeometry;
  wristMuzzleGlow: THREE.BufferGeometry;
}

let packGeoCache: PackGeo | null = null;

function buildPackGeometry(): PackGeo {
  if (packGeoCache) return packGeoCache;

  // ── Dorsal ammo spine + mounts (bind-space relative to chest origin: +Z front, +X left, -X right) ──
  const chassisParts: THREE.BufferGeometry[] = [
    // Heavy dorsal ammo drum & armored spine housing
    frustum({ hw0: 0.145, z0: -0.1, z1: -0.25, y0: -0.15, hw1: 0.175, z2: -0.11, z3: -0.28, y1: 0.14 }, (e) =>
      e === 2 ? WM.plate : WM.gunmetal,
    ),
    // Armored spine rib, ammo belt drum & tactical red stripe
    box(0.085, 0.25, 0.042, WM.silver, 0, 0.0, -0.282),
    box(0.185, 0.032, 0.042, WM.accent, 0, 0.082, -0.275),
    paint(new THREE.CylinderGeometry(0.068, 0.068, 0.18, 12).rotateZ(Math.PI / 2).translate(-0.04, -0.02, -0.25), WM.dark),
    // Left-shoulder structural bracket for elevating missile pod
    beam([0.14, 0.08, -0.18], [0.22, 0.21, -0.12], 0.026, WM.dark, 6),
    box(0.075, 0.06, 0.08, WM.plate, 0.225, 0.21, -0.12),
  ];

  // ── Right-shoulder hydraulic servo pylon arm (pivots at dorsal shoulder mount) ──
  const pylonParts: THREE.BufferGeometry[] = [
    beam([0, 0, 0], [-0.09, 0.16, 0.06], 0.028, WM.dark, 6),
    beam([0.03, -0.05, -0.02], [-0.07, 0.12, 0.04], 0.02, WM.silver, 6),
    box(0.082, 0.072, 0.095, WM.plate, -0.09, 0.17, 0.07),
    box(0.09, 0.024, 0.06, WM.accent, -0.09, 0.18, 0.07),
  ];

  // ── Right-shoulder M134 receiver, breech & ammo feed chute (carriage local space) ──
  const turretParts: THREE.BufferGeometry[] = [
    // Main heavy receiver housing
    box(0.115, 0.115, 0.29, WM.gunmetal, 0, 0, -0.02),
    box(0.125, 0.036, 0.21, WM.silver, 0, 0.058, -0.03),
    // Red tactical stripe on receiver flank
    box(0.12, 0.022, 0.085, WM.accent, 0, 0.01, 0.04),
    // Side drum ammo feed chute (+X inboard) & brass ejection chute (-X outboard)
    box(0.055, 0.085, 0.15, WM.dark, 0.072, -0.02, -0.05),
    box(0.032, 0.042, 0.07, WM.brass, -0.068, -0.01, 0.02),
    // Optical target sensor pod on top of receiver
    box(0.048, 0.044, 0.075, WM.dark, -0.03, 0.09, 0.035),
    box(0.03, 0.022, 0.014, WM.accent, -0.03, 0.09, 0.074),
  ];

  // ── 6-barrel rotary cluster (spins around +Z) ──
  const barrelParts: THREE.BufferGeometry[] = [];
  const tipParts: THREE.BufferGeometry[] = [];
  const barrelRadius = 0.031;
  const barrelLen = 0.45;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bx = Math.cos(a) * barrelRadius;
    const by = Math.sin(a) * barrelRadius;
    barrelParts.push(
      paint(
        new THREE.CylinderGeometry(0.0085, 0.0085, barrelLen, 6)
          .rotateX(Math.PI / 2)
          .translate(bx, by, barrelLen * 0.5),
        WM.barrel,
      ),
    );
    // Glowing heat-retaining barrel tips
    tipParts.push(
      new THREE.CylinderGeometry(0.0096, 0.0092, 0.12, 6)
        .rotateX(Math.PI / 2)
        .translate(bx, by, barrelLen - 0.055),
    );
  }
  // Barrel clamp collars
  for (const z of [0.08, 0.25, 0.41]) {
    barrelParts.push(
      paint(
        new THREE.CylinderGeometry(0.044, 0.044, 0.024, 12)
          .rotateX(Math.PI / 2)
          .translate(0, 0, z),
        WM.silver,
      ),
    );
  }

  // Multi-fin star muzzle flash at barrel tip
  const flashParts: THREE.BufferGeometry[] = [
    paint(new THREE.ConeGeometry(0.052, 0.22, 8).rotateX(Math.PI / 2).translate(0, 0, 0.56), new THREE.Color(1.0, 0.78, 0.34), 6),
    paint(new THREE.BoxGeometry(0.18, 0.026, 0.09).translate(0, 0, 0.50), new THREE.Color(1.0, 0.58, 0.16), 5),
    paint(new THREE.BoxGeometry(0.026, 0.18, 0.09).translate(0, 0, 0.50), new THREE.Color(1.0, 0.58, 0.16), 5),
  ];

  // ── Left-shoulder elevating 6-tube missile box pod (podPivot local space) ──
  const podParts: THREE.BufferGeometry[] = [
    box(0.155, 0.125, 0.23, WM.gunmetal, 0, 0, 0),
    box(0.162, 0.026, 0.21, WM.silver, 0, 0.068, -0.005),
    box(0.158, 0.024, 0.065, WM.accent, 0, 0, 0.06),
    // Recessed dark front bezel plate
    box(0.14, 0.105, 0.015, WM.dark, 0, 0, 0.112),
  ];
  for (const [tx, ty, tz] of POD_TUBE_OFFSETS) {
    podParts.push(
      paint(new THREE.CylinderGeometry(0.017, 0.017, 0.016, 10).rotateX(Math.PI / 2).translate(tx, ty, tz + 0.006), WM.silver),
      paint(new THREE.CylinderGeometry(0.0135, 0.0135, 0.018, 10).rotateX(Math.PI / 2).translate(tx, ty, tz + 0.008), WM.dark),
    );
  }

  // Hinged armored blast lid over the 6 tubes (pivots along top front edge at y = +0.062, z = +0.118)
  const podLid = merge([
    box(0.156, 0.122, 0.016, WM.plate, 0, -0.061, 0.008),
    box(0.14, 0.024, 0.019, WM.accent, 0, -0.061, 0.01),
    box(0.12, 0.012, 0.02, WM.silver, 0, -0.105, 0.01),
  ]);

  // Individual micro-missile warhead seated in each tube
  const podMissile = merge([
    paint(new THREE.CylinderGeometry(0.011, 0.011, 0.045, 8).rotateX(Math.PI / 2).translate(0, 0, -0.015), WM.silver),
    paint(new THREE.ConeGeometry(0.011, 0.032, 8).rotateX(Math.PI / 2).translate(0, 0, 0.023), WM.accent),
  ]);

  // ── Dorsal thermal radiator vent fin (hinges out from ammo spine) ──
  const ventFin = merge([
    box(0.065, 0.16, 0.018, WM.plate, 0.032, 0, 0),
    box(0.048, 0.13, 0.022, WM.dark, 0.032, 0, 0.004),
    box(0.052, 0.022, 0.024, WM.accent, 0.032, 0.055, 0.004),
  ]);

  // ── Twin Forearm Gauntlet Autocannon / Bunker-Buster Rail Pod ──
  // Local frame: +X outward from forearm, +Y along forearm toward hand, +Z lateral
  const wristHousing = merge([
    box(0.038, 0.175, 0.072, WM.gunmetal, 0, 0, 0),
    box(0.042, 0.12, 0.076, WM.plate, 0.004, -0.015, 0),
    box(0.044, 0.028, 0.078, WM.accent, 0.004, 0.032, 0),
    // Side rail tracks
    box(0.018, 0.185, 0.012, WM.silver, 0.016, 0.005, 0.034),
    box(0.018, 0.185, 0.012, WM.silver, 0.016, 0.005, -0.034),
  ]);

  // Sliding twin autocannon barrels + central Bunker-Buster launch rail (+Y = forward)
  const wristSlide = merge([
    box(0.024, 0.15, 0.058, WM.dark, 0.018, 0.015, 0),
    // Twin stubby forearm autocannon barrels flanking the Bunker-Buster bay
    paint(new THREE.CylinderGeometry(0.0085, 0.0095, 0.175, 8).translate(0.018, 0.06, 0.024), WM.barrel),
    paint(new THREE.CylinderGeometry(0.0085, 0.0095, 0.175, 8).translate(0.018, 0.06, -0.024), WM.barrel),
    // Barrel muzzle shrouds
    paint(new THREE.CylinderGeometry(0.011, 0.011, 0.022, 8).translate(0.018, 0.14, 0.024), WM.silver),
    paint(new THREE.CylinderGeometry(0.011, 0.011, 0.022, 8).translate(0.018, 0.14, -0.024), WM.silver),
  ]);

  // Hinged top shroud over the central Bunker-Buster bay (pivots near elbow y = -0.065)
  const wristShroud = merge([
    box(0.012, 0.135, 0.044, WM.silver, 0.006, 0.068, 0),
    box(0.014, 0.022, 0.046, WM.accent, 0.006, 0.11, 0),
  ]);

  // Oversized Bunker-Buster ("EX-WIFE") heavy warhead seated in the forearm bay
  const wristWarhead = merge([
    paint(new THREE.CylinderGeometry(0.0135, 0.0135, 0.095, 10).translate(0, 0.02, 0), WM.plate),
    paint(new THREE.ConeGeometry(0.0135, 0.038, 10).translate(0, 0.086, 0), WM.accent),
    paint(new THREE.CylinderGeometry(0.0145, 0.0145, 0.012, 10).translate(0, 0.056, 0), WM.brass),
  ]);

  // Dual-barrel amber muzzle flash cone (along +Y)
  const wristMuzzleGlow = merge([
    paint(new THREE.ConeGeometry(0.026, 0.12, 7).translate(0.018, 0.21, 0.024), new THREE.Color(1.0, 0.68, 0.24), 5),
    paint(new THREE.ConeGeometry(0.026, 0.12, 7).translate(0.018, 0.21, -0.024), new THREE.Color(1.0, 0.68, 0.24), 5),
  ]);

  packGeoCache = {
    chassis: merge(chassisParts),
    pylonArm: merge(pylonParts),
    turretBody: merge(turretParts),
    barrels: merge(barrelParts),
    barrelTips: merge(tipParts),
    muzzleGlow: merge(flashParts),
    podBody: merge(podParts),
    podLid,
    podMissile,
    ventFin,
    wristHousing,
    wristSlide,
    wristShroud,
    wristWarhead,
    wristMuzzleGlow,
  };
  return packGeoCache;
}

function buildWristPod(
  side: 'L' | 'R',
  g: PackGeo,
  mat: THREE.MeshStandardMaterial,
  glowMat: THREE.MeshStandardMaterial,
): WarMachineWristPod {
  const root = new THREE.Group();
  root.name = `warmachine-wrist-${side}`;

  const housing = new THREE.Mesh(g.wristHousing, mat);
  housing.castShadow = true;
  root.add(housing);

  const slide = new THREE.Group();
  const slideMesh = new THREE.Mesh(g.wristSlide, mat);
  slideMesh.castShadow = true;
  slide.add(slideMesh);

  const warhead = new THREE.Mesh(g.wristWarhead, mat);
  warhead.position.set(0.032, 0.02, 0);
  slide.add(warhead);

  const muzzleGlow = new THREE.Mesh(g.wristMuzzleGlow, glowMat);
  muzzleGlow.visible = false;
  slide.add(muzzleGlow);

  // Crimson targeting laser along +Y
  const laserLen = 2.2;
  const laserGeo = new THREE.CylinderGeometry(0.0022, 0.0022, laserLen, 6, 1, true);
  laserGeo.translate(0, laserLen * 0.5, 0);
  const laserMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.18, 0.08).multiplyScalar(3),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const laser = new THREE.Mesh(laserGeo, laserMat);
  laser.position.set(0.032, 0.125, 0);
  laser.visible = false;
  slide.add(laser);

  root.add(slide);

  const shroud = new THREE.Group();
  shroud.position.set(0.038, -0.055, 0);
  const shroudMesh = new THREE.Mesh(g.wristShroud, mat);
  shroudMesh.castShadow = true;
  shroud.add(shroudMesh);
  root.add(shroud);

  const muzzleLocal = new THREE.Vector3(0.024, 0.165, 0);
  const boreLocal = new THREE.Vector3(0, 1, 0);

  return {
    side,
    root,
    slide,
    shroud,
    warhead,
    muzzleGlow,
    laser,
    muzzleWorld(outPos: THREE.Vector3, outDir: THREE.Vector3) {
      slide.updateWorldMatrix(true, false);
      outPos.copy(muzzleLocal).applyMatrix4(slide.matrixWorld);
      outDir.copy(boreLocal).transformDirection(slide.matrixWorld).normalize();
    },
  };
}

/** Build a War Machine dorsal weapon pack + twin forearm weapon pods. */
export function buildWarMachinePack(hazeUniforms?: Record<string, THREE.IUniform>): WarMachinePack {
  const g = buildPackGeometry();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.78,
    roughness: 0.34,
  });
  const glowMat = glowMaterial();
  const barrelHeatMat = new THREE.MeshStandardMaterial({
    color: WM.barrel,
    emissive: new THREE.Color(0xff4208),
    emissiveIntensity: 0,
    metalness: 0.85,
    roughness: 0.28,
  });

  const root = new THREE.Group();
  root.name = 'warmachine-pack';

  const chassis = new THREE.Mesh(g.chassis, mat);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  root.add(chassis);

  // ── Right-shoulder hydraulic pylon + M134 rotary minigun ──
  const pylon = new THREE.Group();
  pylon.position.set(-0.14, 0.10, -0.19);
  const pylonMesh = new THREE.Mesh(g.pylonArm, mat);
  pylonMesh.castShadow = true;
  pylon.add(pylonMesh);

  const turret = new THREE.Group();
  turret.position.set(-0.09, 0.18, 0.14);

  const carriage = new THREE.Group();
  const receiver = new THREE.Mesh(g.turretBody, mat);
  receiver.castShadow = true;
  carriage.add(receiver);

  const barrels = new THREE.Group();
  barrels.position.set(0, 0, 0.11);
  const barrelMesh = new THREE.Mesh(g.barrels, mat);
  barrelMesh.castShadow = true;
  barrels.add(barrelMesh);

  const tipMesh = new THREE.Mesh(g.barrelTips, barrelHeatMat);
  barrels.add(tipMesh);
  carriage.add(barrels);

  const muzzleGlow = new THREE.Mesh(g.muzzleGlow, glowMat);
  muzzleGlow.visible = false;
  carriage.add(muzzleGlow);

  turret.add(carriage);
  pylon.add(turret);
  root.add(pylon);

  // ── Left-shoulder elevating 6-tube missile box pod ──
  const podPivot = new THREE.Group();
  podPivot.position.set(0.23, 0.23, -0.07);
  const podMesh = new THREE.Mesh(g.podBody, mat);
  podMesh.castShadow = true;
  podPivot.add(podMesh);

  const podLid = new THREE.Group();
  podLid.position.set(0, 0.062, 0.118);
  const lidMesh = new THREE.Mesh(g.podLid, mat);
  lidMesh.castShadow = true;
  podLid.add(lidMesh);
  podPivot.add(podLid);

  const podMissiles: THREE.Object3D[] = [];
  const podLeds: THREE.MeshBasicMaterial[] = [];
  const ledGeo = new THREE.BoxGeometry(0.014, 0.008, 0.006);
  for (let i = 0; i < WM_POD_TUBES; i++) {
    const [tx, ty, tz] = POD_TUBE_OFFSETS[i];
    const m = new THREE.Mesh(g.podMissile, mat);
    m.position.set(tx, ty, tz - 0.015);
    podPivot.add(m);
    podMissiles.push(m);

    const ledMat = new THREE.MeshBasicMaterial({ color: LED_OFF.clone(), toneMapped: false });
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.set(-0.055 + (i / (WM_POD_TUBES - 1)) * 0.11, -0.055, 0.122);
    podPivot.add(led);
    podLeds.push(ledMat);
  }
  root.add(podPivot);

  // ── Dorsal thermal radiator vent fins (L/R on ammo spine) ──
  const ventL = new THREE.Group();
  ventL.position.set(0.095, 0.0, -0.265);
  ventL.add(new THREE.Mesh(g.ventFin, mat));
  root.add(ventL);

  const ventR = new THREE.Group();
  ventR.position.set(-0.095, 0.0, -0.265);
  const ventRMesh = new THREE.Mesh(g.ventFin, mat);
  ventRMesh.scale.x = -1;
  ventR.add(ventRMesh);
  root.add(ventR);

  // ── Twin forearm pods ──
  const wristL = buildWristPod('L', g, mat, glowMat);
  const wristR = buildWristPod('R', g, mat, glowMat);

  patchLogDepth(root);
  patchLogDepth(wristL.root);
  patchLogDepth(wristR.root);
  if (hazeUniforms) {
    hazeAll(root, hazeUniforms);
    hazeAll(wristL.root, hazeUniforms);
    hazeAll(wristR.root, hazeUniforms);
  }

  const anim = {
    time: 0,
    barrelSpeed: 0,
    barrelHeat: 0,
    recoil: 0,
    muzzleFlashT: 0,
    podOpen: 0,
    ventOpen: 0,
    wristDeploy: 0,
    wristRecoilL: 0,
    wristRecoilR: 0,
  };

  const muzzleLocal = new THREE.Vector3(0, 0, 0.57);
  const ejectLocal = new THREE.Vector3(-0.078, -0.01, 0.02);
  const fwdLocal = new THREE.Vector3(0, 0, 1);
  const ejectDirLocal = new THREE.Vector3(-0.92, 0.28, -0.15).normalize();
  const tubeLocal = new THREE.Vector3();

  return {
    root,
    pylon,
    turret,
    carriage,
    barrels,
    muzzleGlow,
    barrelHeatMat,
    podPivot,
    podLid,
    podMissiles,
    podLeds,
    ventL,
    ventR,
    wristL,
    wristR,
    anim,
    minigunMuzzle(outPos: THREE.Vector3, outDir: THREE.Vector3) {
      carriage.updateWorldMatrix(true, false);
      outPos.copy(muzzleLocal).applyMatrix4(carriage.matrixWorld);
      outDir.copy(fwdLocal).transformDirection(carriage.matrixWorld).normalize();
    },
    ejectionPort(outPos: THREE.Vector3, outDir: THREE.Vector3) {
      carriage.updateWorldMatrix(true, false);
      outPos.copy(ejectLocal).applyMatrix4(carriage.matrixWorld);
      outDir.copy(ejectDirLocal).transformDirection(carriage.matrixWorld).normalize();
    },
    podMuzzle(cell: number, outPos: THREE.Vector3, outDir: THREE.Vector3) {
      podPivot.updateWorldMatrix(true, false);
      const idx = ((cell % WM_POD_TUBES) + WM_POD_TUBES) % WM_POD_TUBES;
      const [tx, ty, tz] = POD_TUBE_OFFSETS[idx];
      outPos.copy(tubeLocal.set(tx, ty, tz + 0.035)).applyMatrix4(podPivot.matrixWorld);
      outDir.copy(fwdLocal).transformDirection(podPivot.matrixWorld).normalize();
    },
  };
}

const _invQ = new THREE.Quaternion();
const _localAim = new THREE.Vector3();

/**
 * Step all mechanical animations on a War Machine pack for one frame:
 *  - M134 gimbal yaw/pitch tracking + hydraulic pylon rise
 *  - Rotary barrel inertia spin-up/down + reciprocating breech recoil + barrel heat glow
 *  - Left-shoulder 6-tube missile pod elevation + blast lid hinge + warhead slide-out & LEDs
 *  - Dorsal thermal radiator vent fin flare
 *  - Forearm Bunker-Buster / twin autocannon rail extension, shroud hinge, recoil & laser.
 */
export function animateWarMachinePack(pack: WarMachinePack, dt: number, s: WarMachineAnimState): void {
  const a = pack.anim;
  a.time += dt;

  // ── 1. M134 Rotary Minigun tracking, spin inertia, recoil & heat ──
  const trackK = 1 - Math.exp(-dt * 15);
  if (s.aimWorld && s.aimWorld.lengthSq() > 1e-4) {
    _invQ.copy(s.chestWorldQuat).invert();
    _localAim.copy(s.aimWorld).applyQuaternion(_invQ).normalize();
    const yaw = THREE.MathUtils.clamp(Math.atan2(_localAim.x, Math.max(0.18, _localAim.z)), -0.82, 0.82);
    const pitch = THREE.MathUtils.clamp(-Math.asin(THREE.MathUtils.clamp(_localAim.y, -0.82, 0.82)), -0.72, 0.72);
    pack.turret.rotation.y = THREE.MathUtils.lerp(pack.turret.rotation.y, yaw, trackK);
    pack.turret.rotation.x = THREE.MathUtils.lerp(pack.turret.rotation.x, pitch, trackK);
  }

  // Barrel angular inertia: spins up sharply when firing, coasts down realistically
  const targetSpin = s.minigunFiring ? 52 : 0;
  const spinRate = s.minigunFiring ? 14 : 3.2;
  a.barrelSpeed += (targetSpin - a.barrelSpeed) * (1 - Math.exp(-dt * spinRate));
  if (!s.minigunFiring && a.barrelSpeed < 0.08) a.barrelSpeed = 0;
  pack.barrels.rotation.z += a.barrelSpeed * dt;

  // Recoil kick & muzzle flash per fired round
  if (s.minigunShot) {
    a.recoil = 1;
    a.muzzleFlashT = 0.048;
  }
  a.recoil *= Math.exp(-dt * 24);
  a.muzzleFlashT = Math.max(0, a.muzzleFlashT - dt);
  pack.carriage.position.z = -0.042 * a.recoil;

  // Hydraulic pylon rises subtly when spooled up & shudders under recoil
  const spoolNorm = THREE.MathUtils.clamp(a.barrelSpeed / 48, 0, 1);
  pack.pylon.position.y = 0.10 + 0.022 * spoolNorm;
  pack.pylon.rotation.x = -0.055 * a.recoil;

  // Star muzzle flash: flickers and rotates between rounds
  const flashOn = a.muzzleFlashT > 0 || (s.minigunFiring && a.barrelSpeed > 26 && Math.sin(a.time * 105) > 0.05);
  pack.muzzleGlow.visible = flashOn;
  if (flashOn) {
    pack.muzzleGlow.rotation.z = a.time * 37;
    const sc = 0.82 + 0.38 * Math.sin(a.time * 130);
    pack.muzzleGlow.scale.set(sc, sc, 0.9 + 0.35 * a.recoil);
  }

  // Barrel thermal glow builds under fire and cools gradually
  if (s.minigunFiring) a.barrelHeat = Math.min(1, a.barrelHeat + dt * 0.42);
  else a.barrelHeat = Math.max(0, a.barrelHeat - dt * 0.22);
  pack.barrelHeatMat.emissiveIntensity = a.barrelHeat * a.barrelHeat * 3.2;

  // ── 2. Left-shoulder 6-tube missile box pod elevation, blast lid & armed tubes ──
  a.podOpen += (THREE.MathUtils.clamp(s.podOpen, 0, 1) - a.podOpen) * (1 - Math.exp(-dt * 12));
  const po = a.podOpen;
  // Pod tilts upward slightly into firing elevation as it deploys
  pack.podPivot.rotation.x = -0.26 * po;
  pack.podPivot.position.y = 0.23 + 0.032 * po;
  // Armored blast lid swings open cleanly over the top
  pack.podLid.rotation.x = -1.78 * THREE.MathUtils.smoothstep(po, 0.05, 0.72);
  const lidReady = THREE.MathUtils.smoothstep(po, 0.65, 1.0);
  for (let i = 0; i < WM_POD_TUBES; i++) {
    const loaded = i < s.podLoaded;
    const m = pack.podMissiles[i];
    m.visible = loaded;
    const armK = THREE.MathUtils.clamp(s.podArmed - i, 0, 1) * lidReady;
    const [, , tz] = POD_TUBE_OFFSETS[i];
    m.position.z = tz - 0.015 + 0.026 * armK;
    const led = pack.podLeds[i].color;
    if (!loaded || lidReady < 0.8) led.copy(LED_OFF);
    else if (armK >= 0.95) led.copy(LED_ARMED);
    else led.copy(LED_ARMING);
  }

  // ── 3. Dorsal thermal radiator vent fins (flare during Thermal Unibeam / cooling) ──
  a.ventOpen += (THREE.MathUtils.clamp(s.ventOpen, 0, 1) - a.ventOpen) * (1 - Math.exp(-dt * 10));
  pack.ventL.rotation.y = -0.78 * a.ventOpen;
  pack.ventR.rotation.y = 0.78 * a.ventOpen;

  // ── 4. Twin forearm gauntlet autocannon / Bunker-Buster rail pods ──
  const wantWrist = Math.max(s.wristDeploy, s.flakSweepActive ? 1 : 0);
  a.wristDeploy += (THREE.MathUtils.clamp(wantWrist, 0, 1) - a.wristDeploy) * (1 - Math.exp(-dt * 14));
  if (s.wristKickL) a.wristRecoilL = 1;
  if (s.wristKickR) a.wristRecoilR = 1;
  if (s.flakSweepActive) {
    // Alternating rapid twin-gauntlet flak cannon reciprocation during C sweep
    a.wristRecoilL = Math.max(a.wristRecoilL, 0.5 + 0.5 * Math.sin(a.time * 58));
    a.wristRecoilR = Math.max(a.wristRecoilR, 0.5 + 0.5 * Math.sin(a.time * 58 + Math.PI));
  }
  a.wristRecoilL *= Math.exp(-dt * 16);
  a.wristRecoilR *= Math.exp(-dt * 16);

  const updateWrist = (pod: WarMachineWristPod, loaded: boolean, lock: number, recoil: number, phase: number) => {
    pod.slide.position.y = 0.048 * a.wristDeploy - 0.032 * recoil;
    // Armored top shroud hinges open for Bunker-Buster deployment
    pod.shroud.rotation.z = -1.35 * THREE.MathUtils.smoothstep(s.wristDeploy, 0.1, 0.8);
    pod.warhead.visible = loaded;
    const laserOn = s.wristDeploy > 0.85 && lock > 0.05 && loaded;
    pod.laser.visible = laserOn;
    if (laserOn) {
      (pod.laser.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(lock, 0.15, 1) * 0.85;
    }
    const flash = (s.flakSweepActive && Math.sin(a.time * 68 + phase) > -0.15) || recoil > 0.55;
    pod.muzzleGlow.visible = flash;
    if (flash) {
      const sc = 0.85 + 0.35 * Math.sin(a.time * 95 + phase);
      pod.muzzleGlow.scale.set(sc, 0.9 + 0.3 * recoil, sc);
    }
  };
  updateWrist(pack.wristL, s.wristLoaded[0], s.wristLock[0], a.wristRecoilL, 0);
  updateWrist(pack.wristR, s.wristLoaded[1], s.wristLock[1], a.wristRecoilR, Math.PI);
}

/**
 * Place a War Machine wrist pod onto the local suit's `forearm.L` or `forearm.R` bone,
 * aligned with the forearm's outward normal (+X) and elbow→hand axis (+Y).
 */
function attachWristPodToBone(suit: Suit, pod: WarMachineWristPod): void {
  const boneName = `forearm.${pod.side}` as const;
  const bone = suit.rig?.bones?.[boneName];
  if (!bone) return;
  const spec = boneSpec(boneName);
  const y = forearmAxis(pod.side);
  const x = forearmNormal(pod.side);
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const len = new THREE.Vector3(...spec.tail).sub(new THREE.Vector3(...spec.head)).length();
  const offset = y.clone().multiplyScalar(len * 0.52).addScaledVector(x, 0.068);
  const basis = new THREE.Matrix4().makeBasis(x, y, z);
  pod.root.position.copy(offset);
  pod.root.quaternion.setFromRotationMatrix(basis);
  pod.root.visible = false;
  bone.add(pod.root);
}

/**
 * Generate a gunmetal / brushed-silver War Machine albedo CanvasTexture from
 * the Mark III's red/gold texture so every panel line and bevel survives intact.
 */
const recolorCache = new WeakMap<THREE.Texture, THREE.Texture>();

function warMachineTexture(src: THREE.Texture): THREE.Texture {
  const cached = recolorCache.get(src);
  if (cached) return cached;
  if (typeof document === 'undefined' || !src.image) return src;

  const img = src.image as { width?: number; height?: number };
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (w < 2 || h < 2) return src;

  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return src;
    ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;

    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 1e-4 ? (max - min) / max : 0;

      // Classify gold vs crimson plates on the Mk III atlas:
      //  - Gold has high G relative to R -> brushed titanium silver
      //  - Red has high R, low G -> tactical matte gunmetal charcoal
      const isGold = sat > 0.22 && r > 0.25 && g > r * 0.52 && b < g * 0.85;
      const isRed = sat > 0.25 && r > g * 1.45 && r > b * 1.45;

      let outR: number;
      let outG: number;
      let outB: number;
      if (isGold) {
        // Brushed titanium silver (Mk II silver trim)
        const v = Math.min(1, 0.22 + lum * 0.92);
        outR = v * 0.95;
        outG = v * 0.99;
        outB = v * 1.05;
      } else if (isRed) {
        // Dark tactical gunmetal charcoal
        const v = Math.min(1, 0.08 + lum * 0.56);
        outR = v * 0.92;
        outG = v * 0.98;
        outB = v * 1.08;
      } else {
        // Neutral dark steel/carbon
        const v = Math.min(1, lum * 0.88);
        outR = v * 0.94;
        outG = v * 0.98;
        outB = v * 1.05;
      }

      px[i] = Math.min(255, Math.round(outR * 255));
      px[i + 1] = Math.min(255, Math.round(outG * 255));
      px[i + 2] = Math.min(255, Math.round(outB * 255));
    }

    ctx.putImageData(data, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = src.colorSpace;
    tex.flipY = src.flipY;
    tex.wrapS = src.wrapS;
    tex.wrapT = src.wrapT;
    tex.needsUpdate = true;
    recolorCache.set(src, tex);
    return tex;
  } catch {
    return src;
  }
}

interface SavedSuitMaterial {
  map: THREE.Texture | null;
  color: THREE.Color;
  emissive: THREE.Color;
  metalness: number;
  roughness: number;
}

interface LocalVariantState {
  variant: SuitVariant;
  pack: WarMachinePack;
  saved: Map<THREE.MeshStandardMaterial, SavedSuitMaterial>;
}

const suitStates = new WeakMap<Suit, LocalVariantState>();

/**
 * Switch the local player's rigged `Suit` between Iron Man Mk III and
 * War Machine Mk II at runtime (idempotent & non-destructive).
 */
export function applyLocalSuitVariant(
  suit: Suit,
  variant: SuitVariant,
  hazeUniforms?: Record<string, THREE.IUniform>,
): WarMachinePack {
  let state = suitStates.get(suit);
  if (!state) {
    const saved = new Map<THREE.MeshStandardMaterial, SavedSuitMaterial>();
    suit.forEachMesh((m) => {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std || !std.isMeshStandardMaterial || saved.has(std)) continue;
        // Skip interior dark cavity / unmapped auxiliary meshes without albedo map
        if (!std.map && !std.emissiveMap) continue;
        saved.set(std, {
          map: std.map,
          color: std.color.clone(),
          emissive: std.emissive.clone(),
          metalness: std.metalness,
          roughness: std.roughness,
        });
      }
    });

    const pack = buildWarMachinePack(hazeUniforms);
    // Attach dorsal pack to the chest bone so it follows every bank, lean & crouch
    const ch = boneSpec('chest').head;
    pack.root.position.set(0 - ch[0], 1.38 - ch[1], 0 - ch[2]);
    pack.root.visible = false;
    suit.rig.bones.chest.add(pack.root);

    // Attach twin armored forearm pods to forearm.L / forearm.R
    attachWristPodToBone(suit, pack.wristL);
    attachWristPodToBone(suit, pack.wristR);

    state = { variant: 'ironman', pack, saved };
    suitStates.set(suit, state);
  }

  if (state.variant === variant) return state.pack;
  state.variant = variant;

  const isWM = variant === 'warmachine';
  state.pack.root.visible = isWM;
  state.pack.wristL.root.visible = isWM;
  state.pack.wristR.root.visible = isWM;

  for (const [mat, orig] of state.saved) {
    if (isWM) {
      if (orig.map) mat.map = warMachineTexture(orig.map);
      mat.color.setHex(0xffffff);
      mat.metalness = Math.min(1, Math.max(orig.metalness, 0.78));
      mat.roughness = Math.min(1, orig.roughness * 1.08);
      // Shift Mk III cyan/warm-eye glow -> War Machine tactical crimson-amber glow
      if (mat.emissiveMap) {
        mat.emissive.setRGB(1.85, 0.45, 0.32);
      }
    } else {
      mat.map = orig.map;
      mat.color.copy(orig.color);
      mat.emissive.copy(orig.emissive);
      mat.metalness = orig.metalness;
      mat.roughness = orig.roughness;
    }
    mat.needsUpdate = true;
  }

  return state.pack;
}
