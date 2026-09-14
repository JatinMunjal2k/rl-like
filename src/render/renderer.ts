import * as THREE from 'three';
import { ARENA, BALL } from '../sim/rl';
import { HITBOX_HALF, HITBOX_OFFSET } from '../sim/car';
import type { ArenaGeometry } from '../sim/arena';
import type { BodyState } from '../sim/game';

const pA = new THREE.Vector3();
const pB = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();

/**
 * Deliberately cheap: no shadows, no post-processing, no antialiasing, device pixel ratio 1,
 * flat-shaded Lambert materials and two lights. Everything visual that does not affect play
 * has been stripped so the GPU stays cool.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  readonly carGroup = new THREE.Group();
  readonly ballMesh: THREE.Mesh;
  private readonly boostFlame: THREE.Mesh;

  constructor(container: HTMLElement, arena: ArenaGeometry) {
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
    this.gl.setPixelRatio(1);
    this.gl.setSize(container.clientWidth, container.clientHeight);
    this.gl.shadowMap.enabled = false;
    container.appendChild(this.gl.domElement);

    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 300);
    this.scene.background = new THREE.Color(0x0f1a2b);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(30, 70, 25);
    this.scene.add(sun);

    this.buildArena(arena);
    this.boostFlame = this.buildCar();
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

  sync(prevCar: BodyState, currCar: BodyState, prevBall: BodyState, currBall: BodyState, alpha: number, boosting: boolean): void {
    applyInterpolated(this.carGroup, prevCar, currCar, alpha);
    applyInterpolated(this.ballMesh, prevBall, currBall, alpha);
    this.boostFlame.visible = boosting;
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
  }

  private buildArena(arena: ArenaGeometry): void {
    // Floor: one textured plane covering the field and both goals.
    const floorGeo = new THREE.PlaneGeometry(arena.floorBox.hx * 2, arena.floorBox.hz * 2);
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshLambertMaterial({ map: makeFieldTexture() }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Wall shell straight from the physics trimesh, so what you see is what you hit.
    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.BufferAttribute(arena.vertices, 3));
    shell.setIndex(new THREE.BufferAttribute(arena.indices, 1));
    shell.computeVertexNormals();
    this.scene.add(
      new THREE.Mesh(
        shell,
        new THREE.MeshLambertMaterial({ color: 0x8fb8ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
      ),
    );
    this.scene.add(
      new THREE.LineSegments(new THREE.EdgesGeometry(shell, 25), new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.5 })),
    );

    // Goal boxes, tinted for the team defending them (orange defends +Z). Skip floor/ceiling boxes.
    for (const b of arena.goalBoxes) {
      const color = b.z > 0 ? 0xff9a3c : 0x4aa3ff;
      const geo = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.15, depthWrite: false }),
      );
      mesh.position.set(b.x, b.y, b.z);
      this.scene.add(mesh);
    }
    // Goal mouth outlines.
    for (const s of [-1, 1]) {
      const color = s > 0 ? 0xff9a3c : 0x4aa3ff;
      const mouth = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.goalHalfWidth * 2, ARENA.goalHeight)),
        new THREE.LineBasicMaterial({ color }),
      );
      mouth.position.set(0, ARENA.goalHeight / 2, s * ARENA.extentY);
      this.scene.add(mouth);
    }
  }

  /** The car is exactly its hitbox: one box, a bright nose stripe, and a boost flame, offset from the body origin like RL. */
  private buildCar(): THREE.Mesh {
    const g = new THREE.Group();
    g.position.copy(HITBOX_OFFSET);
    this.carGroup.add(g);
    const w = HITBOX_HALF.x * 2;
    const h = HITBOX_HALF.y * 2;
    const l = HITBOX_HALF.z * 2;

    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), new THREE.MeshLambertMaterial({ color: 0x2c7be5 }));
    g.add(body);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, 0.02, l * 0.4), new THREE.MeshLambertMaterial({ color: 0x14203a }));
    roof.position.set(0, h / 2 + 0.01, l * 0.05);
    g.add(roof);

    // Forward is -Z.
    const nose = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, h * 0.4, 0.04), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    nose.position.set(0, 0, -l / 2 - 0.02);
    g.add(nose);

    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.9, 8), new THREE.MeshBasicMaterial({ color: 0xffa62b }));
    flame.rotation.x = Math.PI / 2; // tip points +Z (rear)
    flame.position.set(0, 0, l / 2 + 0.45);
    flame.visible = false;
    g.add(flame);

    this.scene.add(this.carGroup);
    return flame;
  }

  private buildBall(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius, 24, 16),
      new THREE.MeshLambertMaterial({ map: makeBallTexture() }),
    );
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

function makeFieldTexture(): THREE.Texture {
  const W = 512;
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

  ctx.fillStyle = '#1d5a2c';
  ctx.fillRect(0, 0, W, Hpx);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  for (const z of [-ARENA.extentY, 0, ARENA.extentY]) {
    ctx.beginPath();
    ctx.moveTo(0, zToPx(z));
    ctx.lineTo(W, zToPx(z));
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(xToPx(0), zToPx(0), 9 * sx, 0, Math.PI * 2);
  ctx.stroke();
  for (const s of [-1, 1]) {
    const z0 = zToPx(s * ARENA.extentY);
    const z1 = zToPx(s * (ARENA.extentY - 12));
    const halfW = ARENA.goalHalfWidth + 6;
    ctx.strokeRect(xToPx(-halfW), Math.min(z0, z1), halfW * 2 * sx, Math.abs(z1 - z0));
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
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
