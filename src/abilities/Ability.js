import { Group, Vector3, Color } from 'three';
import { settings } from '../config/settings.js';
import { saturate, Easing } from '../utils/math.js';
import { getColor } from '../utils/color.js';
import { LAYER } from '../core/Layers.js';

export const AbilityPhase = Object.freeze({
    IDLE: 'idle',
    TRAVEL: 'travel',
    IMPACT: 'impact',
    FADE: 'fade',
    DONE: 'done',
});

const _up = new Vector3(0, 1, 0);

/**
 * 线性技能弹道（skillshot）的抽象基类。
 *
 * 这个沙盒过去是沿一条手绘样条施放的；现在它沿瞄准指示器选出的**直线**
 * 施放，所以这个基类也相应地很小。它仍然负责这些，因为每个技能都需要，
 * 而且谁都不该重新推导一遍：
 *
 *   - 相位状态机（travel → impact → fade → done）
 *   - 一个以恒定米每秒沿直线推进的前端，与帧率无关，并从静止缓入
 *   - 每个效果把自己摆进去的局部坐标系（`direction`、`side`）
 *   - 动态光的记账，包括一个会衰减的命中冲击
 *   - 池化约定：`spawn` 必须完整重置状态，`destroy` 必须释放，
 *     而且两者都不许产生内存分配
 *
 * 子类实现：`createShaders`、`createParticles`、`onSpawn`、`onTravel`、
 * `onImpact`、`onFade`、`onDestroy`。
 *
 * 因此新增一个技能就是一个新文件加一段设置 —— 项目里其他任何东西都不用改。
 */
export class Ability {
    /**
     * @param {string} element  `settings` 中的键（'ice'）
     * @param {object} context  共享系统（见 AbilityManager）
     */
    constructor(element, context) {
        this.element = element;
        this.ctx = context;

        this.group = new Group();
        this.group.name = `Ability:${element}`;
        this.group.layers.set(LAYER.VFX);
        this.group.matrixAutoUpdate = false;

        this.phase = AbilityPhase.IDLE;

        /** 这次施放的起点，在地板上。 */
        this.origin = new Vector3();
        /** 单位朝向，水平。 */
        this.direction = new Vector3(0, 0, 1);
        /** 单位横向向量，`direction × up`。 */
        this.side = new Vector3(1, 0, 0);
        /** 这次施放能够到多远，单位米。 */
        this.length = 1;

        /** 断裂前缘已经走过的米数。 */
        this.front = 0;
        /** 该前缘占 `length` 的比例。 */
        this.u = 0;
        /** 前缘的世界坐标 —— 镜头框住的就是它。 */
        this.position = new Vector3();

        this.age = 0;
        this.impactTime = 0;
        this.fadeTime = 0;

        this.light = null;
        this.lightColor = new Color();
        /** 瞬时的加法光冲击（命中时）。会自行衰减。 */
        this.lightBoost = 0;

        this.createShaders();
        this.createParticles();
    }

    /** 该元素的实时设置块。 */
    get config() {
        return settings[this.element];
    }

    get isActive() {
        return this.phase !== AbilityPhase.IDLE && this.phase !== AbilityPhase.DONE;
    }

    get isFinished() {
        return this.phase === AbilityPhase.DONE;
    }

    /** 本次施放当前正在绘制的实例化几何体。仅用于 HUD 读数。 */
    get instanceCount() {
        return 0;
    }

    /* ------------------------------------------------------------------ */
    /* 子类钩子                                                            */
    /* ------------------------------------------------------------------ */

    /** 在构造时一次性构建材质/网格。 */
    createShaders() {}

    /** 注册该元素需要的那些共享粒子系统。 */
    createParticles() {}

    /** 每次施放开始时调用，此时基类状态已经重置完毕。 */
    onSpawn() {}

    /** 前端仍在推进期间，逐帧调用。 */
    onTravel(_dt) {}

    /** 前端抵达直线末端时的一次性调用。 */
    onImpact() {}

    /**
     * 命中之后逐帧调用。
     * @param {number} t 命中相位期间从 0 走到 1，随后淡出期间再从 1 走到 2。
     */
    onFade(_dt, _t) {}

    /** 释放每次施放各自的资源。 */
    onDestroy() {}

    /** 命中相位和淡出相位各持续多久。可按元素覆写。 */
    get impactDuration() {
        return 1.1;
    }

    get fadeDuration() {
        return 1.2;
    }

    /**
     * 逐帧乘在动态光强度上的系数。
     *
     * 默认是缓慢的微光而不是闪烁：冰会反光，不会忽明忽暗。那些*应该*忽明
     * 忽暗的元素请覆写它。
     */
    lightShimmer() {
        return 0.9 + 0.1 * Math.sin(this.age * 9.3) * Math.sin(this.age * 3.7);
    }

    /* ------------------------------------------------------------------ */
    /* 生命周期                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 开始一次施放。
     *
     * @param {THREE.Vector3} origin     在地板上
     * @param {THREE.Vector3} direction  单位向量，水平
     * @param {number} distance          单位米
     */
    spawn(origin, direction, distance) {
        this.origin.set(origin.x, 0, origin.z);
        this.direction.copy(direction).setY(0).normalize();
        this.side.crossVectors(this.direction, _up).normalize();
        this.length = Math.max(0.1, distance);

        this.front = 0;
        this.u = 0;
        this.age = 0;
        this.impactTime = 0;
        this.fadeTime = 0;
        this.lightBoost = 0;
        this.phase = AbilityPhase.TRAVEL;

        this.position.copy(this.origin);
        this.light = this.ctx.lights.acquire();

        this.group.visible = true;
        this.onSpawn();
    }

    /** 施放直线上的一点。`s` 为沿其 0..1 的位置。 */
    pointAt(s, out) {
        return out.copy(this.origin).addScaledVector(this.direction, s * this.length);
    }

    /**
     * 推进前端。由 delta time 驱动，因此无论帧率多少、这次施放有多长，
     * 喷发都以恒定的米每秒前进。
     *
     * @returns {boolean} 前端抵达末端的那一帧为 true
     */
    advance(dt) {
        const speed = this.config.speed * settings.global.speed;
        // 从静止缓入，让前端有重量感。以经过的时间为基准，而不是以进度为基准：
        // 若以 `u` 为基准，第一步就会被乘以零，前端永远也离不开施法者。
        const easeIn = Easing.outQuad(saturate(this.age / 0.08));

        this.front += speed * easeIn * dt;
        const previousU = this.u;
        this.u = saturate(this.front / this.length);
        this.pointAt(this.u, this.position);

        return this.u >= 1 && previousU < 1;
    }

    update(dt) {
        if (!this.isActive) return;
        this.age += dt;

        switch (this.phase) {
            case AbilityPhase.TRAVEL: {
                const reachedEnd = this.advance(dt);
                this.onTravel(dt);
                this._updateLight(dt, 1);
                if (reachedEnd) {
                    this.phase = AbilityPhase.IMPACT;
                    this.impactTime = 0;
                    this.onImpact();
                }
                break;
            }

            case AbilityPhase.IMPACT: {
                this.impactTime += dt;
                const t = saturate(this.impactTime / this.impactDuration);
                this.onFade(dt, t);
                this._updateLight(dt, 1 - Easing.inQuad(t) * 0.45);
                if (t >= 1) {
                    this.phase = AbilityPhase.FADE;
                    this.fadeTime = 0;
                }
                break;
            }

            case AbilityPhase.FADE: {
                this.fadeTime += dt;
                const t = saturate(this.fadeTime / this.fadeDuration);
                this.onFade(dt, 1 + t);
                this._updateLight(dt, (1 - t) * 0.35);
                if (t >= 1) this.phase = AbilityPhase.DONE;
                break;
            }

            default:
                break;
        }
    }

    _updateLight(dt, scale) {
        if (!this.light) return;
        const cfg = this.config;
        this.lightColor.copy(getColor(cfg.lightColor));
        const shimmer = this.lightShimmer();
        this.ctx.lights.set(
            this.light,
            this.position,
            this.lightColor,
            cfg.lightIntensity * scale * shimmer + this.lightBoost,
            cfg.lightRadius * (1 + this.lightBoost * 0.02),
            dt
        );
        this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
    }

    /** 归还到池中。必须让该实例保持可复用。 */
    destroy() {
        this.onDestroy();
        this.ctx.lights.release(this.light);
        this.light = null;
        this.group.visible = false;
        this.phase = AbilityPhase.IDLE;
    }

    /** 释放 GPU 资源（仅应用拆除时 —— 不属于池化流程）。 */
    dispose() {
        this.group.parent?.remove(this.group);
    }
}
