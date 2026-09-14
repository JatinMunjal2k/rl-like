/**
 * VERIFIED Rocket League values.
 *
 * Every number here comes from one of two sources and is written in the game's own
 * unreal units (uu, uu/s, uu/s², rad, s) with a `* UU` conversion to metres where the
 * sim consumes it. If you change a value here you are deviating from the real game.
 *
 *   [RS]  RocketSim by ZealanL, src/RLConst.h, src/Sim/Car/CarConfig/CarConfig.cpp
 *         https://github.com/ZealanL/RocketSim (reverse-engineered, tick-accurate sim)
 *   [WIKI] RLBot "Useful game values": https://wiki.rlbot.org/v4/botmaking/useful-game-values/
 *
 * Everything approximate or invented lives in ./tuning.ts instead.
 */

/** 1 unreal unit = 1 cm. All sim math is in metres. */
export const UU = 0.01;

export const TICK_RATE = 120; // [RS] RL physics runs at 120 Hz
export const TICK_DT = 1 / TICK_RATE;

export const GRAVITY = 650 * UU; // [RS] GRAVITY_Z = -650

// ---------------------------------------------------------------------------------
// Arena (standard soccar)
// ---------------------------------------------------------------------------------
export const ARENA = {
  extentX: 4096 * UU, // [RS][WIKI] side walls at x = ±4096
  extentY: 5120 * UU, // [RS][WIKI] back walls at y = ±5120 (our z axis)
  height: 2044 * UU, // [WIKI] ceiling z = 2044 ([RS] uses 2048 for its AABB)
  /** [WIKI] Corner walls lie on the 45° planes |x| + |y| = 8064, i.e. they cut 1152 uu off each axis. */
  cornerPlane: 8064 * UU,
  cornerCut: (4096 + 5120 - 8064) * UU, // = 1152 uu
  cornerWallLength: 1629.174 * UU, // [WIKI] = 1152 * sqrt(2)
  goalHalfWidth: 892.755 * UU, // [WIKI] goal centre-to-post
  goalHeight: 642.775 * UU, // [WIKI]
  goalDepth: 880 * UU, // [WIKI]
  /** [RS] SOCCAR_GOAL_SCORE_BASE_THRESHOLD_Y: goal when |ball.y| > this + ball radius. */
  goalScoreThresholdY: 5124.25 * UU,
  collisionFriction: 0.6, // [RS] ARENA_COLLISION_BASE_FRICTION
  collisionRestitution: 0.3, // [RS] ARENA_COLLISION_BASE_RESTITUTION
};

// ---------------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------------
export const BALL = {
  radius: 92.75 * UU, // [WIKI] (RocketSim uses 91.25 collision radius + Bullet margin, resting at z = 93.15)
  restZ: 93.15 * UU, // [RS] BALL_REST_Z
  mass: 30, // [RS] BALL_MASS_BT = CAR_MASS_BT / 6
  restitution: 0.6, // [RS] BALL_RESTITUTION
  friction: 0.35, // [RS] BALL_FRICTION
  drag: 0.03, // [RS] BALL_DRAG, applied as Bullet linear damping
  maxSpeed: 6000 * UU, // [RS] BALL_MAX_SPEED
  maxAngularSpeed: 6.0, // [RS] BALL_MAX_ANG_SPEED rad/s
  /** [RS] Car-ball contact material. */
  carFriction: 2.0, // CARBALL_COLLISION_FRICTION
  carRestitution: 0.0, // CARBALL_COLLISION_RESTITUTION
};

/**
 * [RS] Ball.cpp _OnHit: extra velocity added to the ball whenever a car touches it.
 *   relSpeed = min(|v_ball - v_car|, maxDeltaVel)
 *   hitDir   = normalize((ballPos - carPos) * (1, 1, zScale))     (z scaled BEFORE normalising)
 *   hitDir   = normalize(hitDir - carForward * dot(hitDir, carForward) * (1 - forwardScale))
 *   ballVel += hitDir * relSpeed * factorCurve(relSpeed)
 */
export const BALL_CAR_EXTRA_IMPULSE = {
  zScale: 0.35,
  forwardScale: 0.65,
  maxDeltaVel: 4600 * UU,
  /** relSpeed (uu/s) -> factor. */
  factorCurve: [
    [0, 0.65],
    [500, 0.65],
    [2300, 0.55],
    [4600, 0.3],
  ] as [number, number][],
};

// ---------------------------------------------------------------------------------
// Car: Octane preset
// ---------------------------------------------------------------------------------
/**
 * [RS] CarConfig.cpp CAR_CONFIG_OCTANE. RocketSim notes these hitbox extents reproduce the
 * real inertia tensor; the commonly shared 118.01 x 84.20 x 36.16 come from
 * GetLocalCollisionExtent() and are slightly off. Axes: x forward, y right, z up.
 */
export const OCTANE = {
  hitboxSize: { x: 120.507 * UU, y: 86.6994 * UU, z: 38.6591 * UU },
  /** Hitbox centre relative to the car origin (the origin is at axle height, between the wheels). */
  hitboxOffset: { x: 13.8757 * UU, y: 0, z: 20.755 * UU },
  frontWheelRadius: 12.5 * UU,
  rearWheelRadius: 15.0 * UU,
  frontSuspensionRest: 38.755 * UU,
  rearSuspensionRest: 37.055 * UU,
  /** Wheel connection points relative to the car origin (y mirrored for left/right). */
  frontWheelOffset: { x: 51.25 * UU, y: 25.9 * UU, z: 20.755 * UU },
  rearWheelOffset: { x: -33.75 * UU, y: 29.5 * UU, z: 20.755 * UU },
  /** [RS] CAR_SPAWN_REST_Z: height of the car origin when resting on flat ground. */
  restZ: 17 * UU,
};

export const CAR = {
  mass: 180, // [RS] CAR_MASS_BT
  maxSpeed: 2300 * UU, // [RS] CAR_MAX_SPEED
  supersonicStartSpeed: 2200 * UU, // [RS]
  supersonicMaintainMinSpeed: 2100 * UU, // [RS]
  supersonicMaintainMaxTime: 1.0, // [RS]
  maxAngularSpeed: 5.5, // [RS] CAR_MAX_ANG_SPEED rad/s

  /** [WIKI] Throttle acceleration is 1600 uu/s² at rest falling to 160 at 1400 and 0 at 1410. */
  throttleAccelMax: 1600 * UU,
  /** [RS] DRIVE_SPEED_TORQUE_FACTOR_CURVE: speed (uu/s) -> fraction of throttleAccelMax. */
  driveSpeedTorqueFactorCurve: [
    [0, 1.0],
    [1400, 0.1],
    [1410, 0.0],
  ] as [number, number][],
  brakeAccel: 3500 * UU, // [WIKI] brake deceleration
  coastAccel: 525 * UU, // [WIKI] coast deceleration ([RS] COASTING_BRAKE_FACTOR 0.15 of brake)
  airThrottleAccel: (200 / 3) * UU, // [RS] THROTTLE_AIR_ACCEL = 66.667

  boostAccelGround: (2975 / 3) * UU, // [RS] = 991.667
  boostAccelAir: (3175 / 3) * UU, // [RS] = 1058.333
  boostMax: 100, // [RS]
  boostUsedPerSecond: 100 / 3, // [RS]
  boostMinTime: 0.1, // [RS] once started, boost stays on at least this long

  jumpImmediateForce: (875 / 3) * UU, // [RS] = 291.667 uu/s instant velocity
  jumpAccel: (4375 / 3) * UU, // [RS] = 1458.333 uu/s² while holding
  jumpMinTime: 0.025, // [RS] jump always lasts at least this
  jumpMaxTime: 0.2, // [RS] hold gives acceleration up to this
  jumpResetTimePad: 1 / 40, // [RS]
  doubleJumpMaxDelay: 1.25, // [RS] window after the FIRST jump ENDS
  doubleJumpImpulse: (875 / 3) * UU, // [WIKI] same as the first jump

  /** [RS] Flip (dodge) constants. */
  flipInitialVelScale: 500 * UU, // FLIP_INITIAL_VEL_SCALE
  flipTorqueTime: 0.65, // FLIP_TORQUE_TIME
  flipTorqueMinTime: 0.41, // FLIP_TORQUE_MIN_TIME (flip cancel can end torque after this)
  flipPitchLockTime: 1.0, // FLIP_PITCHLOCK_TIME
  flipPitchLockExtraTime: 0.3, // FLIP_PITCHLOCK_EXTRA_TIME
  flipZDamp120: 0.35, // FLIP_Z_DAMP_120: per-tick factor applied to vertical velocity
  flipZDampStart: 0.15, // FLIP_Z_DAMP_START
  flipZDampEnd: 0.21, // FLIP_Z_DAMP_END
  flipTorqueX: 260, // FLIP_TORQUE_X (side flips)
  flipTorqueY: 224, // FLIP_TORQUE_Y (front/back flips)
  flipForwardImpulseMaxSpeedScale: 1.0, // FLIP_FORWARD_IMPULSE_MAX_SPEED_SCALE
  flipSideImpulseMaxSpeedScale: 1.9, // FLIP_SIDE_IMPULSE_MAX_SPEED_SCALE
  flipBackwardImpulseMaxSpeedScale: 2.5, // FLIP_BACKWARD_IMPULSE_MAX_SPEED_SCALE
  flipBackwardImpulseScaleX: 16 / 15, // FLIP_BACKWARD_IMPULSE_SCALE_X
  flipDodgeDeadzone: 0.1, // [RS] stick magnitude below this = double jump instead of dodge
  flipBackwardSpeedThreshold: 100 * UU, // [RS] |forwardSpeed| below which "backwards" is judged from stick only

  /** [RS] CAR_TORQUE_SCALE converts raw torque constants to rad/s². */
  torqueScale: ((2 * Math.PI) / 65536) * 1000,
  /** [RS] CAR_AIR_CONTROL_TORQUE (pitch, yaw, roll) and CAR_AIR_CONTROL_DAMPING, raw. */
  airControlTorque: { pitch: 130, yaw: 95, roll: 400 },
  airControlDamping: { pitch: 30, yaw: 20, roll: 50 },
  /**
   * [WIKI] The same air control expressed as measured angular accelerations (rad/s²) and
   * damping coefficients (1/s). These are what the sim uses; they match the raw values above.
   */
  airPitchAccel: 12.46,
  airYawAccel: 9.11,
  airRollAccel: 38.34,
  airPitchDamp: 2.798,
  airYawDamp: 3.14,
  airRollDamp: 4.47,

  /** [RS] Autoflip: pressing jump while upside down on a surface rights the car. */
  autoflipImpulse: 200 * UU, // CAR_AUTOFLIP_IMPULSE, along -carUp
  autoflipTorque: 50, // CAR_AUTOFLIP_TORQUE rad/s² about carForward
  autoflipTime: 0.4, // CAR_AUTOFLIP_TIME, scaled by |roll| / π
  autoflipNormalZThreshold: Math.SQRT1_2, // CAR_AUTOFLIP_NORMZ_THRESH: surface normal must point up
  autoflipRollThreshold: 2.8, // CAR_AUTOFLIP_ROLL_THRESH rad: car must be nearly upside down
  /** [RS] Autoroll: with throttle held and partial contact, the car is pushed and rolled onto its wheels. */
  autorollForce: 100 * UU, // CAR_AUTOROLL_FORCE (acceleration toward the surface)
  autorollTorque: 80, // CAR_AUTOROLL_TORQUE

  /** [RS] STEER_ANGLE_FROM_SPEED_CURVE: speed (uu/s) -> front wheel steer angle (rad). */
  steerAngleFromSpeedCurve: [
    [0, 0.53356],
    [500, 0.3193],
    [1000, 0.18203],
    [1500, 0.1057],
    [1750, 0.08507],
    [3000, 0.03454],
  ] as [number, number][],
  /** [RS] POWERSLIDE_STEER_ANGLE_FROM_SPEED_CURVE */
  powerslideSteerAngleFromSpeedCurve: [
    [0, 0.39235],
    [2500, 0.1261],
  ] as [number, number][],
  /**
   * [WIKI] Measured turning curvature (1/uu) vs speed (uu/s). Yaw rate = speed * curvature.
   * This is the community-measured result of the steer-angle curve plus the wheel model.
   */
  turnCurvatureCurve: [
    [0, 0.0069],
    [500, 0.00398],
    [1000, 0.00235],
    [1500, 0.001375],
    [1750, 0.0011],
    [2300, 0.00088],
  ] as [number, number][],
  /** [RS] Handbrake ramps up at 5/s and down at 2/s (POWERSLIDE_RISE_RATE / FALL_RATE). */
  powerslideRiseRate: 5,
  powerslideFallRate: 2,
  /** [RS] Wheel friction curves. Inputs are slip ratios; outputs are friction multipliers. */
  latFrictionCurve: [
    [0, 1.0],
    [1, 0.2],
  ] as [number, number][],
  handbrakeLatFrictionFactor: 0.1,
  handbrakeLongFrictionFactorCurve: [
    [0, 0.5],
    [1, 0.9],
  ] as [number, number][],
  nonStickyFrictionFactorCurve: [
    [0, 0.1],
    [0.7075, 0.5],
    [1, 1.0],
  ] as [number, number][],

  /** [RS] Contact materials. */
  worldFriction: 0.3, // CARWORLD_COLLISION_FRICTION
  worldRestitution: 0.3, // CARWORLD_COLLISION_RESTITUTION
  carFriction: 0.09, // CARCAR_COLLISION_FRICTION
  carRestitution: 0.1, // CARCAR_COLLISION_RESTITUTION

  /** [RS] Bullet raycast-vehicle suspension parameters (not yet used; see tuning.ts hover model). */
  suspensionStiffness: 500,
  wheelsDampingCompression: 25,
  wheelsDampingRelaxation: 40,
  maxSuspensionTravel: 12 * UU,
};

// ---------------------------------------------------------------------------------
// Boost pads [RS] (not implemented yet, kept for the next step)
// ---------------------------------------------------------------------------------
export const BOOST_PADS = {
  bigAmount: 100,
  smallAmount: 12,
  bigCooldown: 10,
  smallCooldown: 4,
  /** Pickup volume: a cylinder of this height and radius, plus a box. */
  cylinderHeight: 95 * UU,
  cylinderRadiusBig: 208 * UU,
  cylinderRadiusSmall: 144 * UU,
  boxHeight: 64 * UU,
  boxRadiusBig: 160 * UU,
  boxRadiusSmall: 120 * UU,
  /** [x, y] in uu (RL frame: y is the long axis). */
  bigLocations: [
    [-3584, 0],
    [3584, 0],
    [-3072, 4096],
    [3072, 4096],
    [-3072, -4096],
    [3072, -4096],
  ] as [number, number][],
  smallLocations: [
    [0, -4240], [-1792, -4184], [1792, -4184], [-940, -3308], [940, -3308], [0, -2816],
    [-3584, -2484], [3584, -2484], [-1788, -2300], [1788, -2300], [-2048, -1036], [0, -1024],
    [2048, -1036], [-1024, 0], [1024, 0], [-2048, 1036], [0, 1024], [2048, 1036],
    [-1788, 2300], [1788, 2300], [-3584, 2484], [3584, 2484], [0, 2816], [-940, 3308],
    [940, 3308], [-1792, 4184], [1792, 4184], [0, 4240],
  ] as [number, number][],
};

/** [RS] CAR_SPAWN_LOCATIONS_SOCCAR for the blue team: [x, y, yaw] with yaw measured from +x toward +y. */
export const KICKOFF_SPAWNS: [number, number, number][] = [
  [-2048, -2560, Math.PI / 4],
  [2048, -2560, (Math.PI / 4) * 3],
  [-256, -3840, Math.PI / 2],
  [256, -3840, Math.PI / 2],
  [0, -4608, Math.PI / 2],
];

/** Piecewise-linear lookup on a [[x, y], ...] table, clamped at both ends. */
export function curve(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}
