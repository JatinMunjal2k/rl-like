import * as THREE from 'three';
import { UU } from '../sim/rl';
import type { Settings } from '../settings';

const carPos = new THREE.Vector3();
const ballPos = new THREE.Vector3();
const dir = new THREE.Vector3();
const desired = new THREE.Vector3();
const desiredLook = new THREE.Vector3();
const twist = new THREE.Quaternion();

/** Camera never goes below this height, like RL's floor clamp. */
const MIN_CAMERA_HEIGHT = 0.35;

export interface CameraCarState {
  /** Heading updates are held while the car is flipping or near inverted (see below). */
  holdHeading: boolean;
}

/**
 * Rocket League chase camera, driven by RL's camera settings (FOV, distance, height, angle, stiffness).
 *
 * Ball cam: the camera sits on the 3D line from the ball through the car, `distance` behind the
 * car and `height` above it, then looks at the ball. Because the line is 3D, a high ball pushes
 * the camera down toward the floor (clamped), so the car stays in the lower part of the frame
 * instead of scrolling off the bottom.
 *
 * Car cam: the camera sits behind the car's heading and looks level along it, tilted by `angle`.
 * The heading is the swing-twist yaw of the car's rotation about world up, which stays put
 * through flips about horizontal axes; it is frozen while the car flips or is near inverted.
 */
export class FollowCamera {
  ballCam = true;
  private readonly look = new THREE.Vector3();
  private yaw = 0;
  private initialized = false;

  constructor(private readonly settings: Settings) {}

  toggle(): void {
    this.ballCam = !this.ballCam;
  }

  applyProjection(camera: THREE.PerspectiveCamera): void {
    // RL's FOV setting is horizontal; three.js wants vertical.
    const hfov = (this.settings.camera.fov * Math.PI) / 180;
    camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / camera.aspect) * 180) / Math.PI;
    camera.updateProjectionMatrix();
  }

  update(camera: THREE.PerspectiveCamera, car: THREE.Object3D, ball: THREE.Object3D, state: CameraCarState, dt: number): void {
    const s = this.settings.camera;
    const distance = s.distance * UU;
    const height = s.height * UU;
    const posSmooth = 3 + s.stiffness * 27;
    const lookSmooth = posSmooth * 1.4;
    const yawSmooth = 4 + s.stiffness * 8;
    const angleRad = (s.angle * Math.PI) / 180;

    carPos.copy(car.position);
    ballPos.copy(ball.position);

    if (this.ballCam) {
      dir.subVectors(carPos, ballPos);
      if (dir.lengthSq() < 0.25) dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      dir.normalize();
      // Horizontal direction from ball to car, used when the 3D line would put the camera underground.
      let hx = dir.x;
      let hz = dir.z;
      const hl = Math.hypot(hx, hz);
      if (hl > 1e-4) {
        hx /= hl;
        hz /= hl;
      } else {
        hx = Math.sin(this.yaw);
        hz = Math.cos(this.yaw);
      }
      desired.copy(carPos).addScaledVector(dir, distance);
      desired.y += height;
      if (desired.y < MIN_CAMERA_HEIGHT) {
        // Stay a full `distance` from the car while sitting on the floor: slide the camera out
        // horizontally instead of collapsing onto the car. Keeps the car in the lower frame.
        const dy = carPos.y - MIN_CAMERA_HEIGHT;
        const h = Math.sqrt(Math.max(distance * distance - dy * dy, (0.6 * distance) ** 2));
        desired.set(carPos.x + hx * h, MIN_CAMERA_HEIGHT, carPos.z + hz * h);
      }
      // Look at the ball, but never let the car leave the bottom of the frame: cap the look
      // elevation so the car stays inside the vertical field of view (with the angle tilt).
      // Margin keeps the car about a fifth of the frame above the bottom edge, as RL frames it.
      const vHalf = ((camera.fov / 2) * Math.PI) / 180 - 0.16;
      const toBall = desiredLook.copy(ballPos).sub(desired);
      const toCar = dir.copy(carPos).sub(desired); // reuse scratch
      const eBall = Math.atan2(toBall.y, Math.hypot(toBall.x, toBall.z));
      const eCar = Math.atan2(toCar.y, Math.hypot(toCar.x, toCar.z));
      const eLook = Math.min(eBall, eCar + vHalf - angleRad);
      const hd = Math.hypot(toBall.x, toBall.z);
      desiredLook.set(desired.x + toBall.x, desired.y + Math.tan(eLook) * hd, desired.z + toBall.z);
      // Keep the heading in sync so switching to car cam does not swing.
      this.yaw = Math.atan2(-hx, -hz);
    } else {
      if (!state.holdHeading) {
        const targetYaw = headingYaw(car.quaternion, this.yaw);
        const k = this.initialized ? 1 - Math.exp(-yawSmooth * dt) : 1;
        this.yaw += shortestAngle(this.yaw, targetYaw) * k;
      }
      // Our car faces -Z at yaw 0; rotating about +Y by yaw sends it to (-sin, 0, -cos).
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      desired.set(carPos.x - fx * distance, carPos.y + height, carPos.z - fz * distance);
      // Look level along the heading from the camera's own height, so the car sits low in frame.
      desiredLook.set(desired.x + fx * 20, desired.y, desired.z + fz * 20);
    }

    desired.y = Math.max(desired.y, MIN_CAMERA_HEIGHT);

    if (!this.initialized) {
      camera.position.copy(desired);
      this.look.copy(desiredLook);
      this.yaw = headingYaw(car.quaternion, 0);
      this.initialized = true;
    } else {
      camera.position.lerp(desired, 1 - Math.exp(-posSmooth * dt));
      this.look.lerp(desiredLook, 1 - Math.exp(-lookSmooth * dt));
    }
    camera.lookAt(this.look);
    // RL's "angle": negative tilts the view down.
    camera.rotateX(angleRad);
  }
}

/** Yaw of the twist component of q about world +Y. Falls back to `previous` when the nose is vertical. */
function headingYaw(q: THREE.Quaternion, previous: number): number {
  const len = Math.hypot(q.y, q.w);
  if (len < 1e-3) return previous;
  twist.set(0, q.y / len, 0, q.w / len);
  let yaw = 2 * Math.atan2(twist.y, twist.w);
  if (yaw > Math.PI) yaw -= 2 * Math.PI;
  if (yaw < -Math.PI) yaw += 2 * Math.PI;
  return yaw;
}

function shortestAngle(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
