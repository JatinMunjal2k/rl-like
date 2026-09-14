/**
 * APPROXIMATIONS AND INVENTED VALUES.
 *
 * Nothing in this file is a verified Rocket League number. Each entry says what the real game
 * does instead and why we approximate. When a value here gets replaced by the real mechanism,
 * move the mechanism's constants to ./rl.ts and delete the entry.
 */
import { UU } from './rl';

export const TUNING = {
  // ------------------------------------------------------------------------------
  // Car body model
  // ------------------------------------------------------------------------------
  /**
   * We simulate the car as a single filled Octane hitbox whose centre of mass IS the hitbox
   * centre, with the inertia of a uniform box of that size and RL's 180 mass. RL's rigid body
   * origin sits 13.9 uu behind and 20.8 uu below the hitbox centre (OCTANE.hitboxOffset), and
   * RocketSim reports that these hitbox extents reproduce RL's inertia tensor, so rotations
   * happen about a slightly different point than in RL.
   */
  bodyAtHitboxCentre: true,

  // ------------------------------------------------------------------------------
  // Wheels
  // ------------------------------------------------------------------------------
  /**
   * The wheel model (suspension springs, friction curves, sticky force, steer curves) now
   * follows RocketSim's btVehicleRL. Two things are still ours:
   *  - Bullet's resolveSingleBilateral uses the full solver Jacobian between chassis and
   *    ground; we compute it analytically for a static ground (1/m + (r×a)·I⁻¹(r×a)).
   *  - RL's "extra pushback" when a wheel ray penetrates static geometry is omitted; Rapier's
   *    hitbox collision handles deep penetration instead.
   */

  // ------------------------------------------------------------------------------
  // Recovery
  // ------------------------------------------------------------------------------
  /**
   * RL's autoroll applies torque 80 through the inertia tensor toward the ground frame. We use
   * a proportional alignment of the car's up vector toward the surface normal.
   */
  autorollAlignGain: 6, // 1/s

  // ------------------------------------------------------------------------------
  // Contact materials
  // ------------------------------------------------------------------------------
  /**
   * RL wants ball-arena restitution 0.6, car-arena 0.3 and car-ball 0.0. Rapier combines per pair
   * with one rule chosen by priority (Max > Multiply > Min > Average) and no assignment
   * reproduces all three. We use ball 0.6 (Multiply), arena 1.0 (Min), car 0.3 (Min), which
   * gives 0.6 / 0.3 / 0.18. Friction is exact for the pairs that matter:
   * ball 2.0 (Min), arena 0.35 (Min), car 0.3 (Max) -> ball-arena 0.35, car-ball 2.0, car-arena 0.35 (RL 0.3).
   */
  carBallRestitutionActual: 0.18,
  carArenaFrictionActual: 0.35,

  // ------------------------------------------------------------------------------
  // Arena shape
  // ------------------------------------------------------------------------------
  /**
   * RL's arena is a hand-modelled collision mesh (RocketSim loads it from the game files, which
   * we cannot distribute) and nobody publishes its curve radii. Community measurements put the
   * floor-to-wall ramp at roughly 256 uu and "not perfectly circular", with the wall-to-ceiling
   * transition starting about 200 uu below the ceiling. We build quarter-circle ramps out of flat
   * segments, flat 45° corner walls on the verified |x|+|y| = 8064 plane, and a rectangular goal
   * box with square posts. Unknown and therefore omitted: the blend between corner walls and
   * side/back walls, and the rounding of the goal posts and crossbar.
   */
  rampRadiusFloor: 256 * UU,
  rampRadiusCeiling: 200 * UU,
  rampSegments: 6,
  wallThickness: 1.0, // m, for the box colliders behind the goal mouths

  // ------------------------------------------------------------------------------
  // Match flow
  // ------------------------------------------------------------------------------
  goalResetDelay: 2.0, // s. RL shows a replay; there is no physics value to match.
  /** Height to drop the car from at kickoff so the suspension settles. */
  spawnDropHeight: 0.02, // m above rest height
};
