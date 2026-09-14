import RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, BALL, GRAVITY, KICKOFF, TICK_DT } from './constants';
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

/**
 * The whole match simulation: arena, one car, one ball, goal detection. Deterministic,
 * fixed-tick, no rendering concerns. Designed so the same class can later run headless on a server.
 */
export class Game {
  readonly world: RAPIER.World;
  readonly car: Car;
  readonly ball: RAPIER.RigidBody;

  tick = 0;
  score: Record<Team, number> = { blue: 0, orange: 0 };
  lastGoal: Team | null = null;
  /** Seconds left in the post-goal freeze before kickoff. */
  goalPause = 0;

  readonly prev: Snapshot = { tick: 0, car: emptyState(), ball: emptyState() };
  readonly curr: Snapshot = { tick: 0, car: emptyState(), ball: emptyState() };

  static async create(): Promise<Game> {
    await RAPIER.init();
    return new Game();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = TICK_DT;
    this.buildArena();
    this.ball = this.buildBall();
    this.car = new Car(this.world);
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
    this.capture(this.curr);

    if (this.goalPause === 0) this.checkGoal();
  }

  resetKickoff(): void {
    const c = KICKOFF.car;
    this.car.reset(c.x, c.y, c.z, c.yaw);
    const b = KICKOFF.ball;
    this.ball.setTranslation({ x: b.x, y: b.y, z: b.z }, true);
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
    const line = ARENA.length / 2 + BALL.radius;
    if (z > line) this.onGoal('blue');
    else if (z < -line) this.onGoal('orange');
  }

  private onGoal(team: Team): void {
    this.score[team]++;
    this.lastGoal = team;
    this.goalPause = 2.0;
  }

  private buildBall(): RAPIER.RigidBody {
    const b = KICKOFF.ball;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b.x, b.y, b.z)
        .setLinearDamping(BALL.linearDamping)
        .setAngularDamping(BALL.angularDamping)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const volume = (4 / 3) * Math.PI * BALL.radius ** 3;
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(BALL.radius)
        .setDensity(BALL.mass / volume)
        .setRestitution(BALL.restitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(BALL.friction),
      body,
    );
    return body;
  }

  /** Static arena: floor, ceiling, side walls, end walls with goal openings, goal boxes, 45° corners. */
  private buildArena(): void {
    const A = ARENA;
    const t = A.wallThickness;
    const W = A.width;
    const L = A.length;
    const H = A.height;
    const gw = A.goalWidth;
    const gh = A.goalHeight;
    const gd = A.goalDepth;

    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const box = (hx: number, hy: number, hz: number, x: number, y: number, z: number, yaw = 0) => {
      const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.6);
      if (yaw !== 0) {
        const s = Math.sin(yaw / 2);
        const c = Math.cos(yaw / 2);
        desc.setRotation({ x: 0, y: s, z: 0, w: c });
      }
      this.world.createCollider(desc, ground);
    };

    // Floor and ceiling extend through the goals.
    box(W / 2 + t, t / 2, L / 2 + gd + t, 0, -t / 2, 0);
    box(W / 2 + t, t / 2, L / 2 + t, 0, H + t / 2, 0);

    // Side walls.
    box(t / 2, H / 2 + t, L / 2 + t, -(W / 2 + t / 2), H / 2, 0);
    box(t / 2, H / 2 + t, L / 2 + t, W / 2 + t / 2, H / 2, 0);

    for (const s of [-1, 1]) {
      const zWall = s * (L / 2 + t / 2);
      // End wall pieces beside the goal mouth.
      const sideHalf = (W / 2 - gw / 2) / 2;
      const sideCenter = gw / 2 + sideHalf;
      box(sideHalf, H / 2 + t, t / 2, -sideCenter, H / 2, zWall);
      box(sideHalf, H / 2 + t, t / 2, sideCenter, H / 2, zWall);
      // Above the goal mouth.
      box(gw / 2, (H - gh) / 2 + t, t / 2, 0, gh + (H - gh) / 2, zWall);

      // Goal box.
      const zGoalCenter = s * (L / 2 + gd / 2);
      box(gw / 2 + t, gh / 2 + t, t / 2, 0, gh / 2, s * (L / 2 + gd + t / 2)); // back
      box(t / 2, gh / 2 + t, gd / 2 + t, -(gw / 2 + t / 2), gh / 2, zGoalCenter); // left
      box(t / 2, gh / 2 + t, gd / 2 + t, gw / 2 + t / 2, gh / 2, zGoalCenter); // right
      box(gw / 2 + t, t / 2, gd / 2 + t, 0, gh + t / 2, zGoalCenter); // roof
    }

    // 45° corner walls.
    const c = A.cornerCut;
    const halfLen = c / Math.SQRT2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const nx = sx / Math.SQRT2;
        const nz = sz / Math.SQRT2;
        const cx = sx * (W / 2 - c / 2) + nx * (t / 2);
        const cz = sz * (L / 2 - c / 2) + nz * (t / 2);
        box(halfLen, H / 2 + t, t / 2, cx, H / 2, cz, Math.atan2(sx, sz));
      }
    }
  }
}
