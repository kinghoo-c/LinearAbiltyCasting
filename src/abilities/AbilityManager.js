import { IceAbility } from './IceAbility.js';
import { ThunderAbility } from './ThunderAbility.js';
import { MeteorAbility } from './MeteorAbility.js';
import { BeamAbility } from './BeamAbility.js';
import { SnareAbility } from './SnareAbility.js';
import { GlacierAbility } from './GlacierAbility.js';
import { ELEMENTS } from '../config/settings.js';
import { ObjectPool } from '../utils/ObjectPool.js';

/** 注册表：新增一个技能就是在这里加一行。 */
const ABILITY_TYPES = {
    ice: IceAbility,
    thunder: ThunderAbility,
    meteor: MeteorAbility,
    beam: BeamAbility,
    snare: SnareAbility,
    glacier: GlacierAbility,
};

const MAX_CONCURRENT = 4;

/**
 * 生成、更新并回收技能。
 *
 * 实例按类型池化：施放五十次也最多为每个技能构造出少数几个对象，而它们每一个都会在
 * 整个应用的生命周期里一直持有自己的网格与材质。施放过程中不会构建任何东西。
 *
 * `MAX_CONCURRENT` 在各类型之间共享，所以混用技能时被淘汰的是最老的那一次施放，
 * 无论它属于哪个元素。
 */
export class AbilityManager {
    /**
     * @param {object} context 交给每个技能的共享系统：
     *   { scene, camera, environment, particles, lights, decals, bursts, shake, flash }
     */
    constructor(context) {
        this.ctx = context;
        this.active = [];
        this.selected = ELEMENTS[0];

        this.pools = new Map();
        for (const [element, Type] of Object.entries(ABILITY_TYPES)) {
            this.pools.set(
                element,
                new ObjectPool(() => {
                    const ability = new Type(this.ctx);
                    this.ctx.scene.add(ability.group);
                    ability.group.visible = false;
                    return ability;
                })
            );
        }
    }

    select(element) {
        if (!ABILITY_TYPES[element]) return;
        this.selected = element;
    }

    /**
     * 沿一条线施放选中的技能。
     *
     * 远程施放接收同样三个参数，只是从那条线的远端开始工作 —— 这就是加上区域瞄准时
     * 这里什么都不用改的原因。
     *
     * @param {THREE.Vector3} origin    地面上
     * @param {THREE.Vector3} direction 单位向量，水平
     * @param {number} distance         米
     * @returns {import('./Ability.js').Ability|null}
     */
    cast(origin, direction, distance, element = this.selected) {
        if (!ABILITY_TYPES[element]) return null;

        // 淘汰最老的那一次施放，而不是让场景无上限地长大。
        if (this.active.length >= MAX_CONCURRENT) {
            const oldest = this.active.shift();
            oldest.destroy();
            this.pools.get(oldest.element).release(oldest);
        }

        const ability = this.pools.get(element).acquire();
        ability.spawn(origin, direction, distance);
        this.active.push(ability);
        return ability;
    }

    update(dt) {
        for (let i = this.active.length - 1; i >= 0; i--) {
            const ability = this.active[i];
            ability.update(dt);
            if (ability.isFinished) {
                this.active.splice(i, 1);
                ability.destroy();
                this.pools.get(ability.element).release(ability);
            }
        }
    }

    /** 取消当前所有还在飞行中的施放。 */
    clear() {
        for (const ability of this.active) {
            ability.destroy();
            this.pools.get(ability.element).release(ability);
        }
        this.active.length = 0;
    }

    /** 最近一次仍在运行的施放 —— 用来给相机取景。 */
    get focus() {
        for (let i = this.active.length - 1; i >= 0; i--) {
            if (this.active[i].isActive) return this.active[i];
        }
        return null;
    }

    dispose() {
        this.clear();
        for (const pool of this.pools.values()) pool.dispose((ability) => ability.dispose());
        this.pools.clear();
    }
}
