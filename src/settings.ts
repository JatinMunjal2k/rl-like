/**
 * Player settings, modelled on Rocket League's Camera and Controls menus.
 * Values are in RL's own units (uu, degrees) and converted where consumed.
 */

export interface Settings {
  camera: {
    /** Horizontal field of view in degrees. RL: 60–110, default 110. */
    fov: number;
    /** Distance behind the car in uu. RL: 100–400, default 270. */
    distance: number;
    /** Height above the car in uu. RL: 40–200, default 110. */
    height: number;
    /** Camera pitch offset in degrees, negative looks down. RL: -15–0, default -3. */
    angle: number;
    /** How quickly the camera follows. RL: 0–1, default 0.5. */
    stiffness: number;
  };
  controls: {
    /** Multiplier on stick steering, clamped to 1. RL: 1–10, default 1. */
    steeringSensitivity: number;
    /** Multiplier on stick pitch/yaw/roll in the air. RL: 1–10, default 1. */
    aerialSensitivity: number;
    /** Radial stick deadzone. RL: 0.05–0.5, default 0.5 (we default lower). */
    deadzone: number;
    /** Stick magnitude needed for a dodge instead of a double jump. RL: 0.5–0.9, default 0.5. */
    dodgeDeadzone: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  camera: { fov: 110, distance: 270, height: 110, angle: -3, stiffness: 0.5 },
  controls: { steeringSensitivity: 1.0, aerialSensitivity: 1.0, deadzone: 0.2, dodgeDeadzone: 0.5 },
};

export type SettingSection = keyof Settings;

export interface SettingDef {
  section: SettingSection;
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals: number;
}

export const CAMERA_DEFS: SettingDef[] = [
  { section: 'camera', key: 'fov', label: 'Field of view', min: 60, max: 110, step: 1, unit: '°', decimals: 0 },
  { section: 'camera', key: 'distance', label: 'Distance', min: 100, max: 400, step: 10, decimals: 0 },
  { section: 'camera', key: 'height', label: 'Height', min: 40, max: 200, step: 10, decimals: 0 },
  { section: 'camera', key: 'angle', label: 'Angle', min: -15, max: 0, step: 1, unit: '°', decimals: 0 },
  { section: 'camera', key: 'stiffness', label: 'Stiffness', min: 0, max: 1, step: 0.05, decimals: 2 },
];

export const CONTROL_DEFS: SettingDef[] = [
  { section: 'controls', key: 'steeringSensitivity', label: 'Steering sensitivity', min: 1, max: 10, step: 0.1, decimals: 1 },
  { section: 'controls', key: 'aerialSensitivity', label: 'Aerial sensitivity', min: 1, max: 10, step: 0.1, decimals: 1 },
  { section: 'controls', key: 'deadzone', label: 'Controller deadzone', min: 0.05, max: 0.5, step: 0.05, decimals: 2 },
  { section: 'controls', key: 'dodgeDeadzone', label: 'Dodge deadzone', min: 0.5, max: 0.9, step: 0.05, decimals: 2 },
];

const STORAGE_KEY = 'rl-like.settings.v1';

export function loadSettings(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return s;
    const parsed = JSON.parse(raw) as Partial<Record<SettingSection, Record<string, number>>>;
    for (const section of ['camera', 'controls'] as SettingSection[]) {
      const target = s[section] as unknown as Record<string, number>;
      for (const [k, v] of Object.entries(parsed[section] ?? {})) {
        if (k in target && typeof v === 'number' && Number.isFinite(v)) target[k] = v;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function getSetting(s: Settings, def: SettingDef): number {
  return (s[def.section] as unknown as Record<string, number>)[def.key];
}

export function setSetting(s: Settings, def: SettingDef, value: number): void {
  const v = Math.min(def.max, Math.max(def.min, Math.round(value / def.step) * def.step));
  (s[def.section] as unknown as Record<string, number>)[def.key] = +v.toFixed(def.decimals);
}
