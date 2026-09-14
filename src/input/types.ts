/** Per-tick control state for one car. All analog values are in [-1, 1]. */
export interface CarInput {
  /** +1 forward, -1 reverse */
  throttle: number;
  /** +1 right */
  steer: number;
  /** +1 nose up (stick pulled back) */
  pitch: number;
  /** +1 right, only used while airborne */
  yaw: number;
  /** +1 roll right, only used while airborne */
  roll: number;
  jump: boolean;
  boost: boolean;
  /** powerslide on the ground, free air roll in the air */
  handbrake: boolean;
}

export const EMPTY_INPUT: CarInput = {
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
};

/** What the input layer hands the frame loop: car controls plus one-shot UI actions. */
export interface FrameInput {
  car: CarInput;
  resetPressed: boolean;
  toggleCameraPressed: boolean;
  controllerName: string | null;
}
