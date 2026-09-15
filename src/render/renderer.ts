import * as THREE from 'three';
import { ARENA, BALL, BOOST_PADS, OCTANE, UU } from '../sim/rl';
import { HITBOX_HALF, HITBOX_OFFSET } from '../sim/car';
import type { ArenaGeometry } from '../sim/arena';
import type { BodyState, BoostPad } from '../sim/game';

const pA = new THREE.Vector3();
const pB = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();

export interface CarVisualState {
  /** Front wheel steer angle in radians, positive = right. */
  steerAngle: number;
  /** Forward speed in m/s, for wheel spin. */
  forwardSpeed: number;
  boosting: boolean;
  supersonic: boolean;
}

/**
 * Deliberately cheap: no shadows, no post-processing, no antialiasing, device pixel ratio 1,
 * flat-shaded Lambert materials, static textures and two lights.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  readonly carGroup = new THREE.Group();
  readonly ballMesh: THREE.Mesh;
  private readonly boostFlame: THREE.Mesh;
  private readonly flameMaterial: THREE.MeshBasicMaterial;
  private readonly wheels: { pivot: THREE.Group; mesh: THREE.Mesh; radius: number; front: boolean }[] = [];
  private padMeshes: THREE.Mesh[] = [];
  private readonly padActiveBig = new THREE.MeshBasicMaterial({ color: 0xffb347 });
  private readonly padActiveSmall = new THREE.MeshBasicMaterial({ color: 0xffd98a });
  private readonly padInactive = new THREE.MeshBasicMaterial({ color: 0x2a3a2a });

  constructor(container: HTMLElement, arena: ArenaGeometry, pads: BoostPad[]) {
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
    this.gl.setPixelRatio(1);
    this.gl.setSize(container.clientWidth, container.clientHeight);
    this.gl.shadowMap.enabled = false;
    container.appendChild(this.gl.domElement);

    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 300);
    this.scene.background = new THREE.Color(0x0b1220);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(30, 70, 25);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.4);
    fill.position.set(-40, 30, -50);
    this.scene.add(fill);

    this.buildArena(arena);
    this.buildPads(pads);
    this.boostFlame = this.buildCar();
    this.flameMaterial = this.boostFlame.material as THREE.MeshBasicMaterial;
    this.ballMesh = this.buildBall();

    window.addEventListener('resize', () => this.resize(container));
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.gl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  sync(prevCar: BodyState, currCar: BodyState, prevBall: BodyState, currBall: BodyState, alpha: number, ballVisible: boolean): void {
    applyInterpolated(this.carGroup, prevCar, currCar, alpha);
    applyInterpolated(this.ballMesh, prevBall, currBall, alpha);
    this.ballMesh.visible = ballVisible;
  }

  /** Wheel spin, steering, flame. Call once per frame after sync(). */
  syncCar(state: CarVisualState, dt: number): void {
    for (const w of this.wheels) {
      w.mesh.rotation.x -= (state.forwardSpeed / w.radius) * dt;
      if (w.front) w.pivot.rotation.y = -state.steerAngle;
    }
    this.boostFlame.visible = state.boosting;
    this.flameMaterial.color.setHex(state.supersonic ? 0xfff3d6 : 0xffa62b);
    this.boostFlame.scale.setScalar(state.supersonic ? 1.5 : 1);
  }

  syncPads(pads: BoostPad[]): void {
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      this.padMeshes[i].material = p.cooldown > 0 ? this.padInactive : p.big ? this.padActiveBig : this.padActiveSmall;
    }
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------------------
  // Arena
  // ---------------------------------------------------------------------------

  private buildArena(arena: ArenaGeometry): void {
    // Floor: one static textured plane covering the field and both goals.
    const floorGeo = new THREE.PlaneGeometry(arena.floorBox.hx * 2, arena.floorBox.hz * 2);
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshLambertMaterial({ map: makeFieldTexture() }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Wall shell straight from the physics trimesh, opaque and single-sided: the normals point
    // into the arena, so it is solid from inside and see-through when the camera is outside.
    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.BufferAttribute(arena.vertices, 3));
    shell.setIndex(new THREE.BufferAttribute(arena.indices, 1));
    shell.computeVertexNormals();
    this.scene.add(new THREE.Mesh(shell, new THREE.MeshLambertMaterial({ color: 0x27354f, side: THREE.FrontSide })));
    this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(shell, 20), new THREE.LineBasicMaterial({ color: 0x5f7fb5, transparent: true, opacity: 0.55 })));

    // A light band along the walls at goal height, like the arena's glass line.
    const band = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.extentX * 2, ARENA.extentY * 2)), new THREE.LineBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0.35 }));
    band.rotation.x = -Math.PI / 2;
    band.position.y = ARENA.goalHeight;
    this.scene.add(band);

    // Goal boxes, tinted for the team defending them (orange defends +Z). The netting is drawn
    // as translucent panels plus a grid of lines so the back of the goal reads as a net.
    for (const b of arena.goalBoxes) {
      const color = b.z > 0 ? 0xff9a3c : 0x4aa3ff;
      const geo = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false }));
      mesh.position.set(b.x, b.y, b.z);
      this.scene.add(mesh);
    }
    for (const s of [-1, 1]) {
      const color = s > 0 ? 0xff9a3c : 0x4aa3ff;
      const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
      const mouth = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.goalHalfWidth * 2, ARENA.goalHeight)), lineMat);
      mouth.position.set(0, ARENA.goalHeight / 2, s * ARENA.extentY);
      this.scene.add(mouth);
      // Net grid on the back panel.
      const pts: number[] = [];
      const zBack = s * (ARENA.extentY + ARENA.goalDepth - 0.05);
      for (let x = -ARENA.goalHalfWidth; x <= ARENA.goalHalfWidth + 1e-6; x += ARENA.goalHalfWidth / 4) pts.push(x, 0, zBack, x, ARENA.goalHeight, zBack);
      for (let y = 0; y <= ARENA.goalHeight + 1e-6; y += ARENA.goalHeight / 4) pts.push(-ARENA.goalHalfWidth, y, zBack, ARENA.goalHalfWidth, y, zBack);
      const net = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
      this.scene.add(net);
    }

    // Ceiling outline only, so the camera never gets blocked.
    const ceil = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.extentX * 2, ARENA.extentY * 2)), new THREE.LineBasicMaterial({ color: 0x5f7fb5, transparent: true, opacity: 0.35 }));
    ceil.rotation.x = -Math.PI / 2;
    ceil.position.y = ARENA.height;
    this.scene.add(ceil);
  }

  /** Flat discs on the floor: lit when available, dark while cooling down. */
  private buildPads(pads: BoostPad[]): void {
    const bigGeo = new THREE.CircleGeometry(1.6, 24);
    const smallGeo = new THREE.CircleGeometry(0.9, 16);
    this.padMeshes = pads.map((p) => {
      const mesh = new THREE.Mesh(p.big ? bigGeo : smallGeo, p.big ? this.padActiveBig : this.padActiveSmall);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(p.x, 0.02, p.z);
      this.scene.add(mesh);
      return mesh;
    });
  }

  // ---------------------------------------------------------------------------
  // Car: a Fennec-style body on the Octane hitbox, with wheels at RL's positions
  // ---------------------------------------------------------------------------

  private buildCar(): THREE.Mesh {
    const body = new THREE.Group();
    body.position.copy(HITBOX_OFFSET);
    this.carGroup.add(body);

    const w = HITBOX_HALF.x * 2; // width 0.867
    const h = HITBOX_HALF.y * 2; // height 0.387
    const l = HITBOX_HALF.z * 2; // length 1.205

    const paint = new THREE.MeshLambertMaterial({ color: 0x1f63d8 });
    const trim = new THREE.MeshLambertMaterial({ color: 0x151a22 });
    const glass = new THREE.MeshLambertMaterial({ color: 0x0c1526 });
    const light = new THREE.MeshBasicMaterial({ color: 0xfff1b8 });
    const tail = new THREE.MeshBasicMaterial({ color: 0xff3b3b });

    const box = (mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      m.position.set(x, y, z);
      body.add(m);
      return m;
    };

    // Fennec: boxy, flat sides, tall square cabin set slightly back, short flat hood.
    box(paint, w * 0.96, h * 0.5, l * 0.98, 0, -h * 0.22, 0); // lower body
    box(trim, w * 0.98, h * 0.16, l * 1.0, 0, -h * 0.42, 0); // rocker / bumper line
    box(paint, w * 0.86, h * 0.42, l * 0.52, 0, h * 0.2, l * 0.03); // cabin
    box(glass, w * 0.87, h * 0.2, l * 0.5, 0, h * 0.22, l * 0.03); // window band
    box(paint, w * 0.8, h * 0.06, l * 0.5, 0, h * 0.44, l * 0.03); // roof
    box(paint, w * 0.92, h * 0.14, l * 0.24, 0, h * 0.02, -l * 0.35); // hood
    box(paint, w * 0.92, h * 0.2, l * 0.2, 0, h * 0.0, l * 0.39); // trunk
    box(trim, w * 0.9, h * 0.1, 0.03, 0, -h * 0.05, -l / 2 + 0.01); // front grille
    box(light, w * 0.22, h * 0.1, 0.03, w * 0.32, h * 0.05, -l / 2 + 0.005); // headlights
    box(light, w * 0.22, h * 0.1, 0.03, -w * 0.32, h * 0.05, -l / 2 + 0.005);
    box(tail, w * 0.9, h * 0.08, 0.03, 0, h * 0.06, l / 2 - 0.005); // taillight bar

    // Wheels at RL's hardpoints, relative to the body origin (not the hitbox).
    const tire = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const rim = new THREE.MeshLambertMaterial({ color: 0x8a94a6 });
    const wheelDefs = [
      { x: OCTANE.frontWheelOffset.y, z: -OCTANE.frontWheelOffset.x, r: OCTANE.frontWheelRadius, front: true },
      { x: -OCTANE.frontWheelOffset.y, z: -OCTANE.frontWheelOffset.x, r: OCTANE.frontWheelRadius, front: true },
      { x: OCTANE.rearWheelOffset.y, z: -OCTANE.rearWheelOffset.x, r: OCTANE.rearWheelRadius, front: false },
      { x: -OCTANE.rearWheelOffset.y, z: -OCTANE.rearWheelOffset.x, r: OCTANE.rearWheelRadius, front: false },
    ];
    const width = 0.19;
    for (const d of wheelDefs) {
      const pivot = new THREE.Group();
      pivot.position.set(d.x + Math.sign(d.x) * 0.04, d.r - OCTANE.restZ, d.z);
      const tireGeo = new THREE.CylinderGeometry(d.r, d.r, width, 18);
      tireGeo.rotateZ(Math.PI / 2);
      const mesh = new THREE.Mesh(tireGeo, tire);
      const rimGeo = new THREE.CylinderGeometry(d.r * 0.6, d.r * 0.6, width + 0.01, 12);
      rimGeo.rotateZ(Math.PI / 2);
      mesh.add(new THREE.Mesh(rimGeo, rim));
      pivot.add(mesh);
      this.carGroup.add(pivot);
      this.wheels.push({ pivot, mesh, radius: d.r, front: d.front });
    }

    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.9, 8), new THREE.MeshBasicMaterial({ color: 0xffa62b }));
    flame.rotation.x = Math.PI / 2; // tip points +Z (rear)
    flame.position.set(0, -h * 0.1, l / 2 + 0.45);
    flame.visible = false;
    body.add(flame);

    this.scene.add(this.carGroup);
    return flame;
  }

  private buildBall(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL.radius, 24, 16), new THREE.MeshLambertMaterial({ map: makeBallTexture() }));
    this.scene.add(mesh);
    return mesh;
  }
}

function applyInterpolated(obj: THREE.Object3D, a: BodyState, b: BodyState, alpha: number): void {
  pA.set(a.px, a.py, a.pz);
  pB.set(b.px, b.py, b.pz);
  obj.position.copy(pA).lerp(pB, alpha);
  qA.set(a.qx, a.qy, a.qz, a.qw);
  qB.set(b.qx, b.qy, b.qz, b.qw);
  obj.quaternion.copy(qA).slerp(qB, alpha);
}

/** Static field texture: turf stripes, RL-style markings, boost pad rings. Drawn once. */
function makeFieldTexture(): THREE.Texture {
  const W = 2048;
  const fieldW = ARENA.extentX * 2;
  const fieldL = (ARENA.extentY + ARENA.goalDepth) * 2;
  const Hpx = Math.round((W * fieldL) / fieldW);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = Hpx;
  const ctx = cv.getContext('2d')!;
  const sx = W / fieldW;
  const sz = Hpx / fieldL;
  const xToPx = (x: number) => W / 2 + x * sx;
  const zToPx = (z: number) => Hpx / 2 - z * sz;

  // Turf with mowing stripes.
  ctx.fillStyle = '#1c5a2d';
  ctx.fillRect(0, 0, W, Hpx);
  const stripeM = 6.4;
  for (let z = -ARENA.extentY; z < ARENA.extentY; z += stripeM * 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, zToPx(z + stripeM), W, stripeM * sz);
  }
  // Goal areas darker.
  ctx.fillStyle = '#17332a';
  ctx.fillRect(xToPx(-ARENA.goalHalfWidth), zToPx(ARENA.extentY + ARENA.goalDepth), ARENA.goalHalfWidth * 2 * sx, ARENA.goalDepth * sz);
  ctx.fillRect(xToPx(-ARENA.goalHalfWidth), zToPx(-ARENA.extentY), ARENA.goalHalfWidth * 2 * sx, ARENA.goalDepth * sz);

  const line = (color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
  };
  const white = 'rgba(255,255,255,0.9)';

  // Field boundary (where the floor ramp starts) and corner cuts.
  line('rgba(255,255,255,0.55)', 4);
  const c = ARENA.cornerCut;
  const inset = 2.56;
  const bx = ARENA.extentX - inset;
  const bz = ARENA.extentY - inset;
  ctx.beginPath();
  ctx.moveTo(xToPx(bx - c), zToPx(-bz));
  ctx.lineTo(xToPx(bx), zToPx(-bz + c));
  ctx.lineTo(xToPx(bx), zToPx(bz - c));
  ctx.lineTo(xToPx(bx - c), zToPx(bz));
  ctx.lineTo(xToPx(-(bx - c)), zToPx(bz));
  ctx.lineTo(xToPx(-bx), zToPx(bz - c));
  ctx.lineTo(xToPx(-bx), zToPx(-bz + c));
  ctx.lineTo(xToPx(-(bx - c)), zToPx(-bz));
  ctx.closePath();
  ctx.stroke();

  // Goal lines, half line.
  line(white, 7);
  for (const z of [-ARENA.extentY, ARENA.extentY]) {
    ctx.beginPath();
    ctx.moveTo(xToPx(-bx), zToPx(z));
    ctx.lineTo(xToPx(bx), zToPx(z));
    ctx.stroke();
  }
  line(white, 6);
  ctx.beginPath();
  ctx.moveTo(xToPx(-bx), zToPx(0));
  ctx.lineTo(xToPx(bx), zToPx(0));
  ctx.stroke();

  // Centre circle and spot.
  ctx.beginPath();
  ctx.arc(xToPx(0), zToPx(0), 9.6 * sx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(xToPx(0), zToPx(0), 0.7 * sx, 0, Math.PI * 2);
  ctx.fillStyle = white;
  ctx.fill();

  // Goal boxes and penalty arcs.
  for (const s of [-1, 1]) {
    const depth = 14;
    const halfW = ARENA.goalHalfWidth + 9;
    const z0 = zToPx(s * ARENA.extentY);
    const z1 = zToPx(s * (ARENA.extentY - depth));
    ctx.strokeRect(xToPx(-halfW), Math.min(z0, z1), halfW * 2 * sx, Math.abs(z1 - z0));
    const smallHalf = ARENA.goalHalfWidth + 3;
    const zs1 = zToPx(s * (ARENA.extentY - 5.5));
    ctx.strokeRect(xToPx(-smallHalf), Math.min(z0, zs1), smallHalf * 2 * sx, Math.abs(zs1 - z0));
    ctx.beginPath();
    const arcCenterZ = s * (ARENA.extentY - 9);
    ctx.arc(xToPx(0), zToPx(arcCenterZ), 9 * sx, s > 0 ? Math.PI * 0.2 : Math.PI * 1.2, s > 0 ? Math.PI * 0.8 : Math.PI * 1.8);
    ctx.stroke();
  }

  // Boost pad markers.
  line('rgba(255,200,120,0.45)', 3);
  for (const [x, y] of BOOST_PADS.bigLocations) {
    ctx.beginPath();
    ctx.arc(xToPx(x * UU), zToPx(y * UU), 2.2 * sx, 0, Math.PI * 2);
    ctx.stroke();
  }
  line('rgba(255,200,120,0.3)', 2);
  for (const [x, y] of BOOST_PADS.smallLocations) {
    ctx.beginPath();
    ctx.arc(xToPx(x * UU), zToPx(y * UU), 1.3 * sx, 0, Math.PI * 2);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeBallTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const ctx = cv.getContext('2d')!;
  const cols = 12;
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#e9eef3' : '#3a4a5c';
      ctx.fillRect((c * cv.width) / cols, (r * cv.height) / rows, cv.width / cols, cv.height / rows);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
