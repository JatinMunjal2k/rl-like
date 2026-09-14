import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { CAR, steerCurvature, throttleAccel } from './constants';
import type { CarInput } from '../input/types';

const LOCAL_FORWARD = new Vector3(0, 0, -1);
const LOCAL_UP = new Vector3(0, 1, 0);
const LOCAL_RIGHT = new Vector3(1, 0, 0);

/** Wheel ray origins in car-local space (x right, y up, z back). */
const WHEEL_POINTS = [
  new Vector3(0.35, 0, -0.45),
  new Vector3(-0.35, 0, -0.45),
  new Vector3(0.35, 0, 0.45),
  new Vector3(-0.35, 0, 0.45),
];

// Scratch objects to avoid per-tick allocation.
const q = new Quaternion();
const qInv = new Quaternion();
const pos = new Vector3();
const vel = new Vector3();
const angVel = new Vector3();
const forward = new Vector3();
const up = new Vector3();
const right = new Vector3();
const normal = new Vector3();
const tmp = new Vector3();
const tmp2 = new Vector3();
const localAng = new Vector3();

/**
 * Arcade car controller in the spirit of Rocket League, driving a Rapier dynamic body
 * by writing its linear and angular velocity each fixed tick. Collisions with the ball
 * and arena are left to the physics engine.
 */
export class Car {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  grounded = false;
  boost = 100;
  boosting = false;

  private prevJump = false;
  private sinceJump = Infinity; // seconds since the first jump left the ground
  private jumpHoldLeft = 0;
  private hasJumped = false;
  private hasFlipped = false;
  private flipLeft = 0;
  private flipAxis = new Vector3();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(private readonly world: RAPIER.World) {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setLinearDamping(0)
      .setAngularDamping(0);
    this.body = world.createRigidBody(bodyDesc);

    const volume = 8 * CAR.halfWidth * CAR.halfHeight * CAR.halfLength;
    const colliderDesc = RAPIER.ColliderDesc.cuboid(CAR.halfWidth, CAR.halfHeight, CAR.halfLength)
      .setDensity(CAR.mass / volume)
      .setFriction(CAR.friction)
      .setRestitution(CAR.restitution);
    this.collider = world.createCollider(colliderDesc, this.body);
  }

  reset(x: number, y: number, z: number, yaw: number): void {
    q.setFromAxisAngle(LOCAL_UP, yaw);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.boost = 100;
    this.prevJump = false;
    this.sinceJump = Infinity;
    this.jumpHoldLeft = 0;
    this.hasJumped = false;
    this.hasFlipped = false;
    this.flipLeft = 0;
  }

  tick(input: CarInput, dt: number): void {
    const b = this.body;
    const r = b.rotation();
    q.set(r.x, r.y, r.z, r.w);
    const t = b.translation();
    pos.set(t.x, t.y, t.z);
    const lv = b.linvel();
    vel.set(lv.x, lv.y, lv.z);
    const av = b.angvel();
    angVel.set(av.x, av.y, av.z);

    forward.copy(LOCAL_FORWARD).applyQuaternion(q);
    up.copy(LOCAL_UP).applyQuaternion(q);
    right.copy(LOCAL_RIGHT).applyQuaternion(q);

    this.sinceJump += dt;
    if (this.flipLeft > 0) this.flipLeft -= dt;

    const wheelsDown = this.probeGround();
    this.grounded = wheelsDown && this.sinceJump > CAR.groundedGraceAfterJump;

    if (this.grounded) {
      this.hasJumped = false;
      this.hasFlipped = false;
      this.flipLeft = 0;
      this.driveOnGround(input, dt);
    } else {
      this.controlInAir(input, dt);
    }

    this.handleJump(input, dt);
    this.handleBoost(input, dt);

    // Hard speed cap, like the real game.
    const speed = vel.length();
    if (speed > CAR.maxSpeed) vel.multiplyScalar(CAR.maxSpeed / speed);

    b.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    b.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
    this.prevJump = input.jump;
  }

  /** Casts a ray down from each wheel. Grounded if at least two hit. Averages the surface normal. */
  private probeGround(): boolean {
    let hits = 0;
    normal.set(0, 0, 0);
    const maxToi = CAR.halfHeight + CAR.groundRayExtra;
    for (const wp of WHEEL_POINTS) {
      tmp.copy(wp).applyQuaternion(q).add(pos);
      tmp2.copy(up).negate();
      this.ray.origin.x = tmp.x;
      this.ray.origin.y = tmp.y;
      this.ray.origin.z = tmp.z;
      this.ray.dir.x = tmp2.x;
      this.ray.dir.y = tmp2.y;
      this.ray.dir.z = tmp2.z;
      const hit = this.world.castRayAndGetNormal(this.ray, maxToi, true, undefined, undefined, undefined, this.body);
      if (hit) {
        hits++;
        normal.x += hit.normal.x;
        normal.y += hit.normal.y;
        normal.z += hit.normal.z;
      }
    }
    if (hits >= 2) {
      normal.normalize();
      return true;
    }
    normal.set(0, 1, 0);
    return false;
  }

  private driveOnGround(input: CarInput, dt: number): void {
    // Surface-aligned frame.
    const fwdS = tmp.copy(forward).addScaledVector(normal, -forward.dot(normal));
    if (fwdS.lengthSq() < 1e-6) fwdS.copy(forward);
    fwdS.normalize();
    const rightS = tmp2.crossVectors(fwdS, normal).normalize();

    let vN = vel.dot(normal);
    let vF = vel.dot(fwdS);
    let vR = vel.dot(rightS);

    // Throttle / brake / coast along the forward axis.
    const throttle = input.throttle;
    if (Math.abs(throttle) > 0.01) {
      if (throttle * vF < -0.01) {
        // Opposing current motion: brake.
        const dv = CAR.brakeAccel * dt;
        vF = Math.abs(vF) <= dv ? 0 : vF - Math.sign(vF) * dv;
      } else {
        vF += throttle * throttleAccel(vF) * dt;
      }
    } else if (!input.boost) {
      const dv = CAR.coastAccel * dt;
      vF = Math.abs(vF) <= dv ? 0 : vF - Math.sign(vF) * dv;
    }

    // Lateral grip.
    const grip = input.handbrake ? CAR.gripSlide : CAR.gripNormal;
    vR *= Math.exp(-grip * dt);

    // Stick to the surface.
    vN -= CAR.stickyAccel * dt;

    vel.copy(normal).multiplyScalar(vN).addScaledVector(fwdS, vF).addScaledVector(rightS, vR);

    // Steering: yaw rate scales with speed and turning radius. Positive yaw about "up"
    // turns left in a right-handed Y-up world, so steering right is negative.
    const speed = Math.abs(vF);
    let yawRate = -input.steer * speed * steerCurvature(speed) * Math.sign(vF || 1);
    if (input.handbrake) yawRate *= CAR.slideYawGain;

    // Align the car's up with the surface normal.
    const err = tmp.crossVectors(up, normal); // rotation that takes up -> normal
    angVel.copy(normal).multiplyScalar(yawRate).addScaledVector(err, CAR.alignGain);
  }

  private controlInAir(input: CarInput, dt: number): void {
    if (this.flipLeft > 0) {
      // Committed to a dodge: hold the flip rotation.
      angVel.copy(this.flipAxis).multiplyScalar(CAR.flipAngVel);
      return;
    }

    qInv.copy(q).invert();
    localAng.copy(angVel).applyQuaternion(qInv);

    // Local axes: x = pitch (positive = nose up), y = yaw (positive = left), z = roll (positive = roll left).
    const pitchIn = input.pitch;
    const yawIn = -input.yaw;
    const rollIn = -input.roll;

    localAng.x += CAR.pitchTorque * pitchIn * dt;
    localAng.y += CAR.yawTorque * yawIn * dt;
    localAng.z += CAR.rollTorque * rollIn * dt;

    // Damping: yaw always, pitch and roll only while the axis is uncommanded.
    localAng.y *= Math.exp(-CAR.yawDamp * dt);
    if (Math.abs(pitchIn) < 0.01) localAng.x *= Math.exp(-CAR.pitchDamp * dt);
    if (Math.abs(rollIn) < 0.01) localAng.z *= Math.exp(-CAR.rollDamp * dt);

    const mag = localAng.length();
    if (mag > CAR.maxAngVel) localAng.multiplyScalar(CAR.maxAngVel / mag);

    angVel.copy(localAng).applyQuaternion(q);
  }

  private handleJump(input: CarInput, dt: number): void {
    const pressed = input.jump && !this.prevJump;

    if (pressed && this.grounded) {
      vel.addScaledVector(up, CAR.jumpImpulse);
      this.hasJumped = true;
      this.jumpHoldLeft = CAR.jumpHoldMax;
      this.sinceJump = 0;
      this.grounded = false;
      return;
    }

    if (input.jump && this.jumpHoldLeft > 0) {
      vel.addScaledVector(up, CAR.jumpHoldAccel * dt);
      this.jumpHoldLeft -= dt;
    } else {
      this.jumpHoldLeft = 0;
    }

    const canSecondJump =
      pressed && !this.grounded && this.hasJumped && !this.hasFlipped && this.sinceJump < CAR.doubleJumpWindow;
    if (!canSecondJump) return;

    this.hasFlipped = true;
    this.jumpHoldLeft = 0;

    // Stick deflection decides double jump vs dodge. Forward component comes from
    // pushing the stick forward (negative pitch), lateral from steer.
    const f = -input.pitch;
    const s = input.steer;
    if (Math.hypot(f, s) < 0.5) {
      vel.addScaledVector(up, CAR.jumpImpulse);
      return;
    }

    // Dodge in the car's horizontal plane.
    const fwdH = tmp.copy(forward).setY(0);
    if (fwdH.lengthSq() < 1e-6) fwdH.copy(forward);
    fwdH.normalize();
    const rightH = tmp2.crossVectors(fwdH, LOCAL_UP).normalize();
    const dir = fwdH.multiplyScalar(f).addScaledVector(rightH, s).normalize();

    vel.addScaledVector(dir, CAR.dodgeImpulse);
    // Dodging also kills downward speed, like the real game.
    if (vel.y < 0) vel.y = 0;

    // Flip rotation: axis = up × dir gives nose-down for a forward dodge.
    this.flipAxis.crossVectors(LOCAL_UP, dir).normalize();
    this.flipLeft = CAR.flipDuration;
  }

  private handleBoost(input: CarInput, dt: number): void {
    this.boosting = input.boost && (CAR.infiniteBoost || this.boost > 0);
    if (!this.boosting) return;
    vel.addScaledVector(forward, CAR.boostAccel * dt);
    if (!CAR.infiniteBoost) this.boost = Math.max(0, this.boost - CAR.boostConsumption * dt);
  }
}
