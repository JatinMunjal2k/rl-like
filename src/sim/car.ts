import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { CAR, GRAVITY, OCTANE, UU, curve } from './rl';
import { TUNING } from './tuning';
import type { CarInput } from '../input/types';

// Car-local axes. Forward is -Z, right is +X, up is +Y.
const LOCAL_FORWARD = new Vector3(0, 0, -1);
const LOCAL_UP = new Vector3(0, 1, 0);
const LOCAL_RIGHT = new Vector3(1, 0, 0);
const WORLD_UP = new Vector3(0, 1, 0);

/** Octane hitbox half extents in our frame: x = width, y = height, z = length. */
export const HITBOX_HALF = {
  x: OCTANE.hitboxSize.y / 2,
  y: OCTANE.hitboxSize.z / 2,
  z: OCTANE.hitboxSize.x / 2,
};

/** Height of the hitbox centre above the surface when resting on the wheels. */
export const REST_HEIGHT = OCTANE.restZ + OCTANE.hitboxOffset.z;

/** Wheel connection points relative to the hitbox centre (RL x forward -> our -z; RL y -> our x). */
const WHEEL_POINTS = [
  new Vector3(OCTANE.frontWheelOffset.y, 0, -(OCTANE.frontWheelOffset.x - OCTANE.hitboxOffset.x)),
  new Vector3(-OCTANE.frontWheelOffset.y, 0, -(OCTANE.frontWheelOffset.x - OCTANE.hitboxOffset.x)),
  new Vector3(OCTANE.rearWheelOffset.y, 0, -(OCTANE.rearWheelOffset.x - OCTANE.hitboxOffset.x)),
  new Vector3(-OCTANE.rearWheelOffset.y, 0, -(OCTANE.rearWheelOffset.x - OCTANE.hitboxOffset.x)),
];
const GROUND_RAY_LENGTH = REST_HEIGHT + CAR.maxSuspensionTravel + TUNING.groundRaySlack;

// Scratch objects.
const q = new Quaternion();
const qInv = new Quaternion();
const pos = new Vector3();
const vel = new Vector3();
const angVel = new Vector3();
const forward = new Vector3();
const up = new Vector3();
const right = new Vector3();
const normal = new Vector3();
const contactNormal = new Vector3();
const tmp = new Vector3();
const tmp2 = new Vector3();
const localAng = new Vector3();

export interface CarOptions {
  infiniteBoost?: boolean;
}

/**
 * Octane simulated as one filled hitbox on a Rapier dynamic body. Each tick reads the body's
 * velocities, applies Rocket League's rules (see rl.ts) with the approximations in tuning.ts,
 * and writes the velocities back. Collisions with the ball and arena are left to Rapier.
 */
export class Car {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  grounded = false;
  /** Touching a surface with something other than the wheels (roof, side). */
  worldContact = false;
  boost = CAR.boostMax;
  boosting = false;
  supersonic = false;
  isJumping = false;
  isFlipping = false;
  isAutoflipping = false;

  private readonly infiniteBoost: boolean;
  private prevJump = false;
  private jumpTime = 0;
  private sinceJumpStart = Infinity;
  private airTimeSinceJump = 0;
  private hasJumped = false;
  private hasDoubleJumped = false;
  private hasFlipped = false;
  private flipTime = 0;
  private flipDirForward = 0;
  private flipDirSide = 0;
  private autoflipTimer = 0;
  private autoflipSign = 1;
  private boostingTime = 0;
  private supersonicTime = 0;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    private readonly world: RAPIER.World,
    options: CarOptions = {},
  ) {
    this.infiniteBoost = options.infiniteBoost ?? false;

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(0),
    );
    const volume = 8 * HITBOX_HALF.x * HITBOX_HALF.y * HITBOX_HALF.z;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(HITBOX_HALF.x, HITBOX_HALF.y, HITBOX_HALF.z)
        .setDensity(CAR.mass / volume)
        .setFriction(CAR.worldFriction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(CAR.worldRestitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );
  }

  /** Place the car at rest on flat ground at (x, z) with the given yaw (0 = facing -Z). */
  reset(x: number, z: number, yaw: number): void {
    q.setFromAxisAngle(LOCAL_UP, yaw);
    this.body.setTranslation({ x, y: REST_HEIGHT + TUNING.spawnDropHeight, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.boost = CAR.boostMax;
    this.boosting = false;
    this.supersonic = false;
    this.prevJump = false;
    this.isJumping = false;
    this.isFlipping = false;
    this.isAutoflipping = false;
    this.jumpTime = 0;
    this.sinceJumpStart = Infinity;
    this.airTimeSinceJump = 0;
    this.hasJumped = false;
    this.hasDoubleJumped = false;
    this.hasFlipped = false;
    this.flipTime = 0;
    this.autoflipTimer = 0;
    this.boostingTime = 0;
    this.supersonicTime = 0;
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

    const jumpPressed = input.jump && !this.prevJump;
    this.sinceJumpStart += dt;

    const groundDist = this.probeWheels();
    const wheelsDown = groundDist !== null;
    this.grounded = wheelsDown && !this.isJumping && this.sinceJumpStart > 0.1;
    this.worldContact = !this.grounded && this.probeWorldContact();

    if (this.grounded) {
      this.hasJumped = false;
      this.hasDoubleJumped = false;
      this.hasFlipped = false;
      this.isFlipping = false;
      this.isAutoflipping = false;
      this.autoflipTimer = 0;
      this.flipTime = 0;
      this.airTimeSinceJump = 0;
      this.driveOnGround(input, dt, groundDist!);
    } else {
      if (!this.isJumping && this.hasJumped) this.airTimeSinceJump += dt;
      this.updateFlip(input, dt);
      this.updateAutoflip(input, dt, jumpPressed);
      if (!this.isFlipping && !this.isAutoflipping) this.controlInAir(input, dt);
      if (this.worldContact && !this.isAutoflipping) this.autoroll(input, dt);
      // Air throttle is tiny but real.
      if (!this.isFlipping) vel.addScaledVector(forward, CAR.airThrottleAccel * input.throttle * dt);
    }

    this.updateJump(input, dt, jumpPressed);
    this.updateBoost(input, dt);

    // Hard caps, like the real game.
    const speed = vel.length();
    if (speed > CAR.maxSpeed) vel.multiplyScalar(CAR.maxSpeed / speed);
    const angSpeed = angVel.length();
    if (angSpeed > CAR.maxAngularSpeed) angVel.multiplyScalar(CAR.maxAngularSpeed / angSpeed);
    this.updateSupersonic(speed, dt);

    b.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    b.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
    this.prevJump = input.jump;
  }

  // ---------------------------------------------------------------------------
  // Contact probes
  // ---------------------------------------------------------------------------

  /** Casts down from each wheel. Returns the mean surface distance if ≥3 wheels are within reach, else null. */
  private probeWheels(): number | null {
    let hits = 0;
    let distSum = 0;
    normal.set(0, 0, 0);
    tmp2.copy(up).negate();
    for (const wp of WHEEL_POINTS) {
      tmp.copy(wp).applyQuaternion(q).add(pos);
      this.ray.origin.x = tmp.x;
      this.ray.origin.y = tmp.y;
      this.ray.origin.z = tmp.z;
      this.ray.dir.x = tmp2.x;
      this.ray.dir.y = tmp2.y;
      this.ray.dir.z = tmp2.z;
      const hit = this.world.castRayAndGetNormal(this.ray, GROUND_RAY_LENGTH, true, undefined, undefined, undefined, this.body);
      if (hit) {
        hits++;
        distSum += hit.timeOfImpact;
        normal.x += hit.normal.x;
        normal.y += hit.normal.y;
        normal.z += hit.normal.z;
      }
    }
    if (hits >= 3) {
      normal.normalize();
      return distSum / hits;
    }
    normal.set(0, 1, 0);
    return null;
  }

  /** One ray straight down in world space from the hitbox centre: roof or side resting on something. */
  private probeWorldContact(): boolean {
    this.ray.origin.x = pos.x;
    this.ray.origin.y = pos.y;
    this.ray.origin.z = pos.z;
    this.ray.dir.x = 0;
    this.ray.dir.y = -1;
    this.ray.dir.z = 0;
    const len = Math.max(HITBOX_HALF.x, HITBOX_HALF.y) + TUNING.roofContactRayExtra;
    const hit = this.world.castRayAndGetNormal(this.ray, len, true, undefined, undefined, undefined, this.body);
    if (!hit) return false;
    contactNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Ground driving
  // ---------------------------------------------------------------------------

  private driveOnGround(input: CarInput, dt: number, groundDist: number): void {
    // Surface-aligned frame.
    const fwdS = tmp.copy(forward).addScaledVector(normal, -forward.dot(normal));
    if (fwdS.lengthSq() < 1e-6) fwdS.copy(forward);
    fwdS.normalize();
    const rightS = tmp2.crossVectors(fwdS, normal).normalize();

    let vF = vel.dot(fwdS);
    let vR = vel.dot(rightS);

    const speedUU = Math.abs(vF) / UU;
    const throttle = input.throttle;
    if (Math.abs(throttle) > 0.001) {
      if (throttle * vF < -0.001) {
        // Opposing current motion: full brake.
        const dv = CAR.brakeAccel * dt;
        vF = Math.abs(vF) <= dv ? 0 : vF - Math.sign(vF) * dv;
      } else {
        vF += throttle * CAR.throttleAccelMax * curve(CAR.driveSpeedTorqueFactorCurve, speedUU) * dt;
      }
    } else if (!input.boost) {
      const dv = CAR.coastAccel * dt;
      vF = Math.abs(vF) <= dv ? 0 : vF - Math.sign(vF) * dv;
    }

    const grip = input.handbrake ? TUNING.lateralGripPowerslide : TUNING.lateralGripNormal;
    vR *= Math.exp(-grip * dt);

    // Suspension stand-in: a critically damped spring on the normal component. It ADDS to the
    // velocity Rapier produced, so contact push-back from the solver is preserved.
    let vN = vel.dot(normal);
    let accelN = TUNING.suspensionStiffness * (REST_HEIGHT - groundDist) - TUNING.suspensionDamping * vN;
    // Cancel gravity's component along the normal so the car rests at exactly REST_HEIGHT.
    accelN += GRAVITY * normal.y;
    // Pushing away from the surface can be strong; pulling toward it is limited to RL's sticky
    // force, which is why a car cannot drive on the ceiling (sticky 325 < gravity 650).
    accelN = Math.max(-TUNING.stickyAccel, Math.min(TUNING.suspensionMaxAccel, accelN));
    vN += accelN * dt;

    vel.copy(normal).multiplyScalar(vN).addScaledVector(fwdS, vF).addScaledVector(rightS, vR);

    // Steering. Positive rotation about "up" turns left in a right-handed Y-up world.
    const speed = Math.abs(vF);
    let yawRate = -input.steer * speed * (curve(CAR.turnCurvatureCurve, speedUU) / UU) * Math.sign(vF || 1);
    if (input.handbrake) yawRate *= TUNING.powerslideYawGain;

    // Rotate the car's up onto the surface normal.
    const err = tmp.crossVectors(up, normal);
    angVel.copy(normal).multiplyScalar(yawRate).addScaledVector(err, TUNING.alignGain);
  }

  // ---------------------------------------------------------------------------
  // Air control
  // ---------------------------------------------------------------------------

  private controlInAir(input: CarInput, dt: number): void {
    qInv.copy(q).invert();
    localAng.copy(angVel).applyQuaternion(qInv);

    // Local axes: x = pitch (+ nose up), y = yaw (+ left), z = roll (+ roll left).
    const pitchLocked = this.hasFlipped && this.flipTime < CAR.flipTorqueTime + CAR.flipPitchLockExtraTime;
    const pitchIn = pitchLocked ? 0 : input.pitch;
    const yawIn = -input.yaw;
    const rollIn = -input.roll;

    localAng.x += CAR.airPitchAccel * pitchIn * dt;
    localAng.y += CAR.airYawAccel * yawIn * dt;
    localAng.z += CAR.airRollAccel * rollIn * dt;

    // RL damps each axis in proportion to how little it is being commanded.
    localAng.x *= Math.exp(-CAR.airPitchDamp * (1 - Math.abs(pitchIn)) * dt);
    localAng.y *= Math.exp(-CAR.airYawDamp * (1 - Math.abs(yawIn)) * dt);
    localAng.z *= Math.exp(-CAR.airRollDamp * (1 - Math.abs(rollIn)) * dt);

    angVel.copy(localAng).applyQuaternion(q);
  }

  // ---------------------------------------------------------------------------
  // Jumping, double jump, dodge
  // ---------------------------------------------------------------------------

  private updateJump(input: CarInput, dt: number, jumpPressed: boolean): void {
    if (this.isJumping) {
      this.jumpTime += dt;
      const keepGoing = this.jumpTime < CAR.jumpMinTime || (input.jump && this.jumpTime < CAR.jumpMaxTime);
      if (keepGoing) {
        const scale = this.jumpTime < CAR.jumpMinTime ? 0.62 : 1;
        vel.addScaledVector(up, CAR.jumpAccel * scale * dt);
      } else {
        this.isJumping = false;
        this.airTimeSinceJump = 0;
      }
      return;
    }

    if (jumpPressed && this.grounded) {
      vel.addScaledVector(up, CAR.jumpImmediateForce);
      this.isJumping = true;
      this.jumpTime = 0;
      this.sinceJumpStart = 0;
      this.hasJumped = true;
      this.grounded = false;
      return;
    }

    const canSecond =
      jumpPressed &&
      !this.grounded &&
      this.hasJumped &&
      !this.hasDoubleJumped &&
      !this.hasFlipped &&
      !this.isAutoflipping &&
      this.airTimeSinceJump < CAR.doubleJumpMaxDelay;
    if (!canSecond) return;

    // RL builds the dodge direction from (-pitch, yaw + roll) and zeroes tiny inputs.
    let df = -input.pitch;
    let ds = input.yaw + input.roll;
    if (Math.abs(df) < CAR.flipDodgeDeadzone) df = 0;
    if (Math.abs(ds) < CAR.flipDodgeDeadzone) ds = 0;
    const mag = Math.hypot(df, ds);

    if (mag === 0) {
      vel.addScaledVector(up, CAR.doubleJumpImpulse);
      this.hasDoubleJumped = true;
      return;
    }

    df /= mag;
    ds /= mag;
    const forwardSpeed = vel.dot(forward);
    const speedRatio = Math.abs(forwardSpeed) / CAR.maxSpeed;
    const backwards =
      Math.abs(forwardSpeed) < CAR.flipBackwardSpeedThreshold ? df < 0 : Math.sign(df) !== Math.sign(forwardSpeed) && df !== 0;

    let vx = df * CAR.flipInitialVelScale;
    let vy = ds * CAR.flipInitialVelScale;
    const maxScaleX = backwards ? CAR.flipBackwardImpulseMaxSpeedScale : CAR.flipForwardImpulseMaxSpeedScale;
    vx *= (maxScaleX - 1) * speedRatio + 1;
    vy *= (CAR.flipSideImpulseMaxSpeedScale - 1) * speedRatio + 1;
    if (backwards) vx *= CAR.flipBackwardImpulseScaleX;

    vel.addScaledVector(forward, vx).addScaledVector(right, vy);

    this.hasFlipped = true;
    this.isFlipping = true;
    this.flipTime = 0;
    this.flipDirForward = df;
    this.flipDirSide = ds;
  }

  private updateFlip(input: CarInput, dt: number): void {
    if (!this.hasFlipped) return;
    this.flipTime += dt;
    this.isFlipping = this.flipTime < CAR.flipTorqueTime;

    if (this.isFlipping) {
      qInv.copy(q).invert();
      localAng.copy(angVel).applyQuaternion(qInv);
      // Forward flip = nose down = negative pitch; side flip right = roll right = negative local z.
      localAng.x -= this.flipDirForward * TUNING.flipAngularAccelFrontBack * dt;
      localAng.z -= this.flipDirSide * TUNING.flipAngularAccelSide * dt;
      angVel.copy(localAng).applyQuaternion(q);
    }

    // Vertical velocity damping during the dodge window (only while the flip torque is active).
    if (this.isFlipping && this.flipTime >= CAR.flipZDampStart && (vel.y < 0 || this.flipTime < CAR.flipZDampEnd)) {
      vel.y *= Math.pow(1 - CAR.flipZDamp120, dt * 120);
    }
    void input;
  }

  // ---------------------------------------------------------------------------
  // Recovery: autoflip (jump while upside down) and autoroll (throttle while on the side)
  // ---------------------------------------------------------------------------

  private updateAutoflip(input: CarInput, dt: number, jumpPressed: boolean): void {
    if (this.autoflipTimer > 0) {
      this.autoflipTimer -= dt;
      angVel.addScaledVector(forward, CAR.autoflipTorque * this.autoflipSign * dt);
      this.isAutoflipping = this.autoflipTimer > 0;
      return;
    }
    this.isAutoflipping = false;

    if (!jumpPressed || !this.worldContact) return;
    if (contactNormal.y <= CAR.autoflipNormalZThreshold) return;

    // Roll angle: positive when rolled to the right.
    const roll = Math.atan2(-right.y, up.y);
    const absRoll = Math.abs(roll);
    if (absRoll <= CAR.autoflipRollThreshold) return;

    this.autoflipTimer = CAR.autoflipTime * (absRoll / Math.PI);
    this.autoflipSign = roll >= 0 ? 1 : -1;
    this.isAutoflipping = true;
    // Push away from the surface: -carUp points at the ground when upside down.
    vel.addScaledVector(up, -CAR.autoflipImpulse);
    void input;
  }

  private autoroll(input: CarInput, dt: number): void {
    if (Math.abs(input.throttle) < 0.001) return;
    // Press into the surface and rotate the car's up toward the surface normal.
    vel.addScaledVector(contactNormal, -CAR.autorollForce * dt);
    const err = tmp.crossVectors(up, contactNormal);
    angVel.addScaledVector(err, TUNING.autorollAlignGain);
  }

  // ---------------------------------------------------------------------------
  // Boost and supersonic
  // ---------------------------------------------------------------------------

  private updateBoost(input: CarInput, dt: number): void {
    const hasBoost = this.infiniteBoost || this.boost > 0;
    if (this.boosting) {
      this.boostingTime += dt;
      this.boosting = hasBoost && (input.boost || this.boostingTime < CAR.boostMinTime);
    } else if (input.boost && hasBoost) {
      this.boosting = true;
      this.boostingTime = 0;
    }
    if (!this.boosting) return;
    const accel = this.grounded ? CAR.boostAccelGround : CAR.boostAccelAir;
    vel.addScaledVector(forward, accel * dt);
    if (!this.infiniteBoost) this.boost = Math.max(0, this.boost - CAR.boostUsedPerSecond * dt);
  }

  private updateSupersonic(speed: number, dt: number): void {
    if (speed >= CAR.supersonicStartSpeed) {
      this.supersonic = true;
      this.supersonicTime = 0;
    } else if (this.supersonic && speed >= CAR.supersonicMaintainMinSpeed) {
      this.supersonicTime += dt;
      if (this.supersonicTime > CAR.supersonicMaintainMaxTime) this.supersonic = false;
    } else {
      this.supersonic = false;
      this.supersonicTime = 0;
    }
  }
}

export { WORLD_UP };
