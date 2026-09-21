import { ParticleSystem } from './ParticleSystem.js';
import { settings } from '../config/settings.js';

/**
 * 管理应用中的全部粒子系统。
 *
 * 系统按名字懒创建，并在同一技能的每个实例之间*共享*——这正是对象池
 * 的意义所在：施放二十次火焰，复用的是同一个余烬缓冲，而不是每次新建一个。
 */
export class ParticleEngine {
    constructor(scene) {
        this.scene = scene;
        this.systems = new Map();
    }

    /**
     * 获取（或懒创建）一个共享系统。
     * @param {string} name
     * @param {object} options 见 ParticleSystem
     * @returns {ParticleSystem}
     */
    get(name, options) {
        let system = this.systems.get(name);
        if (!system) {
            system = new ParticleSystem({ name, ...options });
            this.systems.set(name, system);
            this.scene.add(system.object3D);
        }
        return system;
    }

    /** 上传本帧的生成数据。只调用一次，在所有技能 update 之后。 */
    flush() {
        for (const system of this.systems.values()) system.flush();
    }

    /**
     * 当前存活的粒子总数，供 HUD 显示。
     * 会遍历所有对象池，所以要在统计间隔里调用——不要每帧调用。
     */
    countLive(time) {
        let total = 0;
        for (const system of this.systems.values()) total += system.countLive(time);
        return total;
    }

    reset() {
        for (const system of this.systems.values()) system.reset();
    }

    dispose() {
        for (const system of this.systems.values()) {
            this.scene.remove(system.object3D);
            system.dispose();
        }
        this.systems.clear();
    }
}

/**
 * 小数速率的粒子发射器。
 *
 * 每帧直接发射 `rate * dt` 个粒子，在高帧率下会被截断为零、在低帧率下
 * 又会变成爆发；把余数累积起来，才能让发射真正与帧率无关。
 */
export class RateEmitter {
    constructor(rate = 30) {
        this.rate = rate;
        this._accumulator = 0;
    }

    /** @returns {number} 本帧应生成的完整粒子数 */
    tick(dt, rate = this.rate) {
        this._accumulator += rate * settings.global.emissionRate * dt;
        const count = Math.floor(this._accumulator);
        this._accumulator -= count;
        // 绝不能让一次卡顿在单帧里倾泻出成千上万的粒子。
        return Math.min(count, 240);
    }

    reset() {
        this._accumulator = 0;
    }
}
