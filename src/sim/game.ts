import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { ARENA, BALL, BALL_CAR_EXTRA_IMPULSE, GRAVITY, KICKOFF_SPAWNS, TICK_DT, UU, curve } from './rl';
import { TUNING } from './tuning';
import { allColliderBoxes, buildArenaGeometry, type ArenaGeometry } from './arena';
import { Car } from './car';
import { EMPTY_INPUT, type CarInput } from '../input/types';

/** Plain-number transform so it can be copied, interpolated and later sent over the wire. */
export interface BodyState {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface Snapshot {
  tick: number;
  car: BodyState;
  ball: BodyState;
}

export type Team = 'blue' | 'orange';

function emptyState(): BodyState {
  return { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

function readBody(body: RAPIER.RigidBody, out: BodyState): void {
  const t = body.translation();
  const r = body.rotation();
  out.px = t.x;
  out.py = t.y;
  out.pz = t.z;
  out.qx = r.x;
  out.qy = r.y;
  out.qz = r.z;
  out.qw = r.w;
}

// Scratch vectors for the car-ball impulse.
const relVel = new Vector3();
const hitDir = new Vector3();
const carFwd = new Vector3();
const carRot = new Quaternion();

/**
 * The whole match simulation: arena, one car, one ball, goal detection. Deterministic,
 * fixed-tick, no rendering concerns. The same class can later run headless on a server.
 */
export class Game {
  readonly world: RAPIER.World;
  readonly arena: ArenaGeometry;
  readonly car: Car;
  readonly ball: RAPIER.RigidBody;
  readonly ballCollider: RAPIER.Collider;

  tick = 0;
  score: Record<Team, number> = { blue: 0, orange: 0 };
  lastGoal: Team | null = null;
  /** Seconds left in the post-goal freeze before kickoff. */
  goalPause = 0;
  /** True on ticks where the car touched the ball. */
  ballTouched = false;

  readonly prev: Snapshot = { tick: 0, car: emptyState(), ball: emptyState() };
  readonly curr: Snapshot = { tick: 0, car: emptyState(), ball: emptyState() };

  static async create(): Promise<Game> {
    await RAPIER.init();
    return new Game();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = TICK_DT;
    this.arena = buildArenaGeometry();
    this.buildArenaColliders();
    [this.ball, this.ballCollider] = this.buildBall();
    this.car = new Car(this.world, { infiniteBoost: true });
    this.resetKickoff();
    this.capture(this.curr);
    Object.assign(this.prev, structuredClone(this.curr));
  }

  step(input: CarInput, dt: number = TICK_DT): void {
    Object.assign(this.prev.car, this.curr.car);
    Object.assign(this.prev.ball, this.curr.ball);
    this.prev.tick = this.curr.tick;

    let effective = input;
    if (this.goalPause > 0) {
      this.goalPause -= dt;
      effective = EMPTY_INPUT;
      if (this.goalPause <= 0) {
        this.goalPause = 0;
        this.resetKickoff();
      }
    }

    this.car.tick(effective, dt);
    this.world.step();
    this.tick++;

    this.applyCarBallExtraImpulse();
    this.clampBall();
    this.capture(this.curr);

    if (this.goalPause === 0) this.checkGoal();
  }

  resetKickoff(): void {
    // Centre kickoff spot. RL frame: x right, y toward orange. Ours: x right, z toward orange.
    const [sx, sy, yawRL] = KICKOFF_SPAWNS[4];
    // RL yaw is measured from +x toward +y (our +z). Our car faces -Z at yaw 0 and a rotation ψ
    // about +Y sends (0,0,-1) to (-sin ψ, 0, -cos ψ), so solve for the RL heading (cos θ, sin θ).
    const yaw = Math.atan2(-Math.cos(yawRL), -Math.sin(yawRL));
    this.car.reset(sx * UU, sy * UU, yaw);
    this.ball.setTranslation({ x: 0, y: BALL.restZ, z: 0 }, true);
    this.ball.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Full reset including score. */
  resetMatch(): void {
    this.score = { blue: 0, orange: 0 };
    this.lastGoal = null;
    this.goalPause = 0;
    this.resetKickoff();
  }

  private capture(into: Snapshot): void {
    into.tick = this.tick;
    readBody(this.car.body, into.car);
    readBody(this.ball, into.ball);
  }

  private checkGoal(): void {
    const z = this.curr.ball.pz;
    const line = ARENA.goalScoreThresholdY + BALL.radius;
    if (z > line) this.onGoal('blue');
    else if (z < -line) this.onGoal('orange');
  }

  private onGoal(team: Team): void {
    this.score[team]++;
    this.lastGoal = team;
    this.goalPause = TUNING.goalResetDelay;
  }

  /**
   * RL adds velocity to the ball on every tick a car touches it, on top of the rigid-body
   * collision. See BALL_CAR_EXTRA_IMPULSE in rl.ts for the formula and source.
   */
  private applyCarBallExtraImpulse(): void {
    let touching = false;
    this.world.contactPair(this.car.collider, this.ballCollider, (manifold) => {
      for (let i = 0; i < manifold.numContacts(); i++) {
        if (manifold.contactDist(i) <= 0) {
          touching = true;
          return;
        }
      }
    });
    this.ballTouched = touching;
    if (!touching) return;

    const bv = this.ball.linvel();
    const cv = this.car.body.linvel();
    relVel.set(bv.x - cv.x, bv.y - cv.y, bv.z - cv.z);
    const relSpeed = Math.min(relVel.length(), BALL_CAR_EXTRA_IMPULSE.maxDeltaVel);
    if (relSpeed <= 0) return;

    const bp = this.ball.translation();
    const cp = this.car.body.translation();
    hitDir.set(bp.x - cp.x, (bp.y - cp.y) * BALL_CAR_EXTRA_IMPULSE.zScale, bp.z - cp.z).normalize();

    const cr = this.car.body.rotation();
    carRot.set(cr.x, cr.y, cr.z, cr.w);
    carFwd.set(0, 0, -1).applyQuaternion(carRot);
    const along = hitDir.dot(carFwd) * (1 - BALL_CAR_EXTRA_IMPULSE.forwardScale);
    hitDir.addScaledVector(carFwd, -along).normalize();

    const factor = curve(BALL_CAR_EXTRA_IMPULSE.factorCurve, relSpeed / UU);
    const add = relSpeed * factor;
    this.ball.setLinvel({ x: bv.x + hitDir.x * add, y: bv.y + hitDir.y * add, z: bv.z + hitDir.z * add }, true);
  }

  private clampBall(): void {
    const v = this.ball.linvel();
    const s2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (s2 > BALL.maxSpeed * BALL.maxSpeed) {
      const k = BALL.maxSpeed / Math.sqrt(s2);
      this.ball.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
    }
    const w = this.ball.angvel();
    const w2 = w.x * w.x + w.y * w.y + w.z * w.z;
    if (w2 > BALL.maxAngularSpeed * BALL.maxAngularSpeed) {
      const k = BALL.maxAngularSpeed / Math.sqrt(w2);
      this.ball.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
    }
  }

  private buildBall(): [RAPIER.RigidBody, RAPIER.Collider] {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, BALL.restZ, 0)
        .setLinearDamping(BALL.drag)
        .setAngularDamping(0)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const volume = (4 / 3) * Math.PI * BALL.radius ** 3;
    // Combine rules are chosen so ball-arena = 0.6, car-arena = 0.3 (see tuning.ts for the car-ball compromise).
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(BALL.radius)
        .setDensity(BALL.mass / volume)
        .setRestitution(BALL.restitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
        .setFriction(BALL.friction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
      body,
    );
    return [body, collider];
  }

  private buildArenaColliders(): void {
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const material = (desc: RAPIER.ColliderDesc) =>
      desc
        .setFriction(ARENA.collisionFriction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(1.0) // multiplied by the ball's 0.6; the car uses Min with its own 0.3
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);

    // ORIENTED: the shell's normals point into the arena, so deep penetrations still push inward.
    const flags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES | RAPIER.TriMeshFlags.ORIENTED;
    this.world.createCollider(material(RAPIER.ColliderDesc.trimesh(this.arena.vertices, this.arena.indices, flags)), ground);
    for (const b of allColliderBoxes(this.arena)) {
      const desc = RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z);
      if (b.yaw) desc.setRotation({ x: 0, y: Math.sin(b.yaw / 2), z: 0, w: Math.cos(b.yaw / 2) });
      this.world.createCollider(material(desc), ground);
    }
  }
}
