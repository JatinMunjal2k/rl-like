# RL-like

A browser car-soccer game in the spirit of Rocket League. Current scope: free play, one car, one ball, gamepad or keyboard.

## Run

```bash
npm install
npm run dev
```

Open the printed URL (default http://127.0.0.1:5173). Press any button on a connected controller so the browser exposes it.

## Controls

| Action | Gamepad (standard mapping) | Keyboard |
| --- | --- | --- |
| Throttle / reverse | RT / LT | W / S |
| Steer, air yaw | Left stick | A / D |
| Air pitch | Left stick | W / S |
| Jump, double jump, dodge | A | Space |
| Boost | B | Left Shift |
| Powerslide / free air roll | X | Right Shift |
| Air roll left / right | LB / RB | Q / E |
| Toggle ball cam | Y | C |
| Reset match | Start or Back | R |

Landed on your roof? Press jump. That is Rocket League's autoflip and it is implemented the same way. Holding throttle while on your side rolls you onto your wheels (autoroll).

## Architecture

```
src/
  sim/        Deterministic fixed-tick simulation (120 Hz). No DOM, no rendering.
    rl.ts          VERIFIED Rocket League values, in unreal units, with sources
    tuning.ts      Every approximation or invented value, with what RL does instead
    arena.ts       Analytic arena mesh: ramps, corners, goal mouths, goal boxes
    car.ts         Octane hitbox on a Rapier body with RL's jump/flip/air/boost rules
    game.ts        World, ball, car-ball extra impulse, goal detection, snapshots
  input/      Gamepad + keyboard -> CarInput
  render/     three.js scene, chase camera. Consumes snapshots only. Kept deliberately cheap.
  main.ts     Frame loop: fixed-step accumulator, interpolated rendering
```

The simulation only depends on Rapier and three's math classes, so it can run headless in Node. That is the seam for a future authoritative multiplayer server: the server runs `Game.step` with each player's `CarInput`, clients predict locally and reconcile from `Snapshot`s.

## Constants: real vs approximate

`src/sim/rl.ts` holds only values taken from RocketSim's `RLConst.h` / `CarConfig.cpp` or the RLBot wiki, each tagged with its source. `src/sim/tuning.ts` holds everything else and explains what the real game does instead. The main approximations today:

- Car is a filled Octane hitbox with its centre of mass at the hitbox centre; RL's body origin is at axle height, 13.9 uu behind the hitbox centre.
- Ground contact is a hover controller holding the hitbox at RL's rest height, not Bullet's raycast vehicle with springs and wheel friction curves.
- Lateral grip and powerslide are exponential decay and a yaw multiplier instead of RL's wheel slip curves.
- Flip torque is applied as angular acceleration and capped at 5.5 rad/s rather than pushed through the inertia tensor.
- Arena ramps are quarter circles of 256 uu built from flat segments; RL's mesh is hand-modelled and not distributable.
- Car-ball restitution ends up 0.18 and friction 0.3 (RL: 0.0 and 2.0) because Rapier only offers one combine rule per pair.

## Physics still missing compared to Rocket League

Ordered roughly by how much they change the feel:

1. Raycast-vehicle suspension and wheel friction curves (landing bounce, half-flips, wall transitions).
2. Boost pads: 34 pads with the verified positions in `rl.ts`, pickup radii and cooldowns; boost is currently infinite.
3. Flip cancel (pitching against a flip after 0.41 s), and true flip rotation speed.
4. Ball on car: RL's car-ball friction of 2.0 is what makes dribbling and flicks work.
5. Car-car collisions, bumps and demolitions (curves are in RocketSim's `RLConst.h`).
6. Kickoff countdown, five kickoff spawns, respawn positions.
7. Exact arena mesh: curved corners between wall and ceiling, rounded goal posts, goal-mouth lip.
8. Powerslide steer-angle curve and the 5/s rise, 2/s fall of the handbrake value.
9. Supersonic has no gameplay effect yet beyond a flag (in RL it matters for demos).
10. Ultimately: RocketSim itself compiled to WebAssembly replaces `sim/` for tick-exact physics.
