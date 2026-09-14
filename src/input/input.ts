import type { CarInput, FrameInput } from './types';

const DEADZONE = 0.12;
const STORAGE_KEY = 'rl-like.bindings.v1';

/** Rebindable actions. Steering / pitch axes are fixed (left stick, WASD / arrows). */
export const ACTIONS = [
  'throttle',
  'reverse',
  'jump',
  'boost',
  'handbrake',
  'airRollLeft',
  'airRollRight',
  'ballCam',
  'reset',
  'menu',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  throttle: 'Throttle',
  reverse: 'Reverse',
  jump: 'Jump / dodge',
  boost: 'Boost',
  handbrake: 'Powerslide / air roll',
  airRollLeft: 'Air roll left',
  airRollRight: 'Air roll right',
  ballCam: 'Toggle ball cam',
  reset: 'Reset match',
  menu: 'Menu',
};

export interface Bindings {
  /** Standard-mapping gamepad button index per action. */
  gamepad: Record<Action, number>;
  /** KeyboardEvent.code per action. */
  keyboard: Record<Action, string>;
}

export const DEFAULT_BINDINGS: Bindings = {
  gamepad: {
    throttle: 7, // RT
    reverse: 6, // LT
    jump: 0, // A
    boost: 1, // B
    handbrake: 2, // X
    airRollLeft: 4, // LB
    airRollRight: 5, // RB
    ballCam: 3, // Y
    reset: 8, // Back / Share
    menu: 9, // Start / Options
  },
  keyboard: {
    throttle: 'KeyW',
    reverse: 'KeyS',
    jump: 'Space',
    boost: 'ShiftLeft',
    handbrake: 'ShiftRight',
    airRollLeft: 'KeyQ',
    airRollRight: 'KeyE',
    ballCam: 'KeyC',
    reset: 'KeyR',
    menu: 'Escape',
  },
};

const GAMEPAD_BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Home'];

export function gamepadButtonName(index: number): string {
  return GAMEPAD_BUTTON_NAMES[index] ?? `Button ${index}`;
}

export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace('Left', ' L').replace('Right', ' R').replace('Arrow', '');
}

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_BINDINGS);
    const parsed = JSON.parse(raw) as Partial<Bindings>;
    return {
      gamepad: { ...DEFAULT_BINDINGS.gamepad, ...(parsed.gamepad ?? {}) },
      keyboard: { ...DEFAULT_BINDINGS.keyboard, ...(parsed.keyboard ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_BINDINGS);
  }
}

export function saveBindings(b: Bindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* storage unavailable; bindings stay in memory */
  }
}

export type Captured = { kind: 'gamepad'; button: number } | { kind: 'key'; code: string };

function deadzone(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return Math.sign(v) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
}

function pressed(gp: Gamepad, i: number): boolean {
  const b = gp.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
}

function value(gp: Gamepad, i: number): number {
  const b = gp.buttons[i];
  if (!b) return 0;
  return b.value > 0 ? b.value : b.pressed ? 1 : 0;
}

/**
 * Reads keyboard and the first connected gamepad every frame and produces one CarInput.
 * Gamepad wins over keyboard when it is connected and any control is active.
 */
export class InputManager {
  bindings: Bindings = loadBindings();

  private keys = new Set<string>();
  private tapped = new Set<string>();
  private gamepadIndex: number | null = null;
  private prevReset = false;
  private prevToggleCam = false;
  private prevMenu = false;
  private prevButtons: boolean[] = [];
  private capture: ((c: Captured) => void) | null = null;

  onControllerChange: ((name: string | null) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        if (e.code !== 'Escape') this.finishCapture({ kind: 'key', code: e.code });
        else this.cancelCapture();
        return;
      }
      if (e.repeat) return;
      this.keys.add(e.code);
      this.tapped.add(e.code); // latched until the next poll so short taps survive slow frames
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

  /** Next gamepad button or key press is reported to `cb` instead of driving the car. Escape cancels. */
  startCapture(cb: (c: Captured) => void): void {
    this.capture = cb;
  }

  cancelCapture(): void {
    this.capture = null;
  }

  get capturing(): boolean {
    return this.capture !== null;
  }

  private finishCapture(c: Captured): void {
    const cb = this.capture;
    this.capture = null;
    cb?.(c);
  }

  rebind(action: Action, c: Captured): void {
    if (c.kind === 'gamepad') this.bindings.gamepad[action] = c.button;
    else this.bindings.keyboard[action] = c.code;
    saveBindings(this.bindings);
  }

  resetBindings(): void {
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    saveBindings(this.bindings);
  }

  private currentGamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex !== null) {
      const gp = pads[this.gamepadIndex];
      if (gp && gp.connected) return gp;
      this.gamepadIndex = null;
    }
    // Chrome only exposes a pad after a button press and may not fire `gamepadconnected`. Poll.
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

    if (gp) {
      // Edge detection for capture.
      const now = gp.buttons.map((_, i) => pressed(gp, i));
      if (this.capture) {
        for (let i = 0; i < now.length; i++) {
          if (now[i] && !this.prevButtons[i]) {
            this.prevButtons = now;
            this.finishCapture({ kind: 'gamepad', button: i });
            break;
          }
        }
      }
      this.prevButtons = now;
    }

    const kb = this.readKeyboard();
    const pad = gp ? this.readGamepad(gp) : null;
    const car: CarInput = this.capture ? { ...kb, ...zeroed() } : pad && isActive(pad) ? pad : kb;

    const g = this.bindings.gamepad;
    const k = this.bindings.keyboard;
    // One-shot actions: a key counts if it is held now OR was tapped since the last poll.
    const key = (code: string) => this.keys.has(code) || this.tapped.has(code);
    const reset = !this.capture && (key(k.reset) || (!!gp && pressed(gp, g.reset)));
    const toggleCam = !this.capture && (key(k.ballCam) || (!!gp && pressed(gp, g.ballCam)));
    const menu = !this.capture && (key(k.menu) || (!!gp && pressed(gp, g.menu)));
    this.tapped.clear();

    const frame: FrameInput = {
      car,
      resetPressed: reset && !this.prevReset,
      toggleCameraPressed: toggleCam && !this.prevToggleCam,
      menuPressed: menu && !this.prevMenu,
      controllerName: gp?.id ?? null,
    };
    this.prevReset = reset;
    this.prevToggleCam = toggleCam;
    this.prevMenu = menu;
    return frame;
  }

  private readGamepad(gp: Gamepad): CarInput {
    const g = this.bindings.gamepad;
    const lx = deadzone(gp.axes[0] ?? 0);
    const ly = deadzone(gp.axes[1] ?? 0);
    const handbrake = pressed(gp, g.handbrake);
    const rollButtons = (pressed(gp, g.airRollRight) ? 1 : 0) - (pressed(gp, g.airRollLeft) ? 1 : 0);
    return {
      throttle: clamp(value(gp, g.throttle) - value(gp, g.reverse)),
      steer: lx,
      pitch: ly, // stick back (positive) = nose up
      yaw: handbrake ? 0 : lx,
      roll: handbrake ? lx : rollButtons,
      jump: pressed(gp, g.jump),
      boost: pressed(gp, g.boost),
      handbrake,
    };
  }

  private readKeyboard(): CarInput {
    const k = this.keys;
    const b = this.bindings.keyboard;
    const fwd = (k.has(b.throttle) || k.has('ArrowUp') ? 1 : 0) - (k.has(b.reverse) || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const handbrake = k.has(b.handbrake);
    const roll = (k.has(b.airRollRight) ? 1 : 0) - (k.has(b.airRollLeft) ? 1 : 0);
    return {
      throttle: fwd,
      steer: side,
      pitch: -fwd, // forward key pitches the nose down like pushing the stick forward
      yaw: handbrake ? 0 : side,
      roll: handbrake ? side : roll,
      jump: k.has(b.jump),
      boost: k.has(b.boost),
      handbrake,
    };
  }
}

function zeroed(): CarInput {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
}

function isActive(i: CarInput): boolean {
  return i.throttle !== 0 || i.steer !== 0 || i.pitch !== 0 || i.roll !== 0 || i.jump || i.boost || i.handbrake;
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
