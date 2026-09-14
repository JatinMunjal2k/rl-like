import * as THREE from 'three';

const DISTANCE = 4.6;
const HEIGHT = 1.7;
const POS_SMOOTH = 10; // higher = snappier
const LOOK_SMOOTH = 14;

const carPos = new THREE.Vector3();
const ballPos = new THREE.Vector3();
const dir = new THREE.Vector3();
const desired = new THREE.Vector3();
const desiredLook = new THREE.Vector3();
const fwd = new THREE.Vector3();
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

/** Rocket League style chase camera with a ball-cam toggle. */
export class FollowCamera {
  ballCam = true;
  private readonly look = new THREE.Vector3();
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
      if (dir.lengthSq() < 0.25) {
        fwd.copy(LOCAL_FORWARD).applyQuaternion(car.quaternion);
        dir.set(-fwd.x, 0, -fwd.z);
      }
      dir.normalize();
      desired.copy(carPos).addScaledVector(dir, DISTANCE);
      desired.y = carPos.y + HEIGHT;
      desiredLook.copy(ballPos);
    } else {
      fwd.copy(LOCAL_FORWARD).applyQuaternion(car.quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      desired.copy(carPos).addScaledVector(fwd, -DISTANCE);
      desired.y = carPos.y + HEIGHT;
      desiredLook.copy(carPos).addScaledVector(fwd, 8).add(new THREE.Vector3(0, 0.8, 0));
    }

    // Keep the camera above the floor.
    desired.y = Math.max(desired.y, 0.6);

    if (!this.initialized) {
      camera.position.copy(desired);
      this.look.copy(desiredLook);
      this.initialized = true;
    } else {
      camera.position.lerp(desired, 1 - Math.exp(-POS_SMOOTH * dt));
      this.look.lerp(desiredLook, 1 - Math.exp(-LOOK_SMOOTH * dt));
    }
    camera.lookAt(this.look);
  }
}
