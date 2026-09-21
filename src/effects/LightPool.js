import { PointLight } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

const POOL_SIZE = 6;

/**
 * 一组固定的动态点光源，由所有技能共享。
 *
 * 这些灯只创建一次，并且永远留在场景里——增加或移除一盏灯会改变光照程序
 * 的缓存键，迫使 three 重新编译*每一个*材质，这正是特效生成时卡顿的经典
 * 成因。未被使用的灯只是安静地停在零强度上。
 */
export class LightPool {
    constructor(scene) {
        this.lights = [];
        for (let i = 0; i < POOL_SIZE; i++) {
            const light = new PointLight(0xffffff, 0, 10, 2);
            light.castShadow = false;
            light.intensity = 0;
            light.visible = true;
            scene.add(light);
            this.lights.push({ light, inUse: false, target: 0 });
        }
    }

    /** @returns {object|null} 一个句柄；池子耗尽时为 null */
    acquire() {
        for (const entry of this.lights) {
            if (!entry.inUse) {
                entry.inUse = true;
                entry.target = 0;
                entry.light.intensity = 0;
                return entry;
            }
        }
        return null;
    }

    /**
     * 驱动一个已获取的灯。强度/距离都会向目标值缓动，
     * 因此编辑器改值与技能淡出永远不会突跳。
     */
    set(entry, position, color, intensity, distance, dt) {
        if (!entry) return;
        entry.light.position.copy(position);
        entry.light.color.copy(color);
        entry.target = intensity * settings.global.lightIntensity;
        entry.light.intensity = damp(entry.light.intensity, entry.target, 0.0005, dt);
        entry.light.distance = distance * settings.global.lightRadius;
    }

    release(entry) {
        if (!entry) return;
        entry.inUse = false;
        entry.target = 0;
    }

    /** 让释放的灯淡出，而不是直接切断。 */
    update(dt) {
        for (const entry of this.lights) {
            if (!entry.inUse && entry.light.intensity > 0.001) {
                entry.light.intensity = damp(entry.light.intensity, 0, 0.0001, dt);
            }
        }
    }

    reset() {
        for (const entry of this.lights) {
            entry.inUse = false;
            entry.target = 0;
            entry.light.intensity = 0;
        }
    }

    dispose() {
        for (const entry of this.lights) entry.light.parent?.remove(entry.light);
        this.lights.length = 0;
    }
}
