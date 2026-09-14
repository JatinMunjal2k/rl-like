/**
 * APPROXIMATIONS AND INVENTED VALUES.
 *
 * Nothing in this file is a verified Rocket League number. Each entry says what the real game
 * does instead and why we approximate. When a value here gets replaced by the real mechanism,
 * move the mechanism's constants to ./rl.ts and delete the entry.
 */
import { CAR, UU } from './rl';

export const TUNING = {
  // ------------------------------------------------------------------------------
  // Car body model
  // ------------------------------------------------------------------------------
  /**
   * We simulate the car as a single filled Octane hitbox whose centre of mass IS the hitbox
   * centre. RL's rigid body origin sits 13.9 uu behind and 20.8 uu below the hitbox centre
   * (OCTANE.hitboxOffset), so flips and dodges in RL rotate about a slightly different point.
   */
  bodyAtHitboxCentre: true,

  // ------------------------------------------------------------------------------
  // Ground contact: hover model instead of a raycast vehicle
  // ------------------------------------------------------------------------------
  /**
   * RL uses Bullet's btRaycastVehicle: four wheel rays each with its own spring/damper
   * (stiffness 500, damping 25 compression / 40 relaxation, 12 uu travel) and per-wheel
   * friction curves. We use ONE critically damped spring on the hitbox centre along the
   * averaged surface normal. Feels similar on flat ground; landings and wall transitions differ.
   */
  suspensionStiffness: 400, // 1/s²: acceleration per metre of height error
  suspensionDamping: 40, // 1/s: = 2 * sqrt(stiffness), critically damped
  suspensionMaxAccel: 60, // m/s² cap so a buried wheel ray cannot launch the car
  groundRaySlack: 0.05, // m beyond suspension travel that still counts as "on ground"
  /** Rate at which the car's up vector is rotated onto the surface normal while grounded. */
  alignGain: 14, // 1/s

  /**
   * RL: sticky force. RocketSim applies stickyForceScale * gravity toward the surface while
   * wheels touch, with the scale rising under throttle and speed. We cap the suspension's pull
   * toward the surface at this value. 325 uu/s² is the widely cited community figure; we have
   * not verified it against RocketSim's scale curve. Being below gravity (650) is what makes
   * cars fall off the ceiling but stick to walls.
   */
  stickyAccel: 325 * UU,

  /**
   * Contact materials. RL wants ball-arena restitution 0.6, car-arena 0.3 and car-ball 0.0, with
   * car-ball friction 2.0. Rapier combines per pair with one rule chosen by priority
   * (Max > Multiply > Min > Average), and no assignment reproduces all three. We use
   * ball 0.6 (Multiply), arena 1.0 (Min), car 0.3 (Min), which gives 0.6 / 0.3 / 0.18.
   * Friction uses Min everywhere: ball-arena 0.35, car-arena 0.3, car-ball 0.3 (RL: 2.0).
   */
  carBallRestitutionActual: 0.18,
  carBallFrictionActual: 0.3,

  /**
   * RL: lateral grip comes from LAT_FRICTION_CURVE (slip ratio 0 -> 1.0, 1 -> 0.2) through
   * Bullet's wheel friction solver, and handbrake multiplies lateral friction by 0.1. We
   * exponentially decay the lateral velocity component instead.
   */
  lateralGripNormal: 12, // 1/s
  lateralGripPowerslide: 2.5, // 1/s
  /**
   * RL: powerslide changes the steer angle curve and the friction factors; extra rotation
   * emerges from the wheels sliding. We just scale yaw rate.
   */
  powerslideYawGain: 1.6,

  // ------------------------------------------------------------------------------
  // Flip torque
  // ------------------------------------------------------------------------------
  /**
   * RL applies torque FLIP_TORQUE * CAR_TORQUE_SCALE through the inverse inertia tensor.
   * We apply it directly as angular acceleration and let the 5.5 rad/s cap limit it, so
   * flip rotation speed is only approximately right.
   */
  flipAngularAccelFrontBack: CAR.flipTorqueY * CAR.torqueScale, // ≈ 21.5 rad/s²
  flipAngularAccelSide: CAR.flipTorqueX * CAR.torqueScale, // ≈ 24.9 rad/s²

  // ------------------------------------------------------------------------------
  // Autoflip / autoroll detection
  // ------------------------------------------------------------------------------
  /** RL uses Bullet contact manifolds for "world contact". We cast one short ray along -worldUp. */
  roofContactRayExtra: 0.12, // m beyond the hitbox half-height
  /** RL: autoroll torque 80 through the inertia tensor. We use a proportional alignment gain. */
  autorollAlignGain: 6, // 1/s

  // ------------------------------------------------------------------------------
  // Arena shape
  // ------------------------------------------------------------------------------
  /**
   * RL's arena is a hand-modelled collision mesh (RocketSim loads it from the game files, which
   * we cannot distribute). Community measurements put the floor-to-wall ramp at roughly 256 uu
   * radius and "not perfectly circular"; the wall-to-ceiling curve is similar. We build
   * quarter-circle ramps out of flat segments, flat 45° corner walls on the verified
   * |x|+|y| = 8064 plane, and a rectangular goal box with square posts.
   */
  rampRadiusFloor: 256 * UU,
  rampRadiusCeiling: 256 * UU,
  rampSegments: 6,
  wallThickness: 1.0, // m, for the box colliders behind the goal mouths

  // ------------------------------------------------------------------------------
  // Match flow
  // ------------------------------------------------------------------------------
  goalResetDelay: 2.0, // s. RL shows a replay; there is no physics value to match.
  /** Height to drop the car from at kickoff so the hover model settles. */
  spawnDropHeight: 0.05, // m above rest height
};
