/**
 * All sim units are metres and seconds. Values are Rocket League's, scaled by
 * 1 unreal unit = 1 cm, so the arena, car and ball proportions match the real game.
 *
 * Axis convention (three.js / Rapier): Y up. Car forward is local -Z, right is +X.
 * Blue spawns at -Z and attacks the goal at +Z (orange's goal).
 */

export const TICK_RATE = 120;
export const TICK_DT = 1 / TICK_RATE;
export const GRAVITY = 6.5;

export const ARENA = {
  width: 81.92,
  length: 102.4,
  height: 20.44,
  cornerCut: 11.52, // 45° corner walls remove this much of each side
  goalWidth: 17.86,
  goalHeight: 6.43,
  goalDepth: 8.8,
  wallThickness: 1.0,
};

export const BALL = {
  radius: 0.9275,
  mass: 30,
  restitution: 0.6,
  friction: 0.35,
  linearDamping: 0.03,
  angularDamping: 0.05,
  spawnHeight: 0.9315,
};

export const CAR = {
  // Octane hitbox: 118.0 x 84.2 x 36.2 uu (length, width, height)
  halfLength: 0.59,
  halfWidth: 0.421,
  halfHeight: 0.181,
  mass: 180,
  restitution: 0.1,
  friction: 0.3,

  maxSpeed: 23.0, // 2300 uu/s, hard cap on |velocity|
  maxThrottleSpeed: 14.1, // throttle alone cannot exceed this
  brakeAccel: 35.0,
  coastAccel: 5.25,
  boostAccel: 9.9167,
  boostConsumption: 33.3, // per second, out of 100
  infiniteBoost: true,

  stickyAccel: 3.25, // pushes the car into the driving surface
  gripNormal: 12.0, // per-second decay of lateral velocity on the ground
  gripSlide: 2.5, // same while powersliding
  slideYawGain: 1.6,
  groundRayExtra: 0.15, // how far below the hitbox a wheel ray still counts as ground
  alignGain: 14.0, // how quickly the car's up snaps to the surface normal

  jumpImpulse: 2.92,
  jumpHoldAccel: 14.58,
  jumpHoldMax: 0.2,
  doubleJumpWindow: 1.25,
  dodgeImpulse: 5.0,
  flipAngVel: 7.0,
  flipDuration: 0.65,
  groundedGraceAfterJump: 0.12,

  maxAngVel: 5.5,
  pitchTorque: 12.46,
  yawTorque: 9.11,
  rollTorque: 38.34,
  pitchDamp: 2.798,
  yawDamp: 3.14,
  rollDamp: 4.47,
};

/** Throttle acceleration (m/s²) as a function of forward speed (m/s). */
export function throttleAccel(speed: number): number {
  const s = Math.abs(speed);
  if (s >= 14.1) return 0;
  if (s <= 14.0) return 16.0 + (1.6 - 16.0) * (s / 14.0);
  return 1.6 * (1 - (s - 14.0) / 0.1);
}

/** Steering curvature (1/m) as a function of speed (m/s). Yaw rate = speed * curvature. */
const CURVATURE: [number, number][] = [
  [0, 0.69],
  [5, 0.398],
  [10, 0.235],
  [15, 0.1375],
  [17.5, 0.11],
  [23, 0.088],
];
export function steerCurvature(speed: number): number {
  const s = Math.min(Math.abs(speed), 23);
  for (let i = 1; i < CURVATURE.length; i++) {
    const [s0, k0] = CURVATURE[i - 1];
    const [s1, k1] = CURVATURE[i];
    if (s <= s1) return k0 + ((k1 - k0) * (s - s0)) / (s1 - s0);
  }
  return CURVATURE[CURVATURE.length - 1][1];
}

export const KICKOFF = {
  car: { x: 0, y: 0.45, z: -46.08, yaw: Math.PI }, // forward is -Z, so yaw π faces +Z (orange goal)
  ball: { x: 0, y: BALL.spawnHeight, z: 0 },
};
