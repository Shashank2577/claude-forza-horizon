import * as THREE from 'three';
import { damp } from './noise.js';

// Scratch vectors — never allocate per-frame.
const _fwd = new THREE.Vector3();
const _upOff = new THREE.Vector3();

// Cinematic chase cam: velocity-aligned look-ahead, speed FOV, smoothed shake,
// damped roll in corners. Tuned for FH-style planted follow at speed.
export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.targetPos = new THREE.Vector3();
    this.curPos = new THREE.Vector3(0, 8, -16);
    this.lookAt = new THREE.Vector3();
    this.curLook = new THREE.Vector3();
    this.fov = 58;
    this.mode = 0; // 0 chase, 1 far, 2 hood-ish
    this.shake = 0;
    this.speedShake = 0;
    this.roll = 0;
    this._prevHeading = 0;
    this._shakePhase = 0;
  }

  cycleMode() { this.mode = (this.mode + 1) % 3; }

  update(dt, car) {
    const heading = car.heading || 0;
    const speed = Math.abs(car.speed || 0);

    // Velocity-aligned aim: during drifts, look toward travel direction not nose.
    const vx = car.velocityX ?? Math.sin(heading) * car.speed;
    const vz = car.velocityZ ?? Math.cos(heading) * car.speed;
    const velAngle = Math.atan2(vx, vz);
    const slipBlend = Math.min(Math.abs(car.slip || 0) / 12, 0.65);
    const aimAngle = heading + (velAngle - heading) * slipBlend;
    _fwd.set(Math.sin(aimAngle), 0, Math.cos(aimAngle));

    let back, up, lookAhead;
    if (this.mode === 0) {
      const speedPull = Math.min(speed / 60, 1) * 3.2;
      back = -11.5 - speedPull;
      up = 5.1 - Math.min(speed / 60, 1) * 1.0;
      lookAhead = 8 + speed * 0.12;
    } else if (this.mode === 1) {
      back = -22; up = 10; lookAhead = 7;
    } else {
      back = -2.2; up = 1.55; lookAhead = 14;
    }

    this.targetPos.copy(car.position)
      .addScaledVector(_fwd, back)
      .add(_upOff.set(0, up, 0));

    const boost = car.boosting ? 1 : 0;
    const impact = Math.min(1, Number(car.impact) || 0);
    if (car.impact) car.impact = Math.max(0, car.impact - dt * 2.8);
    this.shake = damp(this.shake, Math.max(boost, impact * 1.4), 8, dt);
    const speedShakeTarget = Math.max(0, Math.min((speed - 28) / 40, 1));
    this.speedShake = damp(this.speedShake, speedShakeTarget, 4, dt);
    const shakeAmt = this.shake + this.speedShake * 0.55 + impact * 0.35;

    // Smoothed sine shake — no per-frame random TV static.
    this._shakePhase += dt * 28;
    const sx = Math.sin(this._shakePhase * 1.7) * shakeAmt * 0.14;
    const sy = Math.sin(this._shakePhase * 2.3 + 1.2) * shakeAmt * 0.09;
    this.targetPos.x += sx;
    this.targetPos.y += sy;

    const followLambda = this.mode === 2 ? 16 : 9.0;
    this.curPos.x = damp(this.curPos.x, this.targetPos.x, followLambda, dt);
    this.curPos.y = damp(this.curPos.y, this.targetPos.y, followLambda + 1, dt);
    this.curPos.z = damp(this.curPos.z, this.targetPos.z, followLambda, dt);

    this.lookAt.copy(car.position)
      .addScaledVector(_fwd, lookAhead + (car.slip || 0) * 1.8)
      .add(_upOff.set(0, 1.65, 0));
    this.curLook.x = damp(this.curLook.x, this.lookAt.x, 9, dt);
    this.curLook.y = damp(this.curLook.y, this.lookAt.y, 9, dt);
    this.curLook.z = damp(this.curLook.z, this.lookAt.z, 9, dt);

    this.camera.position.copy(this.curPos);
    this.camera.lookAt(this.curLook);

    if (dt > 0) {
      let dh = heading - this._prevHeading;
      if (dh > Math.PI) dh -= Math.PI * 2;
      else if (dh < -Math.PI) dh += Math.PI * 2;
      const yawRate = dh / dt;
      const rollTarget = Math.max(-0.045, Math.min(0.045, yawRate * 0.055));
      this.roll = damp(this.roll, rollTarget, 5, dt);
    }
    this._prevHeading = heading;
    if (Math.abs(this.roll) > 1e-4) this.camera.rotateZ(this.roll);

    const targetFov = (this.mode === 2 ? 70 : 62) + Math.min(speed / 55, 1) * 22 + boost * 8;
    this.fov = damp(this.fov, targetFov, 5.5, dt);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }
}
