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

## Architecture

```
src/
  sim/        Deterministic fixed-tick simulation (120 Hz). No DOM, no rendering.
    constants.ts   Rocket League dimensions and handling values, 1 uu = 1 cm
    car.ts         Arcade car controller driving a Rapier dynamic body
    game.ts        Arena colliders, ball, goal detection, snapshots
  input/      Gamepad + keyboard -> CarInput
  render/     three.js scene, chase camera. Consumes snapshots only.
  main.ts     Frame loop: fixed-step accumulator, interpolated rendering
```

The simulation only depends on Rapier and three's math classes, so it can run headless in Node. That is the seam for a future authoritative multiplayer server: the server runs `Game.step` with each player's `CarInput`, clients predict locally and reconcile from `Snapshot`s.

Physics is Rapier (WASM) with a custom car model. Swapping in RocketSim compiled to WASM later would only touch `sim/`.
