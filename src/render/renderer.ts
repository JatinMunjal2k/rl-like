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
    // Floor: one static textured plane covering the field and both goals. The texture is drawn in
    // the plane's own metres so markings land exactly on the physics positions.
    const floorW = arena.floorBox.hx * 2;
    const floorL = arena.floorBox.hz * 2;
    const floorGeo = new THREE.PlaneGeometry(floorW, floorL);
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshLambertMaterial({ map: makeFieldTexture(floorW, floorL) }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Wall shell straight from the physics trimesh, opaque and single-sided: the normals point
    // into the arena, so it is solid from inside and see-through when the camera is outside.
    // UVs: u runs along the wall (world x + z works for both wall directions), v is height.
    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.BufferAttribute(arena.vertices, 3));
    const uv = new Float32Array((arena.vertices.length / 3) * 2);
    for (let i = 0; i < arena.vertices.length / 3; i++) {
      const x = arena.vertices[i * 3];
      const y = arena.vertices[i * 3 + 1];
      const z = arena.vertices[i * 3 + 2];
      uv[i * 2] = (x + z) / 8; // one panel every 8 m along the wall
      uv[i * 2 + 1] = y / ARENA.height;
    }
    shell.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    shell.setIndex(new THREE.BufferAttribute(arena.indices, 1));
    shell.computeVertexNormals();
    this.scene.add(new THREE.Mesh(shell, new THREE.MeshLambertMaterial({ map: makeWallTexture(), side: THREE.FrontSide })));
    this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(shell, 20), new THREE.LineBasicMaterial({ color: 0x5f7fb5, transparent: true, opacity: 0.55 })));

    // A light band along the walls at goal height, like the arena's glass line.
    const band = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.extentX * 2, ARENA.extentY * 2)), new THREE.LineBasicMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0.35 }));
    band.rotation.x = -Math.PI / 2;
    band.position.y = ARENA.goalHeight;
    this.scene.add(band);

    // Goal chambers straight from the physics mesh: quarter-pipe back, sloped roof, netting.
    // Drawn as translucent tinted netting with edge lines so the curve reads from inside and out.
    const goalGeo = new THREE.BufferGeometry();
    goalGeo.setAttribute('position', new THREE.BufferAttribute(arena.goalVertices, 3));
    goalGeo.setIndex(new THREE.BufferAttribute(arena.goalIndices, 1));
    goalGeo.computeVertexNormals();
    // Split by sign of z for team tints.
    const tintByZ = (positive: boolean) => {
      const idx = arena.goalIndices;
      const kept: number[] = [];
      for (let i = 0; i < idx.length; i += 3) {
        const z = arena.goalVertices[idx[i] * 3 + 2];
        if (z > 0 === positive) kept.push(idx[i], idx[i + 1], idx[i + 2]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arena.goalVertices, 3));
      g.setIndex(kept);
      g.computeVertexNormals();
      return g;
    };
    for (const positive of [true, false]) {
      const color = positive ? 0xff9a3c : 0x4aa3ff;
      const g = tintByZ(positive);
      this.scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })));
      this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 12), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })));
      const mouth = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.goalHalfWidth * 2, ARENA.goalHeight)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
      );
      mouth.position.set(0, ARENA.goalHeight / 2, (positive ? 1 : -1) * ARENA.extentY);
      this.scene.add(mouth);
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

/** Static field texture: turf stripes, RL-style markings, boost pad rings. Drawn once, in the plane's metres. */
function makeFieldTexture(fieldW: number, fieldL: number): THREE.Texture {
  const W = 2048;
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

/** Static wall texture: dark panels with seams, a light rail at goal height, a glow strip near the top. Tiles along u. */
function makeWallTexture(): THREE.Texture {
  const W = 512;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  // v = 0 at the floor is the bottom of the canvas.
  const yPx = (frac: number) => H - frac * H;
  const grad = ctx.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#1e2a40');
  grad.addColorStop(0.35, '#273550');
  grad.addColorStop(1, '#1a2438');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Panel seams: two panels per tile horizontally, rows at fixed heights.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4;
  for (const u of [0, W / 2]) {
    ctx.beginPath();
    ctx.moveTo(u, 0);
    ctx.lineTo(u, H);
    ctx.stroke();
  }
  for (const frac of [0.15, 0.31, 0.5, 0.72]) {
    ctx.beginPath();
    ctx.moveTo(0, yPx(frac));
    ctx.lineTo(W, yPx(frac));
    ctx.stroke();
  }
  // Highlight edge on each seam.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 2;
  for (const frac of [0.15, 0.31, 0.5, 0.72]) {
    ctx.beginPath();
    ctx.moveTo(0, yPx(frac) - 3);
    ctx.lineTo(W, yPx(frac) - 3);
    ctx.stroke();
  }
  // Glass rail at goal height and a glow strip near the ceiling curve.
  const goalFrac = ARENA.goalHeight / ARENA.height;
  ctx.fillStyle = 'rgba(143,184,255,0.35)';
  ctx.fillRect(0, yPx(goalFrac) - 5, W, 10);
  ctx.fillStyle = 'rgba(255,179,71,0.25)';
  ctx.fillRect(0, yPx(0.68) - 6, W, 12);
  // Subtle vertical light streaks.
  for (let i = 0; i < 6; i++) {
    const x = ((i + 0.5) * W) / 6;
    const g = ctx.createLinearGradient(0, H, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.035)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 6, 0, 12, H);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
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
