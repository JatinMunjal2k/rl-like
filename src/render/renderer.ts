import * as THREE from 'three';
import { ARENA, BALL, CAR } from '../sim/constants';
import type { BodyState } from '../sim/game';

const pA = new THREE.Vector3();
const pB = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();

/** three.js scene: arena, car, ball. Knows nothing about physics; it just gets transforms. */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  readonly carGroup = new THREE.Group();
  readonly ballMesh: THREE.Mesh;
  private readonly boostFlame: THREE.Mesh;

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.setSize(container.clientWidth, container.clientHeight);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.gl.domElement);

    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 400);
    this.scene.background = new THREE.Color(0x0f1a2b);
    this.scene.fog = new THREE.Fog(0x0f1a2b, 120, 260);

    this.buildLights();
    this.buildArena();
    this.buildCar();
    this.boostFlame = this.carGroup.getObjectByName('flame') as THREE.Mesh;
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

  /** Apply interpolated transforms for the current frame. */
  sync(prevCar: BodyState, currCar: BodyState, prevBall: BodyState, currBall: BodyState, alpha: number, boosting: boolean): void {
    applyInterpolated(this.carGroup, prevCar, currCar, alpha);
    applyInterpolated(this.ballMesh, prevBall, currBall, alpha);
    this.boostFlame.visible = boosting;
    if (boosting) {
      const s = 0.8 + Math.random() * 0.4;
      this.boostFlame.scale.set(s, 1 + Math.random() * 0.5, s);
    }
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x9cc4ff, 0x1c2a1a, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(30, 70, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -70;
    cam.right = 70;
    cam.top = 70;
    cam.bottom = -70;
    cam.near = 10;
    cam.far = 200;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  private buildArena(): void {
    const A = ARENA;
    const W = A.width;
    const L = A.length;
    const H = A.height;

    // Floor with painted lines.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, L + 2 * A.goalDepth),
      new THREE.MeshStandardMaterial({ map: makeFieldTexture(), roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x8fb8ff,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.6 });

    const panel = (w: number, h: number, x: number, y: number, z: number, yaw: number, mat = wallMat, edges = edgeMat) => {
      const geo = new THREE.PlaneGeometry(w, h);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = yaw;
      this.scene.add(m);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edges);
      e.position.copy(m.position);
      e.rotation.copy(m.rotation);
      this.scene.add(e);
    };

    const c = A.cornerCut;
    // Side walls (shortened by the corner cuts).
    panel(L - 2 * c, H, -W / 2, H / 2, 0, Math.PI / 2);
    panel(L - 2 * c, H, W / 2, H / 2, 0, -Math.PI / 2);

    for (const s of [-1, 1]) {
      const yaw = s > 0 ? Math.PI : 0;
      const z = s * (L / 2);
      const sideW = W / 2 - c - A.goalWidth / 2;
      const sideX = A.goalWidth / 2 + sideW / 2;
      panel(sideW, H, -sideX, H / 2, z, yaw);
      panel(sideW, H, sideX, H / 2, z, yaw);
      panel(A.goalWidth, H - A.goalHeight, 0, A.goalHeight + (H - A.goalHeight) / 2, z, yaw);

      // Goal: tinted panels for the team defending it (orange defends +Z).
      const color = s > 0 ? 0xff9a3c : 0x4aa3ff;
      const goalMat = new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
        emissive: color,
        emissiveIntensity: 0.4,
      });
      const goalEdge = new THREE.LineBasicMaterial({ color });
      const zBack = s * (L / 2 + A.goalDepth);
      const zMid = s * (L / 2 + A.goalDepth / 2);
      panel(A.goalWidth, A.goalHeight, 0, A.goalHeight / 2, zBack, yaw, goalMat, goalEdge);
      panel(A.goalDepth, A.goalHeight, -A.goalWidth / 2, A.goalHeight / 2, zMid, Math.PI / 2, goalMat, goalEdge);
      panel(A.goalDepth, A.goalHeight, A.goalWidth / 2, A.goalHeight / 2, zMid, -Math.PI / 2, goalMat, goalEdge);
      const roof = new THREE.Mesh(new THREE.PlaneGeometry(A.goalWidth, A.goalDepth), goalMat);
      roof.rotation.x = -Math.PI / 2;
      roof.position.set(0, A.goalHeight, zMid);
      this.scene.add(roof);
      // Goal mouth outline.
      const mouth = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(A.goalWidth, A.goalHeight)), goalEdge);
      mouth.position.set(0, A.goalHeight / 2, z);
      this.scene.add(mouth);
    }

    // 45° corners.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        panel(c * Math.SQRT2, H, sx * (W / 2 - c / 2), H / 2, sz * (L / 2 - c / 2), Math.atan2(sx, sz) + Math.PI);
      }
    }

    // Ceiling outline only, so the camera never gets blocked.
    const ceil = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, L)), edgeMat);
    ceil.rotation.x = -Math.PI / 2;
    ceil.position.y = H;
    this.scene.add(ceil);
  }

  private buildCar(): void {
    const g = this.carGroup;
    const w = CAR.halfWidth * 2;
    const h = CAR.halfHeight * 2;
    const l = CAR.halfLength * 2;

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2c7be5, metalness: 0.4, roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, h * 0.7, l), bodyMat);
    body.position.y = -h * 0.15;
    body.castShadow = true;
    g.add(body);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.7, h * 0.55, l * 0.45),
      new THREE.MeshStandardMaterial({ color: 0x14203a, metalness: 0.6, roughness: 0.2 }),
    );
    cabin.position.set(0, h * 0.3, l * 0.05);
    cabin.castShadow = true;
    g.add(cabin);

    // Bright nose so the facing direction is obvious. Forward is -Z.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.8, h * 0.25, 0.12),
      new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xffd166, emissiveIntensity: 0.5 }),
    );
    nose.position.set(0, -h * 0.15, -l / 2 + 0.06);
    g.add(nose);

    const wheelGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.16, 20);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
    for (const x of [-1, 1]) {
      for (const z of [-1, 1]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(x * (w / 2 + 0.02), -h * 0.45, z * l * 0.34);
        wheel.castShadow = true;
        g.add(wheel);
      }
    }

    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.9, 12),
      new THREE.MeshBasicMaterial({ color: 0xffa62b, transparent: true, opacity: 0.9 }),
    );
    flame.name = 'flame';
    flame.rotation.x = Math.PI / 2; // tip points +Z (rear)
    flame.position.set(0, -h * 0.1, l / 2 + 0.45);
    flame.visible = false;
    g.add(flame);

    this.scene.add(g);
  }

  private buildBall(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius, 40, 28),
      new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.5, metalness: 0.05 }),
    );
    mesh.castShadow = true;
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
  const W = 1024;
  const Hpx = Math.round((W * (ARENA.length + 2 * ARENA.goalDepth)) / ARENA.width);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = Hpx;
  const ctx = cv.getContext('2d')!;
  const sx = W / ARENA.width;
  const sz = Hpx / (ARENA.length + 2 * ARENA.goalDepth);

  ctx.fillStyle = '#1d5a2c';
  ctx.fillRect(0, 0, W, Hpx);
  // Mowing stripes.
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    if (i % 2) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fillRect(0, (i * Hpx) / stripes, W, Hpx / stripes);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 6;
  const zToPx = (z: number) => Hpx / 2 - z * sz; // +Z (orange) is at the top of the texture
  const xToPx = (x: number) => W / 2 + x * sx;

  // Goal lines.
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, zToPx(s * (ARENA.length / 2)));
    ctx.lineTo(W, zToPx(s * (ARENA.length / 2)));
    ctx.stroke();
  }
  // Half line and centre circle.
  ctx.beginPath();
  ctx.moveTo(0, zToPx(0));
  ctx.lineTo(W, zToPx(0));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(xToPx(0), zToPx(0), 9 * sx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(xToPx(0), zToPx(0), 0.6 * sx, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fill();
  // Goal boxes.
  for (const s of [-1, 1]) {
    const z0 = zToPx(s * (ARENA.length / 2));
    const z1 = zToPx(s * (ARENA.length / 2 - 12));
    ctx.strokeRect(xToPx(-ARENA.goalWidth / 2 - 6), Math.min(z0, z1), (ARENA.goalWidth + 12) * sx, Math.abs(z1 - z0));
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeBallTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
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
