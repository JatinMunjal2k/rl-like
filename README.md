# RL-like

A browser car-soccer game in the spirit of Rocket League. Current scope: free play, one car, one ball, gamepad or keyboard, rebindable controls.

## Run

```bash
npm install
npm run dev
```

Open the printed URL (default http://127.0.0.1:5173). Press any button on a connected controller so the browser exposes it. The game starts on a menu with **Free Play** and **Settings** (control bindings). Esc or Start opens the menu during play, which pauses the match.

## Default controls

| Action | Gamepad (standard mapping) | Keyboard |
| --- | --- | --- |
| Throttle / reverse | RT / LT | W / S |
| Steer, air yaw | Left stick | A / D |
| Air pitch | Left stick | W / S |
| Jump, double jump, dodge | A | Space |
| Boost | B | Left Shift |
| Powerslide | X | Right Shift |
| Air roll (free): stick X axis rolls | X | Right Shift |
| Air roll left / right | LB / RB | Q / E |
| Toggle ball cam | Y | C |
| Reset match | Back | R |
| Menu | Start | Esc |

Everything except the steering axis can be rebound in Settings. Bindings persist in the browser.

Landed on your roof? Press jump (RL's autoflip). On your side, hold throttle (autoroll). Flip cancel works: pitch against a flip while it is running.

## Architecture

```
src/
  sim/        Deterministic fixed-tick simulation (120 Hz). No DOM, no rendering.
    rl.ts          VERIFIED Rocket League values, in unreal units, with sources
    tuning.ts      Every approximation or invented value, with what RL does instead
    arena.ts       Analytic arena mesh: ramps, corners, goal mouths, goal boxes, backstops
    car.ts         Octane on a Rapier body driven like RocketSim drives Bullet (see below)
    game.ts        World, ball, car-ball extra impulse, goal detection, snapshots
  input/      Gamepad + keyboard -> CarInput, rebindable actions
  render/     three.js scene (kept cheap), chase camera. Consumes snapshots only.
  ui/         Menu and controls settings
  main.ts     Frame loop: fixed-step accumulator, interpolated rendering, pause on menu
```

The simulation only depends on Rapier and three's math classes, so it can run headless in Node. That is the seam for a future authoritative multiplayer server: the server runs `Game.step` with each player's `CarInput`, clients predict locally and reconcile from `Snapshot`s.

## Car model

The car follows RocketSim's reverse-engineered vehicle:

- Rigid body origin at RL's car origin (axle height) with the Octane hitbox offset 13.9 uu forward and 20.8 uu up, mass 180, box inertia.
- Four wheel rays from the real hardpoints. Each contacting wheel applies a Bullet raycast-vehicle spring/damper impulse (stiffness 500, damping 25/40, force scales 35.75 front / 54.27 rear, 12 uu travel, never pulling).
- Wheel friction as impulses: Bullet's bilateral side constraint (0.2 damping through the inertia Jacobian) times RL's lateral friction curve; engine force 400 uu/s² per wheel with the speed-torque curve; brake 875 uu/s² per wheel with RocketSim's rolling-friction constant; handbrake blends the steer-angle curve and scales friction; no-throttle "non-sticky" factor; impulses applied at chassis height like RocketSim.
- Front wheels steer by RL's steer-angle-from-speed curve. Turn rates come out at 2.16 rad/s at 14 m/s and 1.79 at 23 m/s against RL's measured 2.2 and 2.02.
- Sticky force: 0.5 g into the surface, plus (1 - |up|) g when throttling or moving, so walls hold and the ceiling does not.
- Jump, double jump, dodge impulses with speed scaling, flip torque with flip cancel, vertical damping window, pitch lock, air control torque and damping, autoflip, autoroll, boost ground/air and minimum time, supersonic tracking, ball speed and spin caps, car-ball extra impulse.

## Constants: real vs approximate

`src/sim/rl.ts` holds only values taken from RocketSim's source or the RLBot wiki, each tagged with its source. `src/sim/tuning.ts` holds everything else and explains what the real game does instead. Remaining approximations:

- Wheel bilateral Jacobian computed analytically for a static ground (Bullet's does the same for our case, but this is our derivation).
- RocketSim's "extra pushback" when a wheel ray sinks into geometry is omitted; Rapier's hitbox collision covers it.
- Autoroll torque is a proportional alignment instead of RL's torque through the inertia tensor.
- Car-ball restitution ends at 0.18 (RL 0.0); friction is exact (2.0).
- Arena ramps are quarter circles of 256 uu (floor) and 200 uu (ceiling) built from flat segments; RL's mesh is hand-modelled and not distributable. Unknown and omitted: the blend between corner walls and side/back walls, rounded goal posts and crossbar.

## Settings

Settings → Controls (bindings), Camera (FOV, distance, height, angle, stiffness with RL's ranges and defaults) and Gameplay (steering sensitivity, aerial sensitivity, controller deadzone, dodge deadzone). The menu works with mouse, keyboard (arrows, Enter, Backspace) and gamepad (D-pad or stick, A, B). Everything persists in the browser.

## Match flow and HUD

- 34 boost pads at RL's positions with RL's pickup volumes (cylinder 208/144 uu radius, 95 uu tall, or box 160/120 uu, 64 uu tall), 100 / 12 boost, 10 s / 4 s cooldown. Free play currently uses infinite boost; pads still light up and recharge.
- Reset cycles through RL's five blue spawn points in a shuffled order that changes every cycle.
- On a goal the ball disappears for 2 s while play continues; then car and ball reset to kickoff. The banner shows the goal speed in km/h and uu/s.
- Wheel "extra pushback" (RocketSim): past 2.5 uu of compression a wheel ray acts as a rigid contact, so hard or tilted landings stop on the wheels instead of sinking the hitbox into the floor and being fired back up by the springs.
- HUD: score, FPS (top right), ball-cam indicator and controller status (bottom left), speed in uu/s and an RL-style boost gauge (bottom right). Speed turns red, larger and pulsing at the 2300 uu/s cap; the boost flame goes white when supersonic.
- The menu shows over black with the game not rendered.

## Engine note: why flips come round a full turn

RocketSim applies the flip torque before the physics step and clamps angular speed to 5.5 rad/s only after it, so each step's rotation integrates at 5.5 plus one tick of torque (about 7.7 rad/s for side flips, 7.4 for front flips). Over the 0.65 s torque phase that is ~285°, and the damped coast brings a flip to ~350° by landing. We replicate the order exactly: caps live in `Car.postStep`. Clamping before the step gave 270° flips that landed on their side.

## Engine note: gyroscopic precession

Rapier integrates gyroscopic precession for the car's box inertia, so any rotation about a non-principal axis (every diagonal flip) would tumble and drift the heading. Bullet, and therefore Rocket League, does not. After each physics step, if nothing touched the car, its pre-step angular velocity is restored (`Car.postStep`).

## Physics still missing compared to Rocket League

1. Car-car bumps and demolitions.
2. Kickoff countdown and respawn positions.
3. Exact arena mesh details above.
4. Supersonic has no gameplay effect beyond the indicator (in RL it matters for demos).
5. RocketSim itself compiled to WebAssembly would replace `sim/` for tick-exact physics.
