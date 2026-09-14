import type { CarInput, FrameInput } from './types';

const DEADZONE = 0.12;

/** Standard gamepad mapping indices (https://w3c.github.io/gamepad/#remapping). */
const BTN = {
  A: 0, // jump
  B: 1, // boost
  X: 2, // powerslide / air roll
  Y: 3, // toggle ball cam
  LB: 4, // air roll left
  RB: 5, // air roll right
  LT: 6, // reverse
  RT: 7, // throttle
  BACK: 8, // reset
  START: 9, // reset
};

function deadzone(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  const scaled = (a - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * Math.min(1, scaled);
}

function pressed(gp: Gamepad, i: number): boolean {
  const b = gp.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
}

function value(gp: Gamepad, i: number): number {
  const b = gp.buttons[i];
  if (!b) return 0;
  // Triggers report analog `value`; some pads only report `pressed`.
  return b.value > 0 ? b.value : b.pressed ? 1 : 0;
}

/**
 * Reads keyboard and the first connected gamepad every frame and produces one
 * CarInput. Gamepad wins over keyboard when it is connected and any control is active.
 */
export class InputManager {
  private keys = new Set<string>();
  private gamepadIndex: number | null = null;
  private prevReset = false;
  private prevToggleCam = false;

  onControllerChange: ((name: string | null) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      // Stop the page from scrolling on Space/arrows.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    window.addEventListener('gamepadconnected', (e) => {
      if (this.gamepadIndex === null) this.gamepadIndex = e.gamepad.index;
      this.onControllerChange?.(this.currentGamepad()?.id ?? null);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
      this.onControllerChange?.(this.currentGamepad()?.id ?? null);
    });
  }

  private currentGamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex !== null) {
      const gp = pads[this.gamepadIndex];
      if (gp && gp.connected) return gp;
      this.gamepadIndex = null;
    }
    // Chrome only exposes a pad after the user presses a button on it, and does not
    // always fire `gamepadconnected` for pads that were already plugged in. Poll.
    for (const gp of pads) {
      if (gp && gp.connected) {
        this.gamepadIndex = gp.index;
        this.onControllerChange?.(gp.id);
        return gp;
      }
    }
    return null;
  }

  poll(): FrameInput {
    const gp = this.currentGamepad();
    const kb = this.readKeyboard();
    const pad = gp ? this.readGamepad(gp) : null;

    const car: CarInput = pad && isActive(pad) ? pad : kb;

    const reset = this.keys.has('KeyR') || (!!gp && (pressed(gp, BTN.BACK) || pressed(gp, BTN.START)));
    const toggleCam = this.keys.has('KeyC') || (!!gp && pressed(gp, BTN.Y));

    const frame: FrameInput = {
      car,
      resetPressed: reset && !this.prevReset,
      toggleCameraPressed: toggleCam && !this.prevToggleCam,
      controllerName: gp?.id ?? null,
    };
    this.prevReset = reset;
    this.prevToggleCam = toggleCam;
    return frame;
  }

  private readGamepad(gp: Gamepad): CarInput {
    const lx = deadzone(gp.axes[0] ?? 0);
    const ly = deadzone(gp.axes[1] ?? 0);
    const handbrake = pressed(gp, BTN.X);
    const rollButtons = (pressed(gp, BTN.RB) ? 1 : 0) - (pressed(gp, BTN.LB) ? 1 : 0);
    return {
      throttle: clamp(value(gp, BTN.RT) - value(gp, BTN.LT)),
      steer: lx,
      pitch: ly, // stick back (positive) = nose up
      yaw: handbrake ? 0 : lx,
      roll: handbrake ? lx : rollButtons,
      jump: pressed(gp, BTN.A),
      boost: pressed(gp, BTN.B),
      handbrake,
    };
  }

  private readKeyboard(): CarInput {
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const handbrake = k.has('ShiftRight') || k.has('ControlLeft');
    const roll = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    return {
      throttle: fwd,
      steer: side,
      pitch: -fwd, // W pitches nose down like pushing the stick forward
      yaw: handbrake ? 0 : side,
      roll: handbrake ? side : roll,
      jump: k.has('Space'),
      boost: k.has('ShiftLeft'),
      handbrake,
    };
  }
}

function isActive(i: CarInput): boolean {
  return (
    i.throttle !== 0 || i.steer !== 0 || i.pitch !== 0 || i.roll !== 0 || i.jump || i.boost || i.handbrake
  );
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
