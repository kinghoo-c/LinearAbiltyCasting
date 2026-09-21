import { Color } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

/**
 * 冲击用的全屏颜色闪光。
 *
 * 除了状态什么都不持有——合成（composite）通道每帧读取 `color` 与
 * `strength`，所以一次闪光不产生额外的绘制调用。
 */
export class ScreenFlash {
    constructor() {
        this.color = new Color(1, 1, 1);
        this.strength = 0;
        this._decay = 0.0004;
    }

    /**
     * @param {THREE.Color} color
     * @param {number} strength 0..1
     * @param {number} [decay]  一秒之后剩余的比例
     */
    trigger(color, strength, decay = 0.0004) {
        const scaled = strength * settings.post.flashStrength;
        if (scaled <= this.strength) return;
        this.color.copy(color);
        this.strength = Math.min(1, scaled);
        this._decay = decay;
    }

    update(dt) {
        if (this.strength <= 0.0005) {
            this.strength = 0;
            return;
        }
        this.strength = damp(this.strength, 0, this._decay, dt);
    }

    reset() {
        this.strength = 0;
    }
}
