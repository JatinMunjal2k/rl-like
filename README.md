# RL-like

A browser car-soccer game in the spirit of Rocket League: free play, or online matches with friends hosted straight from one player's browser tab. Gamepad or keyboard, rebindable controls.

Play it at https://jatinmunjal2k.github.io/rl-like/ (deployed from `main` by GitHub Actions).

## Run locally

```bash
npm install
npm run dev
```

Open the printed URL (default http://127.0.0.1:5173). Press any button on a connected controller so the browser exposes it. The game starts on a menu with **Free Play**, **Multiplayer** and **Settings**. Esc or Start opens the menu during play; free play pauses, an online match keeps running.

## Multiplayer

One player picks **Multiplayer → Host a room** and gets a five-letter code. Friends open the same site, enter the code and **Join**. The host's lobby shows both teams (switch with one button), the match length, and **Start match**. Up to eight players; people can join or leave mid-match.

How it works:

- **The host's tab is the server.** It runs the authoritative `Game` at 120 Hz, applies every player's input for the tick it was stamped with (repeating the last one when a packet is late) and sends the complete game state to each client 60 times a second (about 300 bytes with four cars).
- **Transport is WebRTC via PeerJS.** PeerJS's free public broker only does the introduction; game traffic flows peer to peer. On top of PeerJS's reliable channel a second data channel is opened unordered with no retransmits, so a lost packet never delays the ones behind it; if that channel cannot be set up, packets fall back to the reliable one. PeerJS's default STUN/TURN servers get through most home NATs.
- **Clients predict.** Each client runs its own `Game` a few ticks ahead of the host, so its car and the ball react instantly. Every snapshot is compared with what the client predicted for that tick; when they differ (someone else touched the ball, an input arrived late) the client rewinds to the snapshot and replays its unacknowledged inputs. Because Rapier is deterministic and the whole state is serialised, a replay of untouched play is bit-identical, so most snapshots need no replay at all. Corrections are folded into a visual offset that fades over about a tenth of a second instead of snapping.
- **Other cars are shown from snapshots**, interpolated a few ticks in the past (extrapolated briefly if a packet is lost), with the player's name floating above.
- **Clock sync.** Each snapshot tells the client how far ahead of the host's simulation its inputs are arriving; the client speeds up or slows its simulation slightly to keep about three ticks of margin, jumps only after the lead has been badly off for half a second, and catches up locally when a late frame let the host get ahead.
- **Background tabs.** Browsers throttle a hidden tab's frame loop to about once a second, which would freeze a hosted match. A tiny Web Worker (whose timers are not throttled) ticks the network session while the tab is hidden, so the host can tab out without stopping the game. The player's own car coasts meanwhile.
- **Match flow online:** three-second kickoff countdown with cars frozen, RocketSim's kickoff placement (blue takes shuffled spawn *i*, orange the mirror), real boost with pads, a match clock (unlimited, 3, 5 or 10 minutes), overtime with a fresh kickoff on a tie, and a result banner. Dodge deadzone is a player setting, so each client sends theirs and the host simulates that player's car with it.

Known limits: no bumps or demolitions yet (cars collide as rigid bodies); a client cannot reset the match; if the host closes the tab the room ends; the PeerJS public broker occasionally refuses connections, in which case hosting again gets a new code.

## Deploying

`.github/workflows/deploy.yml` builds `dist/` with Vite and publishes it to GitHub Pages on every push to `main` (Pages source set to *GitHub Actions*). Vite's `base: './'` keeps the site working under the `/rl-like/` path. Nothing else to run: the multiplayer needs no server of ours.

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

The simulation only depends on Rapier and three's math classes, so it can run headless in Node. That is the seam the multiplayer uses: the host runs `Game.step` with every player's `CarInput`, clients predict locally and reconcile from serialised game states (`Game.serialize` / `Game.restore`).

```
src/
  net/
    protocol.ts    Control messages (JSON) and binary packets: inputs, snapshots, ping
    transport.ts   PeerJS signalling, one reliable + one unreliable data channel per peer
    session.ts     Session interface shared by free play, host and client
    host.ts        Lobby, input buffering per client, authoritative stepping, snapshot broadcast
    client.ts      Prediction, reconciliation, remote-car interpolation, visual smoothing
  sim/state.ts     Byte writer/reader, input quantisation, seeded RNG
```

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
- Arena shape is fitted to measurements of RL's real collision mesh (parsed from RocketSim `.cmf` files, not redistributed): side-wall and corner floor ramps r = 256 uu, back-wall floor ramps r = 160, wall-to-ceiling arcs r = 550, corner walls on |x|+|y| = 8064 blended into the back wall (r ≈ 800) and side wall (r ≈ 680).
- The goal is a tube, not a box: netting at x = ±896, a quarter-pipe back (r = 256, centred 624 uu behind the mouth) that curls forward past vertical to 477 high, a roof sloping up to 640 at 224 uu behind the crossbar, then the flat lintel to the mouth. Drive in fast and you ride up the back, along the roof upside down, and out through the mouth, as in RL. Still square: the ~96 uu fillets where the roof meets the netting and where posts meet the back-wall ramp.

## Visuals and sound

Reference footage: a pro's free-play session (Zen, https://www.youtube.com/watch?v=2goJD60z9Zs), sampled frame by frame for the pad pickups, ball streak, boost trails, glass walls and camera framing.

- Boost pads are RL-style pickups: the six big pads float a glowing orb about a metre up on a lit ring, the small pads a bright dot; a pad on cooldown loses its orb and its ring goes dark. All 34 are four instanced meshes plus six glow sprites (ten draw calls).
- The ball has a hexagon-panel texture, a soft additive glow, a blob shadow on the floor that fades with height, and a white streak (camera-facing ribbon) once it moves faster than about 14 m/s. Cars have a blob shadow and a short team-coloured boost trail behind the flame.
- Goals burst: a flash, an expanding ring and a spray of points in the scoring team's colour at the ball's last position.
- Walls are opaque, single-sided (normals face inward) and textured as hexagon-mesh glass over a baked stadium: three seating tiers of soft speckle, walkway rails, roof struts, and the light rail at goal height. A gradient night-sky dome replaces the flat background.
- The floor is one static 2048 px texture: turf stripes, boundary, goal lines, centre circle, goal boxes and arcs, boost pad rings. Drawn once at startup, zero per-frame cost.
- The car is a Fennec-style body of a dozen boxes on the Octane hitbox, with four wheels at RL's hardpoints that spin with forward speed and steer with RL's steer-angle curve.
- All sound is synthesised in WebAudio (no files). Continuous: engine (pitch and brightness follow speed and throttle), tyre roll on the floor, boost roar with an ignition burst, tyre skid while powersliding or sliding sideways, wind near and at supersonic. One-shots: jump, double-jump and dodge whooshes (band-swept noise), landing thud scaled by impact, big/small pad chimes, ball "pock" with a low thud on hard hits, arena bounce, wall bump, kickoff beeps and "go", goal horn with an explosion. Volume is in Settings → Gameplay.

## Settings

Settings → Controls (bindings), Camera (FOV, distance, height, angle, stiffness with RL's ranges; defaults are the common pro setup 110 / 270 / 100 / -3 / 0.45) and Gameplay (steering sensitivity, aerial sensitivity, controller deadzone, dodge deadzone, sound volume). Every slider has a description. The menu works with mouse, keyboard (arrows, Enter, Backspace) and gamepad (D-pad or stick, A, B). Everything persists in the browser.

The camera is a measured copy of car-soccer.com's camera kernel, which implements Rocket League's rules. That kernel is compiled WebAssembly, so it was probed as a black box: the same car and ball placements were fed to it and to `FollowCamera`, and every probe (dozens, covering kickoff, high balls at several heights and distances, each camera setting varied in isolation, speed, supersonic, walls, slopes, the ceiling and the car pitched or rolled in the air) matches to within 0.1° of pitch and a few uu of position. The rules it encodes:

- A pivot sits `height` above the car. The camera is pulled `distance` back along the smoothed view direction, so the −3° `angle` also raises it by 14 uu. The arm grows with speed by (1 − stiffness) × speed / 20 uu, which is all stiffness does. The camera never drops below 10 uu. FOV is horizontal and widens by 10° while supersonic.
- Ball cam: yaw points at the ball; the pivot rises 0.9 uu per degree of the ball's elevation; pitch blends from `angle` toward the ball's elevation with a weight that ramps from 0 at 22° to 0.8 at 44° and never exceeds 0.8. A ball straight overhead is followed only 80% of the way, so the car leaves the frame, as in RL. First-order lag of 8.6/s.
- Car cam: yaw follows the nose heading, held through flips (a heading jump past 90° is ignored) and near-vertical noses. In the air the pitch is just `angle` and the roll is level, so air rolls and flips leave the view alone. On a surface the pivot rides the car's up, the pitch follows about 75% of the nose pitch and the roll a tenth of the car's roll. First-order lag of 24.7/s.

Speeds show in km/h (1 uu/s = 0.036 km/h; 2300 uu/s is 83 km/h).

Car-ball contact follows RocketSim's `_OnHit`: restitution 0, the extra impulse computed from pre-collision velocities and positions, applied at most every other tick and only while the ball is still approaching. A 2000 uu/s flat hit on a resting ball leaves at about 3050 uu/s and 16°, peaking around 7 m.

## Physics audit against RocketSim

car-soccer.com ships RocketSim compiled to WebAssembly. Driving that build headlessly with the same inputs as our `Game` gives a direct comparison (all values uu, uu/s, rad/s at 120 Hz):

| Test | RocketSim | RL-like |
| --- | --- | --- |
| Rest pose (origin z, pitch) | 17.03, −0.55° | 17.02, −0.55° |
| Held jump height / tap jump / double jump | 214.8 / 72.1 / 444.6 | 214.8 / 72.1 / 444.4 |
| Held jump z every 1/12 s | 26.1 57.5 92.4 123.4 149.9 171.8 189.2 202.2 210.6 214.5 | identical to 0.1 |
| Forward dodge speed gain | 500 | 500 |
| 0 → 2200 with boost, 0 → 2290 | 1.583 s, 1.675 s | 1.583 s, 1.675 s |
| Throttle-only top speed | 1410.1 | 1410.2 |
| Throttle acceleration, brake, coast traces | | match within 1% |
| Steady full-throttle turn: speed, yaw rate, radius | 1227, 2.348, 523 | 1228, 2.348, 523 |
| Turn curve from rest (12 samples) | | within 0.5% |
| Powerslide yaw rate build-up (0.125 s steps) | 2.25 2.82 3.07 3.25 3.33 3.56 | 2.31 2.83 3.08 3.25 3.33 3.65 |
| Side flip: z and up.z every 0.1 s, landing tick | landed 137 | landed 138, values within 2 uu / 0.03 |
| Ball bounce apex ratio | 0.44 | 0.44 |
| Boosted kickoff hit: ball speed, elevation, apex | 3014, 18.4°, 797 | 3039, 17.0°, 705 |

Three of these were fixes found by the comparison: a 25th tick of jump acceleration from float64 tick accumulation, the ball's collision radius (91.25, not 92.75), and the suspension rest lengths (RocketSim's car sits 1.9 uu higher and 0.55° nose down than the raw config values give, which was also the whole source of a 10% turn-radius error). Remaining known gaps: the kickoff hit leaves about 1.5° lower (Rapier's box-sphere contact normal vs Bullet's margin-rounded box), and RocketSim applies steering and braking to the wheels one tick later than we do.

## Match flow and HUD

- 34 boost pads at RL's positions with RL's pickup volumes (cylinder 208/144 uu radius, 95 uu tall, or box 160/120 uu, 64 uu tall), 100 / 12 boost, 10 s / 4 s cooldown. Free play currently uses infinite boost; pads still light up and recharge.
- Reset cycles through RL's five spawn points in a shuffled order that changes every cycle (RocketSim's kickoff placement with more cars: blue car *i* takes spawn *i* of the shuffle, orange the mirror image).
- On a goal the ball disappears for 2 s while play continues; then cars and ball reset to kickoff. The banner shows the scorer and the goal speed in km/h.
- Wheel "extra pushback" (RocketSim): past 2.5 uu of compression a wheel ray acts as a rigid contact, so hard or tilted landings stop on the wheels instead of sinking the hitbox into the floor and being fired back up by the springs.
- HUD: score, FPS (top right), ball-cam indicator and controller status (bottom left), speed in uu/s and an RL-style boost gauge (bottom right). Speed turns red, larger and pulsing at the 2300 uu/s cap; the boost flame goes white when supersonic.
- The menu shows over black with the game not rendered.

## Engine note: why flips come round a full turn

RocketSim applies the flip torque before the physics step and clamps angular speed to 5.5 rad/s only after it, so each step's rotation integrates at 5.5 plus one tick of torque (about 7.7 rad/s for side flips, 7.4 for front flips). Over the 0.65 s torque phase that is ~285°, and the damped coast brings a flip to ~350° by landing. We replicate the order exactly: caps live in `Car.postStep`. Clamping before the step gave 270° flips that landed on their side.

## Engine note: gyroscopic precession

Rapier integrates gyroscopic precession for the car's box inertia, so any rotation about a non-principal axis (every diagonal flip) would tumble and drift the heading. Bullet, and therefore Rocket League, does not. After each physics step, if nothing touched the car, its pre-step angular velocity is restored (`Car.postStep`).

## Physics still missing compared to Rocket League

1. Car-car bumps and demolitions (cars do collide as rigid bodies).
2. Respawn positions for more than five cars per team.
3. Exact arena mesh details above.
4. Supersonic has no gameplay effect beyond the indicator (in RL it matters for demos).
5. RocketSim itself compiled to WebAssembly would replace `sim/` for tick-exact physics.
