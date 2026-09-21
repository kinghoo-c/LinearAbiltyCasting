import { Vector3 } from 'three';
import { settings } from '../config/settings.js';

/**
 * 由多层噪声驱动的加法式镜头震动。
 *
 * 多次冲击会叠加进同一个 trauma 值；偏移量取自平滑的伪噪声而非白噪声，
 * 因此这股运动读起来像重量感，而不是抖动。trauma 按二次曲线衰减，这正是
 * 让轻微命中显得干脆、让重击显得沉重的原因。
 */
export class CameraShake {
    constructor(rig) {
        this.rig = rig;
        this.trauma = 0;
        this.decay = 1.6;
        this.frequency = 22;
        this._time = 0;
        this._offset = new Vector3();
    }

    /**
     * @param {number} amount    要叠加的 trauma，0..1
     * @param {number} [decay]   每秒衰减的 trauma 单位数
     * @param {number} [frequency]
     */
    add(amount, decay = 1.6, frequency = 22) {
        this.trauma = Math.min(1, this.trauma + amount * settings.global.cameraShake);
        this.decay = decay;
        this.frequency = frequency;
    }

    /** 持续的低频轰鸣（土元素）。效果存续期间每帧调用。 */
    rumble(amount, dt) {
        this.trauma = Math.min(1, this.trauma + amount * settings.global.cameraShake * dt * 3);
    }

    update(dt) {
        this._time += dt;

        if (this.trauma <= 0.0001) {
            this.rig.shakeOffset.set(0, 0, 0);
            this.rig.shakeRoll = 0;
            return;
        }

        // 二次衰减：让线性的 trauma 衰减在感知上对应线性的震动。
        const shake = this.trauma * this.trauma;
        const t = this._time * this.frequency;

        // 由几组不可通约频率的正弦叠加出的廉价平滑噪声。
        const nx = Math.sin(t * 1.0) * 0.6 + Math.sin(t * 2.31 + 1.7) * 0.4;
        const ny = Math.sin(t * 1.37 + 4.2) * 0.6 + Math.sin(t * 2.79 + 0.3) * 0.4;
        const nz = Math.sin(t * 0.83 + 2.9) * 0.6 + Math.sin(t * 3.11 + 5.1) * 0.4;

        this._offset.set(nx, ny * 0.7, nz).multiplyScalar(shake * 0.55);
        this.rig.shakeOffset.copy(this._offset);
        this.rig.shakeRoll = nz * shake * 0.035;

        this.trauma = Math.max(0, this.trauma - this.decay * dt);
    }

    reset() {
        this.trauma = 0;
        this.rig.shakeOffset.set(0, 0, 0);
        this.rig.shakeRoll = 0;
    }
}
