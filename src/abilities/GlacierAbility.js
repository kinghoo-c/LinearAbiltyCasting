import {
    InstancedMesh,
    InstancedBufferAttribute,
    Mesh,
    PlaneGeometry,
    CylinderGeometry,
    Object3D,
    Vector3,
    Quaternion,
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createGlacierMaterial } from '../materials/GlacierMaterial.js';
import { createFrostFieldMaterial, createFrostVeilMaterial } from '../materials/FrostFieldMaterial.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** 单次施放晶柱数量的硬上限。编辑器的数量滑杆以此为钳制上限。 */
const MAX_SPIKES = 320;
/**
 * 王冠中互不相同的晶体形状数。每一种各自是一个 InstancedMesh——三次绘制
 * 调用换来的是真实的轮廓多样性，这是逐实例缩放单靠自己得不到的，因为差别
 * 在*晶面*上，而不只在比例上。
 */
const VARIANTS = 3;
const SLOTS = Math.ceil(MAX_SPIKES / VARIANTS);
const TAU = Math.PI * 2;

/**
 * 一根晶柱的职责。职责决定它站在哪里、有多高、朝哪边倾，以及——真正撑起
 * 整个施放过程的那部分——它*何时*升起。
 */
const Role = Object.freeze({
    RING: 0, // 边界上的刀锋之墙
    SKIRT: 1, // 堆在墙脚内外两侧的碎裂晶柱
    CORE: 2, // 正中的尖塔——默认关闭，中间保持空旷
});

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();

/** 从 `b` 到 `a` 的最短带符号夹角，弧度，-π..π。 */
function angleDelta(a, b) {
    const d = a - b;
    return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * GLACIAL CROWN（冰川王冠）——第二个**远程施放**，也是从地面里长出来的那一
 * 个。外观参考：`Hud7Xfg3LH.jpg`。
 *
 * Voltaic Snare 用一个立*在*空中的电流牢笼回应一个圆。这一个则用几何体来回
 * 应：一道冷锋沿地面冲向瞄准点，圆盘向外冻结到指示器画出的边界，然后一圈水
 * 晶从地面里*绕着它*撕开而立——一圈向外倾斜的刀锋，内外两侧的墙脚都堆着残
 * 骸裙摆——它立住、闪烁、从边缘呼出寒气，接着一片片碎裂，沉回地面。
 *
 * **中间始终敞开**。每一根晶柱都落在 `zoneRadius` 附近的一条环带里，足迹的
 * 正中央什么都不种，因为这次能力要读的是一堵你正*望进*里面的墙：把圆盘填
 * 满，这圈就不再是圈了。它内部只住着空气——穿过它落下的雪、从冰面升起的闪
 * 粉——以及其下冻住的地面。尖塔作为可调项保留（`coreShare`），但出厂值为
 * 零。
 *
 * 四个节拍，却只有三个阶段：
 *
 *   1. **travel（行进）**——冷锋沿地面奔出，一路铺下霜。
 *   2. **bloom（绽放）**——impact（命中）阶段的头 `snapTime`：冰面向外冻结，
 *      而圆环以一次*扫掠*喷发。离施放者最近的那片刀锋先起，波沿两侧绕行，在
 *      远端会合，于是王冠是合拢而成、而非凭空出现，裙摆则跟在波后面沿墙脚堆
 *      起。
 *   3. **hold（维持）**——`lifetime` 的剩余时间：冰闪烁，一帘冷气从边缘溢
 *      出，雪飘落穿过它，霜沿边界蔓延，迟到的晶柱不断顶着冰面冒出。
 *   4. **collapse（崩塌）**——晶柱由内向外碎成板块，残骸下沉，冰面向中部回暖
 *      融化。
 *
 * 一切皆为程序生成。晶柱是程序化晶体，由 `materials/GlacierMaterial.js` 着
 * 色（冻结前沿与碎裂都归它管），冰面与帘幕是
 * `materials/FrostFieldMaterial.js` 里的两个着色器，雾、碎屑、闪粉和雪则是
 * GPU 粒子。
 *
 * **让编辑器能工作的那条规则。** 一条晶柱记录里除了一堆骰子什么都没有——一
 * 个职责、一个方位角、一个无量纲的径向比例，外加几项抖动。没有一米、一弧度
 * 或一秒被固化下来：圆环的落座、刀锋的高度、倾角、冰面与帘幕全都在更新循环
 * 里对照 `settings.glacier` 现场求解，而这个更新循环在零长度帧上也会跑。拖
 * 动 `zoneRadius` 会重新缩放一顶已经立着的王冠，而时钟是停着的。
 *
 * 记录*确实*固化的只有时间戳——它自己那次喷发被触发的时刻。那些是事件，不是
 * 尺寸。
 */
export class GlacierAbility extends Ability {
    constructor(context) {
        super('glacier', context);
    }

    /* ------------------------------------------------------------------ */
    /* 建造                                                               */
    /* ------------------------------------------------------------------ */

    createShaders() {
        const environment = this.ctx.environment;

        this.material = createGlacierMaterial(environment);

        /** 几何体各控制项的签名，以便只在发生改变时才重建。 */
        this._shapeKey = '';

        this.meshes = [];
        this.seedAttributes = [];
        this.birthAttributes = [];
        this.growAttributes = [];
        this.shatterAttributes = [];

        for (let v = 0; v < VARIANTS; v++) {
            const geometry = this._buildGeometry(v);

            const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
            const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
            const grows = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
            const shatters = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
            for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 10;
            geometry.setAttribute('aSeed', seeds);
            geometry.setAttribute('aBirth', births);
            geometry.setAttribute('aGrow', grows);
            geometry.setAttribute('aShatter', shatters);

            const mesh = new InstancedMesh(geometry, this.material, SLOTS);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            mesh.count = 0;
            // 实心的世界几何体：它隶属于深度预通道（depth prepass），这样雾、雪
            // 和帘幕在与它相交处都能柔和地淡出。
            mesh.layers.set(LAYER.WORLD);
            mesh.renderOrder = 2;
            this.group.add(mesh);

            this.meshes.push(mesh);
            this.seedAttributes.push(seeds);
            this.birthAttributes.push(births);
            this.growAttributes.push(grows);
            this.shatterAttributes.push(shatters);
        }

        /* ---- 地面上的那片冰面 ---- */
        this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
        this.fieldMaterial = createFrostFieldMaterial();
        this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
        this.field.name = 'FrostField';
        this.field.layers.set(LAYER.VFX);
        this.field.renderOrder = 7; // 在贴花之上，晶体之下
        this.field.frustumCulled = false;
        this.field.visible = false;
        this.group.add(this.field);

        /* ---- 立在边界上的冷气帘幕 ---- */
        // 两端开口的单位圆柱：半径 1、高 1、以原点为中心，所以摆放它只是一次
        // 缩放加一次抬高。外张与鼓胀都在着色器里发生。
        this.veilGeometry = new CylinderGeometry(1, 1, 1, 72, 12, true);
        this.veilMaterial = createFrostVeilMaterial();
        this.veil = new Mesh(this.veilGeometry, this.veilMaterial);
        this.veil.name = 'FrostVeil';
        this.veil.layers.set(LAYER.VFX);
        this.veil.renderOrder = 9;
        this.veil.frustumCulled = false;
        this.veil.visible = false;
        this.group.add(this.veil);

        /**
         * 定长记录池——一次施放不分配任何内存。
         *
         * 见类注释：只有骰子，没有尺寸。
         */
        this.records = [];
        for (let i = 0; i < MAX_SPIKES; i++) {
            this.records.push({
                role: Role.SKIRT,
                angle: 0, // 绕中心的方位角，弧度
                radial: 0, // RING：-1..1 落座抖动。SKIRT：0..1 横跨环带。CORE：0..1 向外
                late: false, // 被押后，留到维持阶段才顶起
                rubble: false, // 降级为及踝高的残骸
                heightJitter: 0,
                radiusJitter: 0,
                leanJitter: 0,
                fanJitter: 0, // -1..1 偏离自身半径方向的张开角
                yaw: 0,
                stagger: 0, // 0..1，占该职责散布量的比例
                eruptTime: -1, // 它被触发时的绝对 age，或 -1
                breached: false,
                crumbled: false,
            });
        }

        this._activeCount = 0;
        this._drawn = 0;
        /** 每次施放重新掷一次，这样没有两顶王冠会画出同一个圆环。 */
        this._seed = 0;
        /** 王冠开始张开以来的秒数。只驱动绽放，别的都不管。 */
        this._openTime = 0;
        /** 冷锋到达时的方位角——扫掠的起点。 */
        this._entryAngle = 0;
        this._frostDistance = 0;

        // 每帧交给那两个着色器的临时状态。各一个对象，复用——同步一顶立着的
        // 王冠不分配任何内存。
        this._state = { centre: new Vector3() };
        this._fieldState = { radius: 1, quadSize: 1, freeze: 0, fade: 1, seed: 0 };
        this._veilState = { fade: 1, seed: 0 };
    }

    /** 一种晶体形状。变体索引只用来扰动种子。 */
    _buildGeometry(variant) {
        const c = settings.glacier;
        return createCrystalGeometry({
            seed: 3.9 + variant * 17.3,
            sides: c.facets,
            taper: c.taper,
            roughness: c.roughness,
            bend: c.bend,
        });
    }

    /**
     * 当某个*形状*控制项变动时重建晶体网格。
     *
     * 晶面数、锥化、粗糙度和弯曲无法用逐实例变换来表达，所以它们被烘进几何体
     * ——而一个六棱晶体是 108 个三角形，便宜到可以直接重建，不必在顶点着色器
     * 里近似。正是这一点让它们成为实时滑杆。
     */
    _syncGeometry() {
        const c = settings.glacier;
        const key = `${Math.round(c.facets)}|${c.taper.toFixed(3)}|${c.roughness.toFixed(3)}|${c.bend.toFixed(3)}`;
        if (key === this._shapeKey) return;
        this._shapeKey = key;

        for (let v = 0; v < VARIANTS; v++) {
            const mesh = this.meshes[v];
            const previous = mesh.geometry;
            const geometry = this._buildGeometry(v);
            // 逐实例属性是状态，不是形状——把它们带过去。
            geometry.setAttribute('aSeed', this.seedAttributes[v]);
            geometry.setAttribute('aBirth', this.birthAttributes[v]);
            geometry.setAttribute('aGrow', this.growAttributes[v]);
            geometry.setAttribute('aShatter', this.shatterAttributes[v]);
            mesh.geometry = geometry;
            previous.dispose();
        }
    }

    createParticles() {
        const particles = this.ctx.particles;

        // 从冰上滚落的冷空气。非叠加：它必须能*遮挡*，而正是这一点从外部给了
        // 王冠以深度。
        this.mist = particles.get('glacier.mist', {
            capacity: 3600,
            shape: ParticleShape.SMOKE,
            additive: false,
            curl: true,
            softFade: 1.2,
        });
        this.mist.uniforms.uDrag.value = 2.1;
        this.mist.uniforms.uEndSize.value = 3.6;
        this.mist.uniforms.uSizeIn.value = 0.1;
        this.mist.uniforms.uFadeIn.value = 0.14;
        this.mist.uniforms.uFadeOut.value = 0.28;

        // 晶柱穿透地面时被撕下的碎屑，以及它们碎裂时再次产生的碎屑。
        this.shards = particles.get('glacier.shards', {
            capacity: 3000,
            shape: ParticleShape.CHIP,
            additive: false,
            lit: true,
            softFade: 0.25,
        });
        this.shards.uniforms.uDrag.value = 0.2;
        this.shards.uniforms.uEndSize.value = 0.8;
        this.shards.uniforms.uFadeOut.value = 0.74;

        // 从冰面上扬起的闪粉——与 Frost Lance 的羽流是同一种读感，这里只把它留
        // 在圆环内部。
        this.glitter = particles.get('glacier.glitter', {
            capacity: 3000,
            shape: ParticleShape.SOFT,
            additive: true,
            curl: true,
            softFade: 0.4,
        });
        this.glitter.uniforms.uDrag.value = 1.1;
        this.glitter.uniforms.uEndSize.value = 0.18;
        this.glitter.uniforms.uSizeIn.value = 0.05;
        this.glitter.uniforms.uFadeIn.value = 0.06;
        this.glitter.uniforms.uFadeOut.value = 0.35;

        // 这次能力的招牌系统：冰尘从上方向下*穿过*王冠落下。项目里其他所有系统
        // 都是向上抛的，而圆环内的一场缓降才说明它上方的空气是在结冰，而不是在
        // 燃烧。
        this.snow = particles.get('glacier.snow', {
            capacity: 2600,
            shape: ParticleShape.SOFT,
            additive: true,
            curl: true,
            softFade: 0.5,
        });
        this.snow.uniforms.uDrag.value = 1.6;
        this.snow.uniforms.uEndSize.value = 0.5;
        this.snow.uniforms.uSizeIn.value = 0.08;
        this.snow.uniforms.uFadeIn.value = 0.12;
        this.snow.uniforms.uFadeOut.value = 0.5;

        this.mistEmitter = new RateEmitter();
        this.glitterEmitter = new RateEmitter();
        this.snowEmitter = new RateEmitter();
        this.rimeEmitter = new RateEmitter();
        this.vapourEmitter = new RateEmitter();
        this.ringEmitter = new RateEmitter();
    }

    /* ------------------------------------------------------------------ */
    /* 计时                                                               */
    /* ------------------------------------------------------------------ */

    get instanceCount() {
        return this._drawn;
    }

    /** 王冠先绽放，然后立住。 */
    get impactDuration() {
        return Math.max(0.2, settings.glacier.lifetime * settings.global.lifetime);
    }

    /** 崩塌：一段错开延迟，然后是碎裂与下沉。 */
    get fadeDuration() {
        const c = settings.glacier;
        return Math.max(0.2, c.shatterDelay + c.shatterStagger + c.sinkTime);
    }

    /** 实时足迹半径，米。也就是指示器量出的那个范围。 */
    get radius() {
        return Math.max(0.05, settings.glacier.zoneRadius);
    }

    /* 几何体——每一米都由实时设置解算                                     */
    /* ------------------------------------------------------------------ */

    /** 王冠的中心——瞄准线的远端。 */
    _centrePoint(out) {
        return this.pointAt(1, out).setY(0);
    }

    /** 冷锋离开施放者的位置，世界空间。 */
    _handPoint(out) {
        const c = settings.glacier;
        out.copy(this.origin).addScaledVector(this.direction, c.handForward).addScaledVector(this.side, c.handSide);
        out.y = c.handHeight;
        return out;
    }

    /**
     * 冰面已铺开的程度，0..1，相对边界而言。
     *
     * 它是 `_openTime` 对实时 `snapTime` 的纯函数，所以如果滑杆在施放中途移
     * 动，绽放会自己重新计时。
     */
    _openAmount() {
        const snap = Math.max(0.02, settings.glacier.snapTime);
        return Easing.outCubic(saturate(this._openTime / snap));
    }

    /** 回暖已经吃掉多少冰面，0..1。 */
    _thawAmount() {
        if (this.phase !== AbilityPhase.FADE) return 0;
        const c = settings.glacier;
        const hold = c.shatterDelay * 0.35;
        return saturate((this.fadeTime - hold) / Math.max(0.05, this.fadeDuration - hold));
    }

    /** 在实时足迹设置下，一根晶柱站在哪里。 */
    _spikePosition(record, c, out) {
        const centre = this._state.centre;
        const R = this.radius;
        let r;

        if (record.role === Role.RING) {
            r = R * (c.ringSeat + record.radial * c.ringScatter);
        } else if (record.role === Role.CORE) {
            r = R * c.coreSpread * record.radial;
        } else {
            // 是墙周围的一条环带，不是一个圆盘：王冠的中部要留空，所以残骸是贴着
            // 圆环在其内外两侧堆起，而不是把足迹填满。
            r = R * (c.skirtSeat + Math.pow(record.radial, c.skirtBias) * c.skirtBand);
        }

        return out.set(centre.x + Math.cos(record.angle) * r, 0, centre.z + Math.sin(record.angle) * r);
    }

    /**
     * 一根晶柱的总高度，米。
     *
     * 圆环的高度被它自身方位角的两个谐波调制，谐波按每次施放取种：一堵高度相
     * 同的刀锋墙读起来像栅栏，而高低起伏的冠脊正是让轮廓看起来像是长出来的、
     * 而不是摆上去的主要原因。
     */
    _spikeHeight(record, c, g) {
        let h;

        if (record.role === Role.RING) {
            const wave =
                Math.sin(record.angle * 3 + this._seed) * 0.62 + Math.sin(record.angle * 5 - this._seed * 2.1) * 0.38;
            h = c.ringHeight * (1 + c.ringWave * wave);
        } else if (record.role === Role.CORE) {
            h = c.coreHeight * lerp(1, 0.55, record.radial);
        } else {
            // 在贴着墙处最高，向两侧逐渐变矮，这样裙摆读起来是被圆环顶起来的冰，
            // 而不是第二圈环。
            h = c.skirtHeight * lerp(0.55, 1.2, 1 - Math.abs(record.radial - 0.5) * 2);
        }

        h *= 1 + record.heightJitter * c.heightJitter * g.randomness;
        if (record.rubble) h *= c.rubbleScale;

        return Math.max(0.02, h);
    }

    /** 一根晶柱的底部半径，米。 */
    _spikeRadius(record, c, g) {
        const role = record.role === Role.RING ? 1 : record.role === Role.CORE ? 1.35 : 0.85;
        const jitter = 1 + record.radiusJitter * c.radiusJitter * g.randomness;
        return Math.max(0.01, c.radius * role * jitter * (record.rubble ? 1.3 : 1));
    }

    /** 一根晶柱从中部向外倾的角度，弧度。 */
    _spikeLean(record, c, g) {
        const base = record.role === Role.RING ? c.ringLean : record.role === Role.CORE ? c.coreLean : c.skirtLean;
        return base * (1 + record.leanJitter * c.leanJitter * g.randomness);
    }

    /* 施放                                                               */
    /* ------------------------------------------------------------------ */

    onSpawn() {
        const c = settings.glacier;

        this.mistEmitter.reset();
        this.glitterEmitter.reset();
        this.snowEmitter.reset();
        this.rimeEmitter.reset();
        this.vapourEmitter.reset();
        this.ringEmitter.reset();

        this._frostDistance = 0;
        this._openTime = 0;
        // 除了下面的时间戳之外，一次施放唯一固化的东西。
        this._seed = Math.random() * 100;
        // 扫掠从近侧开始：即从中心反指回施放者的方位角，也正是冷锋到达时的
        // 方位角。
        this._entryAngle = Math.atan2(-this.direction.z, -this.direction.x);

        const wanted = Math.min(MAX_SPIKES, Math.max(1, Math.round(c.spikeCount * c.density)));
        const ringCount = Math.round(wanted * saturate(c.ringShare));
        const coreCount = Math.round(wanted * saturate(c.coreShare));
        const lateCount = Math.round(wanted * saturate(c.lateShare));

        this._activeCount = wanted;

        for (let i = 0; i < wanted; i++) {
            const record = this.records[i];

            record.eruptTime = -1;
            record.breached = false;
            record.crumbled = false;
            record.yaw = Math.random() * TAU;
            record.stagger = Math.random();
            record.heightJitter = randRange(-1, 1);
            record.radiusJitter = randRange(-1, 1);
            record.leanJitter = randRange(-1, 1);
            record.fanJitter = randRange(-1, 1);

            if (i < ringCount) {
                record.role = Role.RING;
                // 绕圆周均匀布点，但步距带抖动，这样墙既没有缺口，又不会看起来像是
                // 盖了个章。
                record.angle = ((i + randRange(-0.4, 0.4)) / Math.max(1, ringCount)) * TAU;
                record.radial = randRange(-1, 1);
                record.rubble = Math.random() < c.rubble * 0.35;
            } else if (i < ringCount + coreCount) {
                record.role = Role.CORE;
                record.angle = Math.random() * TAU;
                record.radial = Math.sqrt(Math.random());
                record.rubble = false;
            } else {
                record.role = Role.SKIRT;
                record.angle = Math.random() * TAU;
                // 在环带内均匀分布。裙摆是圆环带（annulus）而不是圆盘，所以那个能让
                // 圆盘密度均匀的 sqrt() 只会把它往外偏。
                record.radial = Math.random();
                record.rubble = Math.random() < c.rubble;
            }

            // 只有裙摆被押后。把墙也分摊到维持阶段会破坏扫掠，而整个绽放正是建立
            // 在这个读感上的。
            record.late = record.role === Role.SKIRT && i >= wanted - lateCount;
        }

        for (let i = wanted; i < MAX_SPIKES; i++) this.records[i].eruptTime = -1;
        for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
        this._drawn = 0;

        this.field.visible = false;
        this.veil.visible = false;

        this._sync(1);
        this._muzzleFx();
    }

    /**
     * 把每根晶柱升起的时刻交给它。
     *
     * 是时间戳，不是尺寸——与 `IceAbility` 所取的同一份容许。波的形状就是整个
     * 绽放：圆环从近侧绕行一圈，裙摆跟在它后面向外推进，尖塔（如果有）最后升
     * 起，而迟开者散布在整个维持阶段。
     */
    _scheduleEruption() {
        const c = settings.glacier;
        const hold = Math.max(0.2, c.lifetime * settings.global.lifetime);

        for (let i = 0; i < this._activeCount; i++) {
            const record = this.records[i];
            let delay;

            if (record.late) {
                delay = hold * (0.12 + record.stagger * saturate(c.bloomSpread));
            } else if (record.role === Role.RING) {
                // 近侧为 0，远侧为 1——波的两条臂在王冠背后会合。
                const around = Math.abs(angleDelta(record.angle, this._entryAngle)) / Math.PI;
                delay = around * c.sweepTime + record.stagger * c.stagger;
            } else if (record.role === Role.CORE) {
                delay = c.coreDelay + record.stagger * c.stagger;
            } else {
                delay = c.skirtDelay + record.radial * c.skirtWave + record.stagger * c.stagger;
            }

            record.eruptTime = this.age + delay;
        }
    }

    /* 喷发                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * 一根晶柱冒出地面的程度，0 → 1，并带一次有弹性的过冲超过 1。
     * 在它仍埋着等待时返回负数。
     */
    _emergence(record, c) {
        if (record.eruptTime < 0) return -1;
        const elapsed = this.age - record.eruptTime;
        if (elapsed < 0) return -1;

        const riseTime = Math.max(0.02, c.riseTime);
        const rise = Easing.outQuint(saturate(elapsed / riseTime));
        if (elapsed <= riseTime) return rise;

        // 破土这一下会冲过满高再回落稳定。
        const after = elapsed - riseTime;
        const spring = Math.sin(after * 14) * Math.exp(-after / Math.max(0.05, c.settle));
        return 1 + c.riseOvershoot * spring;
    }

    /** 冰沿晶柱自身轴向上结晶了多少，0..1。 */
    _growth(record, c) {
        if (record.eruptTime < 0) return 0;
        const elapsed = this.age - record.eruptTime;
        // 恰好在晶柱升到顶之前完成，这样冻结前沿还在推进时，柱体本身也还在
        // 移动。
        return saturate(elapsed / Math.max(0.02, c.riseTime * 0.85));
    }

    /** 一根晶柱碎裂的程度，0..1。只在崩塌阶段才会非零。 */
    _shatterAmount(record, c) {
        if (this.phase !== AbilityPhase.FADE) return 0;
        const delay = c.shatterDelay + record.stagger * c.shatterStagger;
        return saturate((this.fadeTime - delay) / Math.max(0.05, c.sinkTime));
    }

    /**
     * 依据实时设置重建每一个实例矩阵与逐实例属性。
     */
    _updateSpikes() {
        const c = settings.glacier;
        const g = settings.global;
        const birthFade = Math.max(0.02, c.birthFade);
        const used = [0, 0, 0];

        for (let i = 0; i < this._activeCount; i++) {
            const record = this.records[i];
            const variant = i % VARIANTS;
            const slot = (i / VARIANTS) | 0;
            const emerge = this._emergence(record, c);

            if (emerge < 0) {
                // 仍然埋着。把它停到视野之外，而不是在原点画一个退化的矩阵。
                _dummy.position.set(0, -999, 0);
                _dummy.quaternion.identity();
                _dummy.scale.setScalar(0.0001);
                _dummy.updateMatrix();
                this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
                this.birthAttributes[variant].array[slot] = 0;
                this.growAttributes[variant].array[slot] = 0;
                this.shatterAttributes[variant].array[slot] = 0;
                used[variant] = Math.max(used[variant], slot + 1);
                continue;
            }

            const height = this._spikeHeight(record, c, g);
            const radius = this._spikeRadius(record, c, g);
            const shatter = this._shatterAmount(record, c);

            /* --- 破出表面时的碎屑，以及碎裂时再次产生的碎屑 --- */
            if (!record.breached && emerge > 0.22) {
                record.breached = true;
                this._breachFx(record, c, g, radius);
            }
            if (!record.crumbled && shatter > 0.12) {
                record.crumbled = true;
                this._crumbleFx(record, c, g, radius, height);
            }

            /* --- 倾角：向外抛，并从自身半径方向扇开 --- */
            // 正是这个扇开让墙成为星芒而不是一排栅栏：相邻的刀锋在它们所处的半径
            // 两侧各自张开，于是倒下时会在彼此前面交错。
            const bearing = record.angle + record.fanJitter * c.fan;
            _lean.set(Math.cos(bearing), 0, Math.sin(bearing));
            if (_lean.lengthSq() < 1e-6) _lean.copy(this.direction);
            _lean.normalize();

            // 绕 (up × lean) 旋转会把晶体自身的 +Y 掰向 `lean`。
            _axis.crossVectors(_up, _lean).normalize();
            _tilt.setFromAxisAngle(_axis, this._spikeLean(record, c, g));
            _spin.setFromAxisAngle(_up, record.yaw * c.twist);
            _tilt.multiply(_spin);

            /* --- 把它从地面里滑上来，崩碎时再把它放回去 --- */
            const settled = Math.min(1, emerge);
            this._spikePosition(record, c, _dummy.position);
            _dummy.position.y = (emerge - 1) * height * 0.9;
            if (shatter > 0) {
                _dummy.position.y -= Easing.inCubic(shatter) * (height * 0.45 + radius + 0.3);
            }

            _dummy.quaternion.copy(_tilt);
            _dummy.scale.set(radius, height, radius).multiplyScalar(lerp(0.86, 1, settled));
            _dummy.updateMatrix();

            this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
            this.birthAttributes[variant].array[slot] = saturate(1 - (this.age - record.eruptTime) / birthFade);
            this.growAttributes[variant].array[slot] = this._growth(record, c);
            this.shatterAttributes[variant].array[slot] = shatter;
            used[variant] = Math.max(used[variant], slot + 1);
        }

        this._drawn = 0;
        for (let v = 0; v < VARIANTS; v++) {
            this.meshes[v].count = used[v];
            this.meshes[v].instanceMatrix.needsUpdate = true;
            this.birthAttributes[v].needsUpdate = true;
            this.growAttributes[v].needsUpdate = true;
            this.shatterAttributes[v].needsUpdate = true;
            this._drawn += used[v];
        }
    }

    /* ------------------------------------------------------------------ */
    /* 反馈                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * 把实时设置与当前施放状态推给晶体材质、冰面、帘幕以及四个粒子系统。
     *
     * @param {number} fade 王冠立着时为 1，随着它消散渐变到 0
     */
    _sync(fade) {
        const c = settings.glacier;
        const g = settings.global;
        const travelling = this.phase === AbilityPhase.TRAVEL;

        this._centrePoint(this._state.centre);
        this._syncGeometry();
        this.material.userData.sync();

        const centre = this._state.centre;
        const radius = this.radius;
        const open = travelling ? 0 : this._openAmount();
        const thaw = this._thawAmount();
        const freeze = open * (1 - thaw);

        /* --- 冰面 --- */
        const fieldState = this._fieldState;
        fieldState.radius = radius;
        fieldState.quadSize = (radius + c.fieldBoundary + 0.8) * 2;
        fieldState.freeze = freeze;
        fieldState.fade = fade;
        fieldState.seed = this._seed;
        this.fieldMaterial.userData.sync(fieldState);

        this.field.visible = !travelling && freeze > 0.002 && fade > 0.002;
        this.field.position.set(centre.x, c.fieldHeight, centre.z);
        this.field.scale.set(fieldState.quadSize, 1, fieldState.quadSize);

        /* --- 帘幕 --- */
        const veilHeight = Math.max(0.05, c.veilHeight * Easing.outCubic(open));
        const veilState = this._veilState;
        veilState.fade = fade * (1 - thaw);
        veilState.seed = this._seed;
        this.veilMaterial.userData.sync(veilState);

        this.veil.visible = !travelling && c.veil > 0.001 && open > 0.02 && veilState.fade > 0.004;
        this.veil.position.set(centre.x, veilHeight * 0.5, centre.z);
        this.veil.scale.set(radius * c.veilRadius, veilHeight, radius * c.veilRadius);
        this.veil.rotation.y = this._seed + this.age * c.veilSpin * TAU;

        /* --- 四个粒子系统 --- */
        this.mist.setGradient(
            getColor(c.colorMistA),
            getColor(c.colorMistB),
            getColor(c.colorMistC),
            getColor(c.colorMistD)
        );
        this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
        this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
        this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
        this.mist.uniforms.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
        this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
        this.mist.uniforms.uTurbulence.value = c.mistTurbulence * g.turbulence;

        this.shards.setGradient(
            getColor(c.colorShardA),
            getColor(c.colorShardB),
            getColor(c.colorShardC),
            getColor(c.colorShardD)
        );
        this.shards.uniforms.uGravity.value.set(0, c.shardGravity, 0);
        this.shards.uniforms.uSizeScale.value = c.shardSize * g.particleSize * 7;
        this.shards.uniforms.uLifeScale.value = g.particleLifetime;
        this.shards.uniforms.uSpeedScale.value = g.particleSpeed;
        this.shards.uniforms.uOpacity.value = g.opacity;

        this.glitter.setGradient(
            getColor(c.colorGlitterA),
            getColor(c.colorGlitterB),
            getColor(c.colorGlitterC),
            getColor(c.colorGlitterD)
        );
        this.glitter.uniforms.uGravity.value.set(0, c.glitterRise, 0);
        this.glitter.uniforms.uSizeScale.value = c.glitterSize * g.particleSize * 7;
        this.glitter.uniforms.uLifeScale.value = c.glitterLifetime * 0.5 * g.particleLifetime;
        this.glitter.uniforms.uSpeedScale.value = g.particleSpeed;
        this.glitter.uniforms.uOpacity.value = g.opacity;
        this.glitter.uniforms.uGlow.value = c.glitterGlow * g.glow;
        this.glitter.uniforms.uTurbulence.value = c.glitterTurbulence * g.turbulence;

        this.snow.setGradient(
            getColor(c.colorSnowA),
            getColor(c.colorSnowB),
            getColor(c.colorSnowC),
            getColor(c.colorSnowD)
        );
        // 负值：这是项目里唯一一个在下落的系统。
        this.snow.uniforms.uGravity.value.set(0, c.snowFall, 0);
        this.snow.uniforms.uSizeScale.value = c.snowSize * g.particleSize * 7;
        this.snow.uniforms.uLifeScale.value = c.snowLifetime * 0.5 * g.particleLifetime;
        this.snow.uniforms.uSpeedScale.value = g.particleSpeed;
        this.snow.uniforms.uOpacity.value = g.opacity;
        this.snow.uniforms.uGlow.value = c.snowGlow * g.glow;
        this.snow.uniforms.uTurbulence.value = c.snowTurbulence * g.turbulence;
    }

    /** 冷锋离开时，施放者手上的那一团气。 */
    _muzzleFx() {
        const c = settings.glacier;
        const g = settings.global;

        this._handPoint(_pos);

        this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
            radius: c.muzzleSize * 0.25,
            endRadius: c.muzzleSize * g.explosionIntensity,
            life: 0.45,
            intensity: c.muzzleIntensity,
            opacity: 0.75,
            fresnel: 1.4,
            displace: 0.5,
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstB),
            colorC: getColor(c.colorBurstC),
        });

        _emit.position = _pos;
        _emit.radius = 0.18;
        _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(0.4).normalize();
        _emit.speed = c.shardSpeed * 0.9;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.85;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.12;
        _emit.sizeVariance = 0.7;
        _emit.life = c.shardLifetime * 0.8;
        _emit.lifeVariance = 0.5;
        _emit.spin = 7;
        _emit.tint = null;
        _emit.time = frame.uTime.value;
        this.shards.emit(Math.round(20 * g.particleCount), _emit);

        _emit.speed = c.glitterSpeed * 0.8;
        _emit.spread = 0.9;
        _emit.size = 0.09;
        _emit.life = c.glitterLifetime * 0.7;
        _emit.spin = 0;
        this.glitter.emit(Math.round(30 * g.particleCount), _emit);

        this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
    }

    /** 冷锋冲出去时，沿路铺在其下方的雾、闪粉与霜。 */
    _frontFx(dt) {
        const c = settings.glacier;
        const g = settings.global;
        const time = frame.uTime.value;

        /* --- 从冻结的地面上翻腾起来的雾 --- */
        const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * 0.5) * g.particleCount);
        if (mistCount > 0) {
            _emit.position = _pos.copy(this.position).setY(0.12);
            _emit.radius = 0.5;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.mistSpeed;
            _emit.speedVariance = 0.7;
            _emit.spread = 1.0;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.7;
            _emit.sizeVariance = 0.5;
            _emit.life = c.mistLifetime * 0.8;
            _emit.lifeVariance = 0.4;
            _emit.spin = 0.5;
            _emit.tint = null;
            _emit.time = time;
            this.mist.emit(mistCount, _emit);
        }

        /* --- 从裂口处扬起的闪粉 --- */
        const glitterCount = Math.round(this.glitterEmitter.tick(dt, c.glitterRate * 0.4) * g.particleCount);
        if (glitterCount > 0) {
            _emit.position = _pos.copy(this.position).setY(0.3);
            _emit.radius = 0.4;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.glitterSpeed;
            _emit.speedVariance = 0.8;
            _emit.spread = 0.85;
            _emit.size = 0.08;
            _emit.sizeVariance = 0.6;
            _emit.life = c.glitterLifetime * 0.8;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.time = time;
            this.glitter.emit(glitterCount, _emit);
        }

        /* --- 冷锋掠过时铺在地面上的霜 --- */
        const frostStep = 1 / Math.max(0.05, c.trailFrostRate);
        while (this.front - this._frostDistance >= frostStep) {
            this._frostDistance += frostStep;
            const s = saturate(this._frostDistance / this.length);
            this.pointAt(s, _pos);
            _pos.x += this.side.x * randRange(-0.9, 0.9);
            _pos.z += this.side.z * randRange(-0.9, 0.9);

            this.ctx.decals.spawn(DecalType.FROST, _pos, {
                radius: c.trailFrostRadius * randRange(0.55, 1.1),
                life: c.frostLife * 0.8,
                width: c.frostCrystals,
                intensity: c.frostIntensity,
                colorA: getColor(c.colorFrost),
                colorB: getColor(c.colorFrostEdge),
            });
        }
    }

    /** 晶柱破出表面处的一片碎屑与一团气。 */
    _breachFx(record, c, g, radius) {
        const time = frame.uTime.value;

        this._spikePosition(record, c, _pos).setY(0.08);

        _emit.position = _pos;
        _emit.radius = radius * 0.9;
        // 碎屑向外抛，远离王冠中部——与晶柱自身倾斜的方向一致。
        _emit.direction = _dir.set(Math.cos(record.angle) * 0.55, 1, Math.sin(record.angle) * 0.55).normalize();
        _emit.speed = c.shardSpeed;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.7;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.1;
        _emit.sizeVariance = 0.7;
        _emit.life = c.shardLifetime;
        _emit.lifeVariance = 0.45;
        _emit.spin = 7;
        _emit.tint = null;
        _emit.time = time;
        this.shards.emit(Math.round(c.breachShards * g.particleCount), _emit);

        // 只让一部分晶柱冒气：几百根同时冒蒸汽会把王冠埋进霾里，遮住那正是全部
        // 意义的轮廓。
        if (Math.random() < 0.35) {
            _emit.speed = c.mistSpeed * 0.8;
            _emit.spread = 1.0;
            _emit.size = 0.55;
            _emit.sizeVariance = 0.5;
            _emit.life = c.mistLifetime * 0.7;
            _emit.spin = 0.5;
            this.mist.emit(Math.round(2 * g.particleCount), _emit);
        }

        // 在环上刀锋的脚下围一圈霜，这样墙是坐在地面上，而不是插穿地面。
        if (record.role === Role.RING && Math.random() < 0.5) {
            this._spikePosition(record, c, _pos);
            this.ctx.decals.spawn(DecalType.FROST, _pos, {
                radius: radius * c.frostCollar * randRange(0.7, 1.3),
                life: c.frostLife,
                width: c.frostCrystals,
                intensity: c.frostIntensity * 0.9,
                colorA: getColor(c.colorFrost),
                colorB: getColor(c.colorFrostEdge),
            });
        }
    }

    /** 晶柱开始解体时迸出的一堆板片。 */
    _crumbleFx(record, c, g, radius, height) {
        const time = frame.uTime.value;

        this._spikePosition(record, c, _pos).setY(height * 0.45);

        _emit.position = _pos;
        _emit.radius = radius * 1.1;
        _emit.direction = _dir.set(Math.cos(record.angle) * 0.7, 0.7, Math.sin(record.angle) * 0.7).normalize();
        _emit.speed = c.shardSpeed * 0.75;
        _emit.speedVariance = 0.85;
        _emit.spread = 0.9;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.13;
        _emit.sizeVariance = 0.8;
        _emit.life = c.shardLifetime * 1.2;
        _emit.lifeVariance = 0.5;
        _emit.spin = 9;
        _emit.tint = null;
        _emit.time = time;
        this.shards.emit(Math.round(c.shatterShards * g.particleCount), _emit);

        if (Math.random() < 0.5) {
            _emit.speed = c.glitterSpeed * 0.6;
            _emit.spread = 1.0;
            _emit.size = 0.07;
            _emit.life = c.glitterLifetime;
            _emit.spin = 0;
            this.glitter.emit(Math.round(6 * g.particleCount), _emit);
        }
    }

    /**
     * 立着的王冠所洒下的一切：从边缘溢出的寒气、穿过中部的雪、从冰面升起的闪
     * 粉、沿边界蔓延的霜、从墙上剥落的蒸汽壳，以及横过地面的压力环。
     *
     * @param {number} scale 0..1——随王冠崩塌而逐渐稀疏
     */
    _fieldFx(dt, scale) {
        const c = settings.glacier;
        const g = settings.global;
        const time = frame.uTime.value;
        const centre = this._state.centre;
        const radius = this.radius;
        const open = this._openAmount();

        /* --- 从边缘倾泻而出、铺过地面的冷空气 --- */
        const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
        if (mistCount > 0) {
            const a = Math.random() * TAU;
            const r = radius * randRange(0.75, 1.05);
            _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.5), centre.z + Math.sin(a) * r);
            _emit.position = _pos;
            _emit.radius = radius * 0.18;
            // 向外、几乎不上升：这是从冰墙上沉下来的重空气，不是从火上升起的烟。
            _emit.direction = _dir.set(Math.cos(a), 0.18, Math.sin(a)).normalize();
            _emit.speed = c.mistSpeed;
            _emit.speedVariance = 0.7;
            _emit.spread = 0.6;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.85;
            _emit.sizeVariance = 0.5;
            _emit.life = c.mistLifetime;
            _emit.lifeVariance = 0.4;
            _emit.spin = 0.4;
            _emit.tint = null;
            _emit.time = time;
            this.mist.emit(mistCount, _emit);
        }

        /* --- 从冰面升起的闪粉 --- */
        const glitterCount = Math.round(this.glitterEmitter.tick(dt, c.glitterRate * scale) * g.particleCount);
        if (glitterCount > 0) {
            const a = Math.random() * TAU;
            const r = radius * Math.sqrt(Math.random());
            _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.6), centre.z + Math.sin(a) * r);
            _emit.position = _pos;
            _emit.radius = radius * 0.15;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.glitterSpeed;
            _emit.speedVariance = 0.8;
            _emit.spread = 0.8;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.08;
            _emit.sizeVariance = 0.6;
            _emit.life = c.glitterLifetime;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;
            this.glitter.emit(glitterCount, _emit);
        }

        /* --- 以及穿过它落回的冰尘 --- */
        const snowCount = Math.round(this.snowEmitter.tick(dt, c.snowRate * scale) * g.particleCount);
        if (snowCount > 0) {
            const a = Math.random() * TAU;
            const r = radius * c.snowInset * Math.sqrt(Math.random());
            _pos.set(centre.x + Math.cos(a) * r, c.ringHeight * c.snowHeight * open, centre.z + Math.sin(a) * r);
            _emit.position = _pos;
            _emit.radius = radius * 0.25;
            _emit.direction = _dir.set(0, -1, 0);
            _emit.speed = c.snowSpeed;
            _emit.speedVariance = 0.6;
            _emit.spread = 0.5;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.07;
            _emit.sizeVariance = 0.7;
            _emit.life = c.snowLifetime;
            _emit.lifeVariance = 0.45;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;
            this.snow.emit(snowCount, _emit);
        }

        /* --- 沿边界蔓延的霜 --- */
        const rimeCount = this.rimeEmitter.tick(dt, c.rimeRate * scale);
        for (let i = 0; i < rimeCount; i++) {
            const a = Math.random() * TAU;
            const r = radius * randRange(0.7, 1.05);
            _pos.set(centre.x + Math.cos(a) * r, 0, centre.z + Math.sin(a) * r);
            this.ctx.decals.spawn(DecalType.FROST, _pos, {
                radius: c.rimeRadius * randRange(0.7, 1.3),
                life: c.frostLife,
                width: c.frostCrystals,
                intensity: c.frostIntensity,
                colorA: getColor(c.colorFrost),
                colorB: getColor(c.colorFrostEdge),
            });
        }

        /* --- 从墙上剥落的蒸汽壳 --- */
        // 刻意压低并压扁：在刀锋半高处释放的壳会像一顶玻璃穹顶挂在空中，需要它
        // 底下有地面，才能读成从冰上冒出的寒气，而不是一个停驻在半空的泡泡。
        const vapourCount = this.vapourEmitter.tick(dt, c.vapourRate * scale);
        for (let i = 0; i < vapourCount; i++) {
            const a = Math.random() * TAU;
            _pos.set(
                centre.x + Math.cos(a) * radius * randRange(0.5, 0.95),
                c.ringHeight * randRange(0.05, 0.3) * open,
                centre.z + Math.sin(a) * radius * randRange(0.5, 0.95)
            );
            this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
                radius: c.vapourSize * 0.3,
                endRadius: c.vapourSize * g.explosionIntensity,
                life: 0.75,
                intensity: c.vapourIntensity,
                opacity: 0.28,
                fresnel: 1.8,
                displace: 0.55,
                squash: 0.5,
                colorA: getColor(c.colorBurstA),
                colorB: getColor(c.colorBurstB),
                colorC: getColor(c.colorBurstC),
            });
        }

        /* --- 被推着横过地面的压力环 --- */
        const ringCount = this.ringEmitter.tick(dt, c.ringRate * scale);
        for (let i = 0; i < ringCount; i++) {
            this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
                radius: radius * 1.08,
                life: 0.8,
                width: 0.05,
                intensity: 0.55,
                colorA: getColor(c.colorShockA),
                colorB: getColor(c.colorShockB),
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* 阶段                                                               */
    /* ------------------------------------------------------------------ */

    onTravel(dt) {
        this._sync(1);
        this._updateSpikes();

        // 灯光跟着冷锋走，略微离地。
        this.position.y = 0.35;

        this._frontFx(dt);
        this.ctx.shake.rumble(settings.glacier.rumble * settings.global.cameraShake, dt);
    }

    onImpact() {
        const c = settings.glacier;
        const g = settings.global;
        const time = frame.uTime.value;

        this._openTime = 0;
        this._scheduleEruption();
        this._centrePoint(_pos);
        _pos.y = 0.5;

        /* 冰面向外炸开时抛出的冻结蒸汽壳 */
        this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
            radius: c.burstSize * 0.25,
            endRadius: c.burstSize * g.explosionIntensity,
            life: 0.9,
            intensity: c.burstIntensity,
            opacity: 0.8,
            fresnel: 1.4,
            displace: 0.6,
            squash: 0.6,
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstB),
            colorC: getColor(c.colorBurstC),
        });

        /* 沿地面向外炸开、越过边界的那道环 */
        this._centrePoint(_pos);
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
            radius: c.shockRadius * g.explosionIntensity,
            life: 0.8,
            width: 0.05,
            intensity: 1.0,
            colorA: getColor(c.colorShockA),
            colorB: getColor(c.colorShockB),
        });

        /* 王冠落座其上的那片霜面 */
        this.ctx.decals.spawn(DecalType.FROST, _pos, {
            radius: this.radius * c.frostSpread,
            life: c.frostLife * 1.4,
            width: c.frostCrystals,
            intensity: c.frostIntensity,
            colorA: getColor(c.colorFrost),
            colorB: getColor(c.colorFrostEdge),
        });

        /* 绽放时炸出的碎屑、雾与闪粉 */
        this._centrePoint(_pos).setY(0.4);
        _emit.position = _pos;
        _emit.radius = this.radius * 0.5;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.shardSpeed * 1.7;
        _emit.speedVariance = 0.8;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.15;
        _emit.sizeVariance = 0.8;
        _emit.life = c.shardLifetime * 1.3;
        _emit.lifeVariance = 0.5;
        _emit.spin = 9;
        _emit.tint = null;
        _emit.time = time;
        this.shards.emit(Math.round(c.burstShards * g.particleCount), _emit);

        _emit.radius = this.radius * 0.8;
        _emit.speed = c.mistSpeed * 2.2;
        _emit.spread = 1.0;
        _emit.size = 1.3;
        _emit.life = c.mistLifetime * 1.3;
        _emit.spin = 0.6;
        this.mist.emit(Math.round(c.burstMist * g.particleCount), _emit);

        _emit.radius = this.radius * 0.6;
        _emit.speed = c.glitterSpeed * 1.5;
        _emit.spread = 0.9;
        _emit.size = 0.1;
        _emit.life = c.glitterLifetime * 1.2;
        _emit.spin = 0;
        this.glitter.emit(Math.round(c.burstGlitter * g.particleCount), _emit);

        this.ctx.shake.add(
            c.impactShake * g.explosionIntensity * g.cameraShake,
            1 / Math.max(0.1, c.shakeDuration),
            21
        );
        this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
    }

    onFade(dt, t) {
        const c = settings.glacier;
        this._openTime += dt;

        // `t` 在王冠立着时从 0 走到 1，然后在它崩塌时从 1 走到 2。冰面与帘幕由
        // `_sync` 里的回暖带走，所以这里的 fade 只需要把最后一点不透明度也一起
        // 带走。
        const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

        this._sync(fade);
        this._updateSpikes();

        // 灯光爬进王冠里，停在那里。
        this._centrePoint(this.position);
        this.position.y = c.ringHeight * saturate(c.lightHeight) * this._openAmount();

        this._fieldFx(dt, fade * (t <= 1 ? 1 : 0.35));
        this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
    }

    onDestroy() {
        this._activeCount = 0;
        this._drawn = 0;
        for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
        this.field.visible = false;
        this.veil.visible = false;
    }

    dispose() {
        for (const mesh of this.meshes) {
            mesh.geometry.dispose();
            mesh.dispose();
        }
        this.material.dispose();
        this.fieldGeometry.dispose();
        this.fieldMaterial.dispose();
        this.veilGeometry.dispose();
        this.veilMaterial.dispose();
        super.dispose();
    }
}
