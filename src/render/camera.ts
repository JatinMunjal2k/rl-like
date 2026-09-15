import * as THREE from 'three';
import { UU } from '../sim/rl';
import type { Settings } from '../settings';

const carPos = new THREE.Vector3();
const ballPos = new THREE.Vector3();
const dir = new THREE.Vector3();
const desired = new THREE.Vector3();
const desiredLook = new THREE.Vector3();
const carFwd = new THREE.Vector3();
const carUp = new THREE.Vector3();
const tmp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Camera never goes below this height, like RL's floor clamp. */
const MIN_CAMERA_HEIGHT = 0.35;

export interface CameraCarState {
  /** Heading updates are held while the car is flipping (RL's camera ignores dodge rotation). */
  holdHeading: boolean;
  /** Three or more wheels on a surface: the camera adopts that surface as "down". */
  grounded: boolean;
}

/**
 * Rocket League chase camera, driven by RL's camera settings (FOV, distance, height, angle, stiffness).
 *
 * Ball cam: the camera sits on the 3D line from the ball through the car, `distance` behind the
 * car and `height` above it, then looks at the ball. Because the line is 3D, a high ball pushes
 * the camera down toward the floor (clamped), so the car stays in the lower part of the frame
 * instead of scrolling off the bottom. Roll reference is always world up.
 *
 * Car cam: the camera follows the car's nose. Its forward direction eases toward the car's
 * forward vector in 3D, so pitching the nose up in the air looks up with it, while an air roll
 * (rotation about that very axis) leaves the view untouched. The roll reference is world up in
 * the air and the car's own up on a surface, so driving up a wall tilts the world with the car
 * and leaving it eases back to level. Dodge and flip rotation is ignored: the direction is
 * frozen while the car flips.
 */
export class FollowCamera {
  ballCam = true;
  private readonly look = new THREE.Vector3();
  private yaw = 0;
  private initialized = false;
  private wasBallCam = true;
  /** Car cam: smoothed forward direction and roll reference. */
  private readonly fwd = new THREE.Vector3(0, 0, -1);
  private readonly upRef = new THREE.Vector3(0, 1, 0);
  private readonly camUp = new THREE.Vector3(0, 1, 0);

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
    const turnSmooth = 5 + s.stiffness * 7;
    const angleRad = (s.angle * Math.PI) / 180;

    carPos.copy(car.position);
    ballPos.copy(ball.position);
    carFwd.set(0, 0, -1).applyQuaternion(car.quaternion);
    carUp.set(0, 1, 0).applyQuaternion(car.quaternion);

    if (this.ballCam !== this.wasBallCam) {
      this.wasBallCam = this.ballCam;
      if (!this.ballCam) {
        // Entering car cam: start from where the camera is already looking so nothing swings.
        camera.getWorldDirection(this.fwd);
        this.upRef.copy(WORLD_UP);
        this.camUp.copy(WORLD_UP);
      }
    }

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
      this.camUp.copy(WORLD_UP);
    } else {
      const k = this.initialized ? 1 - Math.exp(-turnSmooth * dt) : 1;
      // Forward: ease toward the nose, frozen during flips.
      if (!state.holdHeading) {
        this.fwd.lerp(carFwd, k);
        if (!(this.fwd.lengthSq() > 1e-6)) this.fwd.copy(carFwd); // also catches NaN
        this.fwd.normalize();
      }
      // Roll reference: the surface's up while driving on it, world up in the air.
      const targetUp = state.grounded ? carUp : WORLD_UP;
      const kUp = this.initialized ? 1 - Math.exp(-(state.grounded ? 4 : 3) * dt) : 1;
      this.upRef.lerp(targetUp, kUp).normalize();
      // Camera up must not be parallel to the view direction; near the nose-vertical singularity
      // keep the previous frame's up instead of letting the view spin.
      tmp.copy(this.upRef).addScaledVector(this.fwd, -this.fwd.dot(this.upRef));
      if (tmp.lengthSq() > 0.04) this.camUp.copy(tmp).normalize();
      else {
        tmp.copy(this.camUp).addScaledVector(this.fwd, -this.fwd.dot(this.camUp));
        if (tmp.lengthSq() > 1e-4) this.camUp.copy(tmp).normalize();
      }

      desired.copy(carPos).addScaledVector(this.fwd, -distance).addScaledVector(this.upRef, height);
      // Look along the forward direction from the camera's own position, so the car sits low in frame.
      desiredLook.copy(desired).addScaledVector(this.fwd, 20);
      this.yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
    }

    desired.y = Math.max(desired.y, MIN_CAMERA_HEIGHT);

    if (!this.initialized) {
      camera.position.copy(desired);
      this.look.copy(desiredLook);
      this.fwd.copy(carFwd);
      this.initialized = true;
    } else {
      camera.position.lerp(desired, 1 - Math.exp(-posSmooth * dt));
      this.look.lerp(desiredLook, 1 - Math.exp(-lookSmooth * dt));
    }
    camera.up.copy(this.camUp);
    camera.lookAt(this.look);
    // RL's "angle": negative tilts the view down.
    camera.rotateX(angleRad);
  }
}
