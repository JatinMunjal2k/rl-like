import * as THREE from 'three';

const DISTANCE = 4.6;
const HEIGHT = 1.7;
const POS_SMOOTH = 10; // higher = snappier
const LOOK_SMOOTH = 14;
const YAW_SMOOTH = 8;

const carPos = new THREE.Vector3();
const ballPos = new THREE.Vector3();
const dir = new THREE.Vector3();
const desired = new THREE.Vector3();
const desiredLook = new THREE.Vector3();
const twist = new THREE.Quaternion();

/**
 * Rocket League style chase camera with a ball-cam toggle.
 *
 * Car cam follows the car's HEADING only. The heading is the "twist" of the car's rotation
 * about world up (swing-twist decomposition), which stays put through front flips and rolls,
 * unlike the horizontal projection of the forward vector which snaps 180° as the nose passes
 * vertical.
 */
export class FollowCamera {
  ballCam = true;
  private readonly look = new THREE.Vector3();
  private yaw = 0;
  private initialized = false;

  toggle(): void {
    this.ballCam = !this.ballCam;
  }

  update(camera: THREE.PerspectiveCamera, car: THREE.Object3D, ball: THREE.Object3D, dt: number): void {
    carPos.copy(car.position);
    ballPos.copy(ball.position);

    if (this.ballCam) {
      // Sit behind the car on the line from the ball through the car, look at the ball.
      dir.subVectors(carPos, ballPos);
      dir.y = 0;
      if (dir.lengthSq() < 0.25) dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).negate();
      dir.normalize();
      desired.copy(carPos).addScaledVector(dir, DISTANCE);
      desired.y = carPos.y + HEIGHT;
      desiredLook.copy(ballPos);
    } else {
      const targetYaw = headingYaw(car.quaternion, this.yaw);
      const k = this.initialized ? 1 - Math.exp(-YAW_SMOOTH * dt) : 1;
      this.yaw += shortestAngle(this.yaw, targetYaw) * k;
      // Our car faces -Z at yaw 0; rotating about +Y by yaw sends it to (-sin, 0, -cos).
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      desired.set(carPos.x - fx * DISTANCE, carPos.y + HEIGHT, carPos.z - fz * DISTANCE);
      desiredLook.set(carPos.x + fx * 8, carPos.y + 0.8, carPos.z + fz * 8);
    }

    desired.y = Math.max(desired.y, 0.6);

    if (!this.initialized) {
      camera.position.copy(desired);
      this.look.copy(desiredLook);
      this.yaw = headingYaw(car.quaternion, 0);
      this.initialized = true;
    } else {
      camera.position.lerp(desired, 1 - Math.exp(-POS_SMOOTH * dt));
      this.look.lerp(desiredLook, 1 - Math.exp(-LOOK_SMOOTH * dt));
    }
    camera.lookAt(this.look);
  }
}

/** Yaw of the twist component of q about world +Y. Falls back to `previous` when the nose is vertical. */
function headingYaw(q: THREE.Quaternion, previous: number): number {
  const len = Math.hypot(q.y, q.w);
  if (len < 1e-4) return previous;
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
