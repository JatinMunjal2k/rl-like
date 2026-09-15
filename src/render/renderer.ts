import * as THREE from 'three';
import { ARENA, BALL, BOOST_PADS, CAR, OCTANE, UU, curve } from '../sim/rl';
import { HITBOX_HALF, HITBOX_OFFSET } from '../sim/car';
import type { ArenaGeometry } from '../sim/arena';
import type { BodyState, BoostPad } from '../sim/game';
import type { Team } from '../sim/car';
import type { CarRenderState } from '../net/session';
import { BlobShadow, Explosion, Ribbon, glowTexture } from './effects';

const pA = new THREE.Vector3();
const pB = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();

const TEAM_PAINT: Record<Team, number> = { blue: 0x1f63d8, orange: 0xf07f1a };

/** One car's meshes: body group, steerable wheels, boost flame, optional nameplate. */
interface CarVisual {
  group: THREE.Group;
  team: Team;
  wheels: { pivot: THREE.Group; mesh: THREE.Mesh; radius: number; front: boolean }[];
  flame: THREE.Mesh;
  flameMaterial: THREE.MeshBasicMaterial;
  nameplate: THREE.Sprite | null;
  name: string;
  trail: Ribbon;
  shadow: BlobShadow;
}

/** Per-pad bookkeeping for the instanced orbs and rings; big pads also get a glow sprite. */
interface PadVisual {
  x: number;
  z: number;
  big: boolean;
  /** Instance index within the big or small instanced meshes. */
  index: number;
  halo: THREE.Sprite | null;
  phase: number;
}

/**
 * Deliberately cheap: no shadows, no post-processing, no antialiasing, device pixel ratio 1,
 * flat-shaded Lambert materials, static textures and two lights.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  readonly ballMesh: THREE.Mesh;
  private readonly cars = new Map<number, CarVisual>();
  private pads: PadVisual[] = [];
  private bigOrbs!: THREE.InstancedMesh;
  private smallOrbs!: THREE.InstancedMesh;
  private bigRings!: THREE.InstancedMesh;
  private smallRings!: THREE.InstancedMesh;
  private readonly padMatrix = new THREE.Matrix4();
  private readonly padColorOn = new THREE.Color(0xffc46b);
  private readonly padColorOff = new THREE.Color(0x2f3d33);
  private readonly ballTrail = new Ribbon(16, 0.42, 0xdfe8ff, 0.28, 0.7);
  private readonly ballGlow: THREE.Sprite;
  private readonly ballShadow = new BlobShadow(1.1, 9);
  private readonly explosions: Explosion[] = [];
  private readonly lastBallPos = new THREE.Vector3();
  private readonly prevBallPos = new THREE.Vector3();
  private padTime = 0;
  private readonly tmpV = new THREE.Vector3();

  constructor(container: HTMLElement, arena: ArenaGeometry, pads: BoostPad[]) {
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
    this.gl.setPixelRatio(1);
    this.gl.setSize(container.clientWidth, container.clientHeight);
    this.gl.shadowMap.enabled = false;
    container.appendChild(this.gl.domElement);

    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 300);
    this.scene.background = new THREE.Color(0x05080f);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(30, 70, 25);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.4);
    fill.position.set(-40, 30, -50);
    this.scene.add(fill);

    this.buildSky();
    this.buildArena(arena);
    this.buildPads(pads);
    this.ballMesh = this.buildBall();
    this.ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x9fb8ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ballGlow.scale.setScalar(3.2);
    this.scene.add(this.ballGlow);
    this.scene.add(this.ballTrail.mesh);
    this.scene.add(this.ballShadow.mesh);

    window.addEventListener('resize', () => this.resize(container));
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.gl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** The Object3D the camera follows, once that car exists. */
  carObject(id: number): THREE.Object3D | null {
    return this.cars.get(id)?.group ?? null;
  }

  /** Create, update and remove car visuals to match `states`. Call once per frame. */
  syncCars(states: CarRenderState[], localId: number, dt: number): void {
    const seen = new Set<number>();
    for (const s of states) {
      seen.add(s.id);
      let v = this.cars.get(s.id);
      if (v && v.team !== s.team) {
        this.removeCar(s.id);
        v = undefined;
      }
      if (!v) {
        v = this.buildCar(s.team);
        this.cars.set(s.id, v);
      }
      const showName = s.id !== localId && s.name.length > 0;
      if (showName && v.name !== s.name) {
        if (v.nameplate) v.group.remove(v.nameplate);
        v.nameplate = makeNameplate(s.name, s.team);
        v.group.add(v.nameplate);
        v.name = s.name;
      } else if (!showName && v.nameplate) {
        v.group.remove(v.nameplate);
        v.nameplate = null;
        v.name = '';
      }
      applyInterpolated(v.group, s.prev, s.curr, s.alpha);
      if (s.offsetPos) v.group.position.add(s.offsetPos);
      if (s.offsetQuat) v.group.quaternion.premultiply(s.offsetQuat);
      for (const w of v.wheels) {
        w.mesh.rotation.x -= (s.forwardSpeed / w.radius) * dt;
        if (w.front) w.pivot.rotation.y = -s.steer * steerAngleFor(s.forwardSpeed);
      }
      v.flame.visible = s.boosting;
      v.flameMaterial.color.setHex(s.supersonic ? 0xfff3d6 : 0xffa62b);
      v.flame.scale.setScalar(s.supersonic ? 1.5 : 1);
      if (s.boosting) {
        v.flame.getWorldPosition(this.tmpV);
        v.trail.addPoint(this.tmpV);
      }
      v.trail.update(dt, this.camera.position);
      v.shadow.update(v.group.position, true);
    }
    for (const id of [...this.cars.keys()]) if (!seen.has(id)) this.removeCar(id);
  }

  removeCar(id: number): void {
    const v = this.cars.get(id);
    if (!v) return;
    this.scene.remove(v.group);
    this.scene.remove(v.trail.mesh);
    this.scene.remove(v.shadow.mesh);
    this.cars.delete(id);
  }

  syncBall(prev: BodyState, curr: BodyState, alpha: number, visible: boolean, offset: THREE.Vector3 | null, dt: number): void {
    applyInterpolated(this.ballMesh, prev, curr, alpha);
    if (offset) this.ballMesh.position.add(offset);
    this.ballMesh.visible = visible;
    this.ballGlow.visible = visible;
    this.ballGlow.position.copy(this.ballMesh.position);
    if (visible) {
      this.lastBallPos.copy(this.ballMesh.position);
      // Streak only when the ball is really moving (RL shows it past roughly half max speed).
      const speed = dt > 0 ? this.ballMesh.position.distanceTo(this.prevBallPos) / dt : 0;
      if (speed > 14 && speed < 200) this.ballTrail.addPoint(this.ballMesh.position);
      this.prevBallPos.copy(this.ballMesh.position);
    } else this.ballTrail.clear();
    this.ballTrail.update(dt, this.camera.position);
    this.ballShadow.update(this.ballMesh.position, visible);
  }

  syncPads(pads: BoostPad[], dt: number): void {
    this.padTime += dt;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      const v = this.pads[i];
      const active = p.cooldown === 0;
      const orbs = v.big ? this.bigOrbs : this.smallOrbs;
      const rings = v.big ? this.bigRings : this.smallRings;
      // Gentle bob so the orbs read as floating pickups; hidden by scaling to nothing.
      const bob = Math.sin(this.padTime * 2 + v.phase) * (v.big ? 0.12 : 0.05);
      const y = (v.big ? 1.15 : 0.32) + bob;
      const sc = active ? 1 : 0;
      this.padMatrix.makeRotationY(v.big ? this.padTime * 0.8 + v.phase : 0);
      this.padMatrix.scale(new THREE.Vector3(sc, sc, sc));
      this.padMatrix.setPosition(v.x, y, v.z);
      orbs.setMatrixAt(v.index, this.padMatrix);
      rings.setColorAt(v.index, active ? this.padColorOn : this.padColorOff);
      if (v.halo) {
        v.halo.visible = active;
        v.halo.position.y = y;
      }
    }
    this.bigOrbs.instanceMatrix.needsUpdate = true;
    this.smallOrbs.instanceMatrix.needsUpdate = true;
    if (this.bigRings.instanceColor) this.bigRings.instanceColor.needsUpdate = true;
    if (this.smallRings.instanceColor) this.smallRings.instanceColor.needsUpdate = true;
  }

  /** Goal scored: burst at the ball's last visible position in the team's colour. */
  goalExplosion(team: Team): void {
    const e = new Explosion(this.lastBallPos, TEAM_PAINT[team]);
    this.explosions.push(e);
    this.scene.add(e.group);
  }

  render(dt = 0): void {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.update(dt);
      if (e.done) {
        this.scene.remove(e.group);
        e.dispose();
        this.explosions.splice(i, 1);
      }
    }
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

  /**
   * RL-style pickups: big pads float a glowing orb about a metre up, small pads a bright dot,
   * each on a ring that goes dark while the pad recharges. Four instanced meshes plus six glow
   * sprites for the big pads: ten draw calls for all 34 pads.
   */
  private buildPads(pads: BoostPad[]): void {
    const bigs = pads.filter((p) => p.big).length;
    const smalls = pads.length - bigs;
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    this.bigOrbs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.42, 1), new THREE.MeshBasicMaterial({ color: 0xffc24a }), bigs);
    this.smallOrbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe08a }), smalls);
    this.bigRings = new THREE.InstancedMesh(new THREE.RingGeometry(1.35, 1.6, 32), ringMat, bigs);
    this.smallRings = new THREE.InstancedMesh(new THREE.RingGeometry(0.7, 0.85, 20), ringMat, smalls);
    for (const m of [this.bigOrbs, this.smallOrbs, this.bigRings, this.smallRings]) {
      m.frustumCulled = false;
      this.scene.add(m);
    }
    const haloTex = glowTexture();
    let bi = 0;
    let si = 0;
    const m = new THREE.Matrix4();
    this.pads = pads.map((p, i) => {
      const index = p.big ? bi++ : si++;
      const rings = p.big ? this.bigRings : this.smallRings;
      m.makeRotationX(-Math.PI / 2);
      m.setPosition(p.x, 0.015, p.z);
      rings.setMatrixAt(index, m);
      rings.setColorAt(index, this.padColorOn);
      let halo: THREE.Sprite | null = null;
      if (p.big) {
        halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: 0xffa030, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.scale.setScalar(2.6);
        halo.position.set(p.x, 1.15, p.z);
        this.scene.add(halo);
      }
      return { x: p.x, z: p.z, big: p.big, index, halo, phase: i * 0.7 };
    });
    this.bigRings.instanceMatrix.needsUpdate = true;
    this.smallRings.instanceMatrix.needsUpdate = true;
  }

  /** Night sky: a dithered gradient dome instead of a flat colour, one draw call. */
  private buildSky(): void {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 1024;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(cv.width, cv.height);
    // Horizon (bottom of the texture, v = 0) to zenith. Per-pixel noise breaks the 8-bit banding
    // that a smooth near-black gradient shows on a sphere as concentric rings.
    const stops: [number, [number, number, number]][] = [
      [0, [30, 42, 70]],
      [0.3, [16, 24, 44]],
      [1, [4, 6, 12]],
    ];
    for (let y = 0; y < cv.height; y++) {
      const v = 1 - y / (cv.height - 1);
      let i = 0;
      while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
      const [v0, c0] = stops[i];
      const [v1, c1] = stops[i + 1];
      const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
      for (let x = 0; x < cv.width; x++) {
        const n = (Math.random() - 0.5) * 3;
        const o = (y * cv.width + x) * 4;
        img.data[o] = c0[0] + (c1[0] - c0[0]) * t + n;
        img.data[o + 1] = c0[1] + (c1[1] - c0[1]) * t + n;
        img.data[o + 2] = c0[2] + (c1[2] - c0[2]) * t + n;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // A sprinkle of stars in the upper half.
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    for (let i = 0; i < 90; i++) ctx.fillRect(Math.random() * cv.width, Math.random() * 500, 1, 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(240, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false }));
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  // ---------------------------------------------------------------------------
  // Car: a Fennec-style body on the Octane hitbox, with wheels at RL's positions
  // ---------------------------------------------------------------------------

  private buildCar(team: Team): CarVisual {
    const group = new THREE.Group();
    const body = new THREE.Group();
    body.position.copy(HITBOX_OFFSET);
    group.add(body);

    const w = HITBOX_HALF.x * 2; // width 0.867
    const h = HITBOX_HALF.y * 2; // height 0.387
    const l = HITBOX_HALF.z * 2; // length 1.205

    const paint = new THREE.MeshLambertMaterial({ color: TEAM_PAINT[team] });
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
    const wheels: CarVisual['wheels'] = [];
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
      group.add(pivot);
      wheels.push({ pivot, mesh, radius: d.r, front: d.front });
    }

    const flameMaterial = new THREE.MeshBasicMaterial({ color: 0xffa62b });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.9, 8), flameMaterial);
    flame.rotation.x = Math.PI / 2; // tip points +Z (rear)
    flame.position.set(0, -h * 0.1, l / 2 + 0.45);
    flame.visible = false;
    body.add(flame);

    const trail = new Ribbon(10, 0.13, team === 'blue' ? 0x4f8cff : 0xff9030, 0.11, 0.55);
    const shadow = new BlobShadow(0.95, 6);
    this.scene.add(group, trail.mesh, shadow.mesh);
    return { group, team, wheels, flame, flameMaterial, nameplate: null, name: '', trail, shadow };
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

/** Front-wheel steer angle at full lock for a given forward speed (RL's steer curve). */
function steerAngleFor(forwardSpeed: number): number {
  return curve(CAR.steerAngleFromSpeedCurve, Math.abs(forwardSpeed) / UU);
}

/** Name floating above another player's car. Canvas text on a sprite, built once per name. */
function makeNameplate(name: string, team: Team): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.font = 'bold 34px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(name, 128, 32, 240);
  ctx.fillStyle = team === 'blue' ? '#8fc1ff' : '#ffc08a';
  ctx.fillText(name, 128, 32, 240);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.set(0, 1.1, 0);
  return sprite;
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

/**
 * Static wall texture: glass with a hexagon mesh (RL's arena glass) over a baked stadium behind it:
 * dark field-level band, three tiers of seating rendered as coloured speckle, roof structure at the
 * top, a light rail at goal height. Tiles along u.
 */
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
  grad.addColorStop(0, '#1b2538');
  grad.addColorStop(0.2, '#141c2c');
  grad.addColorStop(0.75, '#101625');
  grad.addColorStop(1, '#070a12');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Seating tiers behind the glass: speckled crowd in muted colours, separated by walkways.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const tiers: [number, number][] = [
    [0.22, 0.36],
    [0.42, 0.56],
    [0.62, 0.74],
  ];
  // Soft, low-contrast speckle: it should read as a distant crowd, not as noise up close.
  const palette = ['rgba(120,132,160,0.35)', 'rgba(100,110,140,0.3)', 'rgba(150,160,185,0.3)', 'rgba(160,130,110,0.28)', 'rgba(90,100,125,0.3)'];
  for (const [lo, hi] of tiers) {
    ctx.fillStyle = '#121a2a';
    ctx.fillRect(0, yPx(hi), W, (hi - lo) * H);
    for (let y = yPx(hi) + 6; y < yPx(lo) - 6; y += 10) {
      for (let x = 0; x < W; x += 9) {
        if (rnd() < 0.7) {
          ctx.fillStyle = palette[Math.floor(rnd() * palette.length)];
          ctx.fillRect(x + rnd() * 3, y + rnd() * 3, 5, 5);
        }
      }
    }
    // Walkway rail above each tier.
    ctx.fillStyle = 'rgba(180,200,235,0.18)';
    ctx.fillRect(0, yPx(hi) - 3, W, 3);
  }
  // Roof structure near the top.
  ctx.strokeStyle = 'rgba(120,140,180,0.25)';
  ctx.lineWidth = 6;
  for (let x = 0; x <= W; x += W / 4) {
    ctx.beginPath();
    ctx.moveTo(x, yPx(0.78));
    ctx.lineTo(x + W / 8, yPx(1));
    ctx.moveTo(x, yPx(0.78));
    ctx.lineTo(x - W / 8, yPx(1));
    ctx.stroke();
  }

  // Glass: hexagon mesh over everything, slightly brighter near the floor where the glass is lit.
  const r = 30;
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  ctx.lineWidth = 2;
  let row = 0;
  for (let y = H + r; y > -r; y -= dy, row++) {
    for (let x = row % 2 ? dx / 2 : 0; x < W + dx; x += dx) {
      const frac = 1 - y / H;
      ctx.strokeStyle = `rgba(160,190,240,${(0.16 - frac * 0.1).toFixed(3)})`;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  // Glass tint reflections: faint diagonal sheen.
  const sheen = ctx.createLinearGradient(0, H, W, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.045)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);
  // Rail at goal height and the glow strip near the ceiling curve.
  const goalFrac = ARENA.goalHeight / ARENA.height;
  ctx.fillStyle = 'rgba(143,184,255,0.45)';
  ctx.fillRect(0, yPx(goalFrac) - 4, W, 8);
  ctx.fillStyle = 'rgba(255,179,71,0.22)';
  ctx.fillRect(0, yPx(0.78) - 5, W, 10);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** RL-like ball: light grey with darker hexagon panel seams and a few darker panels. */
function makeBallTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#cfd6de';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const r = 22;
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  let row = 0;
  for (let y = -r; y < cv.height + r; y += dy, row++) {
    for (let x = row % 2 ? dx / 2 : 0; x < cv.width + dx; x += dx) {
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      // Every few panels darker, like the ball's pattern.
      const h = (Math.round(x / dx) * 7 + row * 3) % 11;
      ctx.fillStyle = h < 2 ? '#6b7683' : h < 4 ? '#aeb8c4' : '#d6dce3';
      ctx.fill();
      ctx.strokeStyle = '#3d4753';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
