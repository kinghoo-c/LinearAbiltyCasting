import { InstancedMesh, InstancedBufferAttribute, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createMeteorMaterial } from '../materials/MeteorMaterial.js';
import { VolumetricFireMaterial, fireHullReach } from '../materials/VolumetricFireMaterial.js';
import { createAsteroidGeometry } from '../assets/ProceduralGeometry.js';
import { RibbonGeometry, RibbonMode } from '../effects/RibbonGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** 碎块数量的硬上限。编辑器里的 `chunkCount` 滑块最多拉到这里。 */
const MAX_CHUNKS = 28;
/** 实例 0 是陨石本身；1.. 是它炸开后形成的碎块。 */
const SLOTS = MAX_CHUNKS + 1;
/** 一帧的行程中，粒子拖尾被分摊到多少个点上。 */
const TRAIL_BATCHES = 3;
/**
 * 沿火焰代理外壳中心线的采样点数。拖尾是*从*弧线*推导*出来的，而不是逐帧记录
 * 下来的，所以这个数字纯粹只决定外壳被细分成多密。
 */
const TRAIL_NODES = 48;
const TAU = Math.PI * 2;

/**
 * 沿气流方向的半径分布，0 = 尾端，1 = 头端，单位是 `trailWidth` 的倍数。
 * 必须与 VolumetricFireMaterial 里的 `flameProfile()` 保持同步——JS 这一侧
 * 决定代理外壳的尺寸，着色器那一侧塑造真正的体积，而外壳必须能把它包住。
 */
function radiusProfile(u, headSize, wakeSpread) {
    const body = (0.34 + 0.66 * Math.pow(u, 0.55)) * (1 + wakeSpread * Math.pow(1 - u, 1.8));
    return body * (1 + (headSize - 1) * smoothstep(0.62, 1, u));
}

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _back = new Vector3();
const _heading = new Vector3();
const _impact = new Vector3();
const _ahead = new Vector3();
const _behind = new Vector3();
const _axis = new Vector3();
const _dummy = new Object3D();
const _spin = new Quaternion();

/**
 * METEOR——一颗沿瞄准方向掷出的燃烧岩块，抵达时引爆。
 *
 * 一拍到底，而且有真正的助跑感：一颗小行星岩球离开施法者的手，沿弧线抛向
 * 远方，一路上不断升温——熔岩裂缝随着它逼近越裂越宽、越裂越亮，所以那场
 * 爆炸是你亲眼看着它飞过来的。它落地、炸开，把自己的碎块抛撒过整个地面，
 * 碎块就躺在那里冷却，与此同时弹坑烧尽。
 *
 * 一切都是程序生成的：岩块是程序化几何体，它的着色是一份打过补丁的标准材质
 * （因此它会接收舞台的阴影和探针），从它身上流出的火焰是在一个面向相机的
 * 代理外壳内部做光线步进的黑体体积，而余烬、火花、烟雾和砂砾都是 GPU 粒子。
 * 没有任何东西从磁盘加载，也没有任何东西是一张贴图。
 *
 * **让编辑器得以工作的规则。** `IceAbility` 保存的尖刺记录里除了掷骰子什么
 * 都没有；这里也一样。一次施放只捕获一个种子、一根翻滚轴，以及每块碎屑几个
 * 无量纲的随机值——一个方位角、一个仰角、一个速度抖动。没有一个米、弧度或秒。
 * 弹道、岩块的尺寸、裂缝的宽度、碎屑被抛出的力度以及它冷却的速度，全部在
 * update 循环里对照 `settings.meteor` 实时求解，零长度的一帧也不例外。拖动
 * `arc` 会连同制造它的岩块一起重新放样一颗已经在空中的陨石，拖动 `chunkSpeed`
 * 会重新抛掷已经落地的碎屑。
 *
 * 碎块之所以用弹道公式而不是积分，正是出于这个原因：位置是自撞击以来时间的
 * 闭式函数，所以改这些数字会重写整段飞行，而不只是改变接下来发生的事。
 */
export class MeteorAbility extends Ability {
    constructor(context) {
        super('meteor', context);
    }

    /* ------------------------------------------------------------------ */
    /* 构建                                                               */
    /* ------------------------------------------------------------------ */

    createShaders() {
        this.material = createMeteorMaterial(this.ctx.environment);

        /** 几何类控件组成的签名，这样只有真正变化时才重建。 */
        this._shapeKey = '';
        this.geometry = this._buildGeometry();

        this.seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
        this.heats = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
        for (let i = 0; i < SLOTS; i++) this.seeds.array[i] = Math.random() * 10;
        this.geometry.setAttribute('aSeed', this.seeds);
        this.geometry.setAttribute('aHeat', this.heats);

        // 陨石*和*它的碎块共用一个实例化网格：同一块岩石、同一套着色、一次绘制
        // 调用，碎块之间只差一个 `aSeed`，它偏移裂缝场，因此没有两块碎块裂得一样。
        this.rock = new InstancedMesh(this.geometry, this.material, SLOTS);
        this.rock.castShadow = true;
        this.rock.receiveShadow = true;
        this.rock.frustumCulled = false;
        this.rock.count = 0;
        // 实体世界几何：它该进深度预通道，这样烟雾和余烬在与它相交的地方会柔和淡出。
        this.rock.layers.set(LAYER.WORLD);
        this.rock.renderOrder = 2;
        this.group.add(this.rock);

        /*
         * 火焰拖尾：沿岩块身后那一段弧线的燃烧体积。
         *
         * 下面这个网格*不是*火焰本身。它只是套在飞行路径外的一层面向相机的代理
         * 外壳；`VolumetricFireMaterial` 会逐片元地依据缎带的 `aCenter` / `aTangent`
         * 重建弧线的局部坐标架，从相机射出一条光射线，并对那个文件里描述的场积分
         * 发射与烟炱吸收。外壳唯一的职责就是*包住*这个体积——保证这一点的外扩量
         * 见 `_updateTrail`。
         *
         * 中心线是*从* `_arcPoint` *推导*出来的，而不是记录下来的，所以拖尾是弹道
         * 设置的实时函数：拖动 `arc` 会连同制造它的岩块一起，重新放样已经在空中的
         * 火焰。
         *
         * 在采样窗口之外还有两个点用于外扩外壳，好让体积的端盖也被几何体覆盖，
         * 这就是段预算上那个 `+ 2` 的由来。
         */
        this.ribbon = new RibbonGeometry(TRAIL_NODES + 2, { frame: true });
        this.trailPoints = [];
        for (let i = 0; i <= TRAIL_NODES; i++) this.trailPoints.push(new Vector3());
        this.hullPoints = [];
        for (let i = 0; i <= TRAIL_NODES + 2; i++) this.hullPoints.push(new Vector3());
        this.trailCount = 0;

        this.trailMaterial = new VolumetricFireMaterial();
        this.trailMesh = new Mesh(this.ribbon.geometry, this.trailMaterial);
        this.trailMesh.frustumCulled = false;
        this.trailMesh.matrixAutoUpdate = false;
        this.trailMesh.layers.set(LAYER.VFX);
        // 排在不做加性混合的烟雾（10）之后，好让烟羽能遮挡它；排在加性粒子（12）
        // 之前，这样挡在前面的余烬不会被它的吸收压暗。
        this.trailMesh.renderOrder = 11;
        this.group.add(this.trailMesh);

        /**
         * 固定大小的记录池——一次撞击不产生任何分配。
         *
         * 见类注释：只有骰子，没有尺寸。
         */
        this.chunks = [];
        for (let i = 0; i < MAX_CHUNKS; i++) {
            this.chunks.push({
                angle: 0, // 抛射物的方位角，弧度
                elevation: 0, // 抛射锥的 0..1
                speed: 0, // 0..1 速度抖动
                size: 0, // 0..1 尺寸抖动
                spin: 0, // -1..1 翻滚速率
                spinAxis: new Vector3(0, 1, 0),
            });
        }

        this._chunkCount = 0;
        this._used = 0;
        this._seed = 0;
        this._tumbleAxis = new Vector3(0, 1, 0);
        /** 上一帧拖尾铺到了线上的哪个位置。 */
        this._lastU = 0;
    }

    /** 岩块本身。当*形状*类控件变化时重建——见 `_syncGeometry`。 */
    _buildGeometry() {
        const c = settings.meteor;
        return createAsteroidGeometry({
            seed: 11.7,
            detail: c.facets,
            lumpiness: c.lumpiness,
            noiseScale: c.lumpScale,
            roughness: c.surfaceRoughness,
            cuts: c.cuts,
            cutDepth: c.cutDepth,
            craters: c.craters,
            craterDepth: c.craterDepth,
            craterSize: c.craterSize,
        });
    }

    /**
     * 当*形状*类控件变化时重新生成岩块。
     *
     * 凹凸、断裂切面和环形山都会真实地位移顶点，所以它们没法在顶点着色器里
     * 造假——轮廓、平整的刻面以及阴影都必须看见它们。细分 3 级的小行星是 1280
     * 个三角形，重建一次的代价足够低，这正是那九个控件能保持实时生效的原因。
     */
    _syncGeometry() {
        const c = settings.meteor;
        const key = [
            Math.round(c.facets),
            c.lumpiness.toFixed(3),
            c.lumpScale.toFixed(3),
            c.surfaceRoughness.toFixed(3),
            Math.round(c.cuts),
            c.cutDepth.toFixed(3),
            Math.round(c.craters),
            c.craterDepth.toFixed(3),
            c.craterSize.toFixed(3),
        ].join('|');
        if (key === this._shapeKey) return;
        this._shapeKey = key;

        const previous = this.geometry;
        this.geometry = this._buildGeometry();
        // 逐实例属性是状态而不是形状——把它们带过去。
        this.geometry.setAttribute('aSeed', this.seeds);
        this.geometry.setAttribute('aHeat', this.heats);
        this.rock.geometry = this.geometry;
        previous.dispose();
    }

    createParticles() {
        const particles = this.ctx.particles;

        // 从岩块上流出的余烬。有浮力，所以拖尾会上升并悬停。
        this.embers = particles.get('meteor.embers', {
            capacity: 4000,
            shape: ParticleShape.SOFT,
            additive: true,
            curl: true,
            softFade: 0.4,
        });
        this.embers.uniforms.uDrag.value = 1.2;
        this.embers.uniforms.uEndSize.value = 0.06;
        this.embers.uniforms.uSizeIn.value = 0.05;
        this.embers.uniforms.uFadeIn.value = 0.05;
        this.embers.uniforms.uFadeOut.value = 0.3;

        // 火花：在重力下被速度拉伸成条痕。
        this.sparks = particles.get('meteor.sparks', {
            capacity: 3000,
            shape: ParticleShape.STREAK,
            additive: true,
            stretch: true,
            softFade: 0.25,
        });
        this.sparks.uniforms.uDrag.value = 0.7;
        this.sparks.uniforms.uEndSize.value = 0.25;
        this.sparks.uniforms.uSizeIn.value = 0.02;
        this.sparks.uniforms.uFadeOut.value = 0.5;

        // 烟柱。不做加性混合：它必须*遮挡*，正是这一点给了拖尾和弹坑以深度。
        this.smoke = particles.get('meteor.smoke', {
            capacity: 2600,
            shape: ParticleShape.SMOKE,
            additive: false,
            curl: true,
            softFade: 1.2,
        });
        this.smoke.uniforms.uDrag.value = 1.7;
        this.smoke.uniforms.uEndSize.value = 3.6;
        this.smoke.uniforms.uSizeIn.value = 0.12;
        this.smoke.uniforms.uFadeIn.value = 0.18;
        this.smoke.uniforms.uFadeOut.value = 0.32;

        // 从地面吹起的砂砾。受光照，所以它读起来是岩石而不是光。
        this.debris = particles.get('meteor.debris', {
            capacity: 1800,
            shape: ParticleShape.CHIP,
            additive: false,
            lit: true,
            softFade: 0.25,
        });
        this.debris.uniforms.uDrag.value = 0.25;
        this.debris.uniforms.uEndSize.value = 0.85;
        this.debris.uniforms.uFadeOut.value = 0.72;

        this.emberEmitter = new RateEmitter();
        this.sparkEmitter = new RateEmitter();
        this.smokeEmitter = new RateEmitter();
    }

    /* ------------------------------------------------------------------ */
    /* 计时                                                               */
    /* ------------------------------------------------------------------ */

    get instanceCount() {
        return this._used;
    }

    /** 弹坑燃烧 `lifetime` 秒，随后一切在 `fadeTime` 内退去。 */
    get impactDuration() {
        return Math.max(0.2, settings.meteor.lifetime * settings.global.lifetime);
    }

    get fadeDuration() {
        return Math.max(0.2, settings.meteor.fadeTime);
    }

    /** 火在冰闪光的地方摇曳明灭——一种快速、不均匀的摇曳。 */
    lightShimmer() {
        const c = settings.meteor;
        const rate = Math.max(0.1, c.lightFlickerSpeed);
        const wobble = Math.sin(this.age * rate) * Math.sin(this.age * rate * 0.37 + 1.7);
        return 1 - saturate(c.lightFlicker) * (0.5 + 0.5 * wobble);
    }

    /* ------------------------------------------------------------------ */
    /* 弹道——每一米都由实时设置求解                                     */
    /* ------------------------------------------------------------------ */

    /**
     * 陨石离开施法者的位置，世界空间。
     *
     * 基类把 `origin` 放在地面上，因为瞄准指示器指的就是那里；而岩块是从手里
     * 掷出的，所以这些偏移在这里施加，而不是烘焙进施放数据里。
     */
    _launchPoint(out) {
        const c = settings.meteor;
        out.copy(this.origin).addScaledVector(this.direction, c.handForward).addScaledVector(this.side, c.handSide);
        out.y = c.handHeight;
        return out;
    }

    /** 飞行路径上的一点，`s` 从 0（手部）到 1（目标点）。 */
    _arcPoint(s, out) {
        const c = settings.meteor;
        const t = saturate(s);
        out.copy(this.origin)
            .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
            .addScaledVector(this.side, c.handSide * (1 - t));
        out.y =
            lerp(c.handHeight, c.endHeight, t) + c.arc * Math.pow(Math.sin(t * Math.PI), Math.max(0.05, c.arcCurve));
        return out;
    }

    /**
     * `s` 处的单位行进方向。
     *
     * 用数值方式对 `_arcPoint` 求导，而不是手推出来：弧线是一个实时滑块，而
     * 手写的导数只会是又一个悄悄与它对不上的东西。
     */
    _headingAt(s, out) {
        const eps = 0.01;
        this._arcPoint(s + eps, _ahead);
        this._arcPoint(s - eps, _behind);
        out.subVectors(_ahead, _behind);
        if (out.lengthSq() < 1e-8) return out.copy(this.direction);
        return out.normalize();
    }

    /** 陨石的半径，单位米。 */
    _radius() {
        return Math.max(0.02, settings.meteor.radius);
    }

    /** 岩块有多热，在手中为 0 → 到目标点为 1。 */
    _charge() {
        const c = settings.meteor;
        if (this.phase !== AbilityPhase.TRAVEL) return 1;
        return Math.pow(saturate(this.u), Math.max(0.05, c.chargeCurve));
    }

    /* ------------------------------------------------------------------ */
    /* 碎块                                                               */
    /* ------------------------------------------------------------------ */

    _chunkRadius(record, c) {
        return Math.max(0.01, this._radius() * c.chunkScale * lerp(0.45, 1.15, record.size));
    }

    /** 碎块被抛出的单位方向——一个朝射向远端偏置的抛射锥。 */
    _chunkDirection(record, c, out) {
        const elevation = lerp(0.12, 1.4, record.elevation) * Math.max(0, c.chunkLoft);
        const flat = Math.cos(elevation);
        out.set(0, Math.sin(elevation), 0);
        out.addScaledVector(this.side, Math.cos(record.angle) * flat);
        out.addScaledVector(this.direction, Math.sin(record.angle) * flat + c.chunkForward);
        if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
        return out.normalize();
    }

    /**
     * 一块碎屑在撞击之后 `elapsed` 秒时的位置。
     *
     * 用闭式弹道而不是积分：整段飞行都是实时设置的函数，所以拖动 `chunkSpeed`
     * 会重新抛掷已经落地的碎屑，而不只是改变它接下来要做的事。落地时刻是解出来
     * 的，因此碎块会落定在地面上，而不是陷穿地面。
     *
     * @returns {number} 碎块自己的时钟，在它落地的那一刻冻结
     */
    _chunkFlight(record, c, elapsed, out) {
        const speed = c.chunkSpeed * lerp(0.45, 1.35, record.speed) * settings.global.particleSpeed;
        const gravity = Math.min(-0.01, c.chunkGravity);
        const rest = this._chunkRadius(record, c) * 0.8;

        this._chunkDirection(record, c, _dir);
        this._arcPoint(1, _impact);

        const vy = _dir.y * speed;
        const y0 = _impact.y;
        // 0.5·g·t² + vy·t + (y0 − rest) = 0，取正根。
        const discriminant = Math.max(0, vy * vy - 2 * gravity * (y0 - rest));
        const landing = (vy + Math.sqrt(discriminant)) / -gravity;
        const t = Math.min(elapsed, landing);

        out.copy(_impact).addScaledVector(_dir, speed * t);
        out.y = Math.max(rest, y0 + vy * t + 0.5 * gravity * t * t);
        return t;
    }

    /** 自陨石落地以来经过的秒数。 */
    get _sinceImpact() {
        if (this.phase === AbilityPhase.FADE) return this.impactDuration + this.fadeTime;
        return this.phase === AbilityPhase.IMPACT ? this.impactTime : 0;
    }

    /* ------------------------------------------------------------------ */
    /* 施放                                                               */
    /* ------------------------------------------------------------------ */

    onSpawn() {
        this.emberEmitter.reset();
        this.sparkEmitter.reset();
        this.smokeEmitter.reset();
        this._lastU = 0;
        this._chunkCount = 0;
        this._used = 1;

        // 一次施放唯一捕获的东西：一个种子、一根翻滚轴，以及碎块的骰子。
        this._seed = Math.random() * 100;
        this.trailMaterial.uniforms.uSeed.value = this._seed * 0.2;
        this.trailMaterial.uniforms.uHeadFade.value = 0;

        const phi = Math.acos(randRange(-1, 1));
        const theta = Math.random() * TAU;
        const sinPhi = Math.sin(phi);
        this._tumbleAxis.set(sinPhi * Math.cos(theta), Math.cos(phi), sinPhi * Math.sin(theta));

        for (const record of this.chunks) {
            record.angle = Math.random() * TAU;
            record.elevation = Math.random();
            record.speed = Math.random();
            record.size = Math.random();
            record.spin = randRange(-1, 1);
            const p = Math.acos(randRange(-1, 1));
            const a = Math.random() * TAU;
            const s = Math.sin(p);
            record.spinAxis.set(s * Math.cos(a), Math.cos(p), s * Math.sin(a));
        }

        this.rock.count = 1;

        this._syncUniforms(0);
        this._updateRock(0);
        this._updateTrail(0);
        this._launchFx();
    }

    /* ------------------------------------------------------------------ */
    /* 逐帧状态                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * 把实时设置推送给每一个材质和粒子系统。
     * @param {number} burn 岩块飞行期间为 0，拖尾消亡时 → 1
     */
    _syncUniforms(burn) {
        const c = settings.meteor;
        const g = settings.global;

        this._syncGeometry();

        const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
        this._headingAt(s, _heading);
        this.material.userData.sync(this._charge(), _heading);

        // 岩块消失之后，体积就不再得到补给：它会变稀、变冷、撕裂散开，而不是简单地
        // 消失不见。`sync()` 刚刚写入了编辑器的数值，所以下面这些是在它之上的覆盖。
        this.trailMaterial.sync();
        const u = this.trailMaterial.uniforms;
        u.uOpacity.value = lerp(c.trailOpacity * g.opacity, 0, burn);
        u.uHeadFade.value = burn * 0.35;
        u.uDetachment.value = lerp(c.trailDetachment, 1.1, burn);

        /* --- 四个粒子系统 --- */
        this.embers.setGradient(
            getColor(c.colorEmberA),
            getColor(c.colorEmberB),
            getColor(c.colorEmberC),
            getColor(c.colorEmberD)
        );
        this.embers.uniforms.uGravity.value.set(0, c.emberRise, 0);
        this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
        this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
        this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
        this.embers.uniforms.uOpacity.value = g.opacity;
        this.embers.uniforms.uGlow.value = c.emberGlow * g.glow;
        this.embers.uniforms.uTurbulence.value = c.emberTurbulence * g.turbulence;

        this.sparks.setGradient(
            getColor(c.colorSparkA),
            getColor(c.colorSparkB),
            getColor(c.colorSparkC),
            getColor(c.colorSparkD)
        );
        this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
        this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
        this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
        this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
        this.sparks.uniforms.uOpacity.value = g.opacity;
        this.sparks.uniforms.uGlow.value = c.emberGlow * 0.8 * g.glow;
        this.sparks.uniforms.uStretch.value = c.sparkStretch;

        this.smoke.setGradient(
            getColor(c.colorSmokeA),
            getColor(c.colorSmokeB),
            getColor(c.colorSmokeC),
            getColor(c.colorSmokeD)
        );
        this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
        this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
        this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
        this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
        this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
        this.smoke.uniforms.uTurbulence.value = 0.45 * g.turbulence;

        this.debris.setGradient(
            getColor(c.colorDebrisA),
            getColor(c.colorDebrisB),
            getColor(c.colorDebrisC),
            getColor(c.colorDebrisD)
        );
        this.debris.uniforms.uGravity.value.set(0, c.debrisGravity, 0);
        this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
        this.debris.uniforms.uLifeScale.value = g.particleLifetime;
        this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
        this.debris.uniforms.uOpacity.value = g.opacity;
    }

    /**
     * 依据实时设置重建每一个实例矩阵。
     * @param {number} retract 0..1——碎屑收回地面里的程度
     */
    _updateRock(retract) {
        const c = settings.meteor;
        const travelling = this.phase === AbilityPhase.TRAVEL;

        /* --- 实例 0：陨石本身 --- */
        if (travelling) {
            this._arcPoint(this.u, _dummy.position);
            _axis.copy(this._tumbleAxis);
            _spin.setFromAxisAngle(_axis, this.age * c.spin);
            _dummy.quaternion.copy(_spin);
            _dummy.scale.setScalar(this._radius());
            this.heats.array[0] = 1;
        } else {
            // 它已经炸碎了。把它停放起来，而不是去绘制一个退化矩阵。
            _dummy.position.set(0, -999, 0);
            _dummy.quaternion.identity();
            _dummy.scale.setScalar(0.0001);
            this.heats.array[0] = 0;
        }
        _dummy.updateMatrix();
        this.rock.setMatrixAt(0, _dummy.matrix);

        /* --- 碎块 --- */
        const since = this._sinceImpact;
        const cool = Math.max(0.05, c.chunkCool);

        for (let i = 0; i < this._chunkCount; i++) {
            const record = this.chunks[i];
            const radius = this._chunkRadius(record, c);
            const flight = this._chunkFlight(record, c, since, _pos);

            if (retract > 0) _pos.y -= Easing.inCubic(retract) * (radius * 2 + 0.5);

            _dummy.position.copy(_pos);
            _axis.copy(record.spinAxis);
            _spin.setFromAxisAngle(_axis, record.spin * c.chunkSpin * flight);
            _dummy.quaternion.copy(_spin);
            _dummy.scale.setScalar(radius);
            _dummy.updateMatrix();

            this.rock.setMatrixAt(1 + i, _dummy.matrix);
            this.heats.array[1 + i] = saturate(1 - since / cool);
        }

        this._used = travelling ? 1 : 1 + this._chunkCount;
        this.rock.count = this._used;
        this.rock.instanceMatrix.needsUpdate = true;
        this.heats.needsUpdate = true;
    }

    /**
     * 重建光线步进器在其内部渲染的那层面向相机的代理外壳。
     *
     * 它的中心线是直接对 `_arcPoint` 采样得到的，而不是从过去几帧记录下来的，
     * 因此拖尾是弹道设置的纯函数——这正是为什么在时钟暂停时，`arc`、
     * `endHeight` 和 `trailSpan` 还能重塑已经在空中的火焰。
     *
     * 外壳只需要*包住*体积：它是一条广告牌缎带，其半宽遵循与密度场相同的半径
     * 分布，再按体积向上的拉伸、以及撕裂能把密度向外推多远来加宽，两端还要各自
     * 加上一个端盖半径。哪怕只是稍窄一点的外壳，都会表现为一条笔直的边切过
     * 火焰，这正是这套技法唯一会以可见方式失败的地方。
     *
     * @param {number} burn 岩块飞行期间为 0，拖尾消亡时 0 → 1
     */
    _updateTrail(burn) {
        const c = settings.meteor;
        const head = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
        const span = Math.max(0.05, c.trailSpan) / Math.max(0.1, this.length);
        // 岩块消失之后，尾端会一路啃向头端。
        const tail = saturate(head - span * (1 - burn));

        const visible = (head - tail) * this.length > 0.06;
        this.trailMesh.visible = visible;
        if (!visible) {
            this.ribbon.clear();
            this.trailCount = 0;
            return;
        }

        const count = TRAIL_NODES + 1;
        for (let i = 0; i < count; i++) {
            this._arcPoint(lerp(tail, head, i / (count - 1)), this.trailPoints[i]);
        }
        this.trailCount = count;

        let length = 0;
        for (let i = 1; i < count; i++) length += this.trailPoints[i].distanceTo(this.trailPoints[i - 1]);
        if (length < 1e-3) {
            this.trailMesh.visible = false;
            this.ribbon.clear();
            this.trailCount = 0;
            return;
        }

        // 体积在消亡时会变稀，而不只是淡出。
        const radius = Math.max(0.01, c.trailWidth) * (1 - burn * 0.65);
        const headSize = c.trailHeadSize;
        const wakeSpread = c.trailWakeSpread;
        const headRadius = radius * headSize;
        // 撕裂*和*轮廓鼓起最多能把密度推到名义管体之外多远。实时读取：这两者在
        // 施放过程中都可以编辑。
        const reach = fireHullReach();
        const tailPad = radius * radiusProfile(0, 1, wakeSpread) * reach;
        const headPad = headRadius * reach;

        const hull = this.hullPoints;
        // 沿弧线自身的行进方向，在两端各加一段端盖外扩。
        this._headingAt(tail, _heading);
        hull[0].copy(this.trailPoints[0]).addScaledVector(_heading, -tailPad);

        // 尾流是高温气体：它落在岩块后面越远，就有越久的时间向上爬升。把外壳的
        // 中心线整体抬高就够了——光线步进器直接从这份几何体上读取它的轴。
        for (let i = 0; i < count; i++) {
            const age = 1 - i / (count - 1);
            hull[i + 1].copy(this.trailPoints[i]);
            hull[i + 1].y += c.trailRise * Math.pow(age, 1.5);
        }
        hull[0].y += c.trailRise;

        this._headingAt(head, _heading);
        hull[count + 1].copy(this.trailPoints[count - 1]).addScaledVector(_heading, headPad);

        const arcLength = tailPad + length + headPad;

        const u = this.trailMaterial.uniforms;
        u.uRadius.value = radius; // 覆盖 sync()，好让烧尽过程能把它缩小
        u.uStreamLength.value = length;
        u.uArcLength.value = arcLength;
        u.uTailPad.value = tailPad;

        // 密度场既被向上拉伸，*又*被噪声向外推开，所以外壳必须比管体本身的圆截面
        // 宽出不少。
        const cover = 1.08 * reach * Math.max(1, c.trailPlume);

        this.ribbon.build(hull, {
            count: count + 2,
            width: 2 * headRadius * cover,
            mode: RibbonMode.BILLBOARD,
            cameraPosition: this.ctx.camera.position,
            widthProfile: (t) =>
                radiusProfile(saturate((t * arcLength - tailPad) / length), headSize, wakeSpread) / headSize,
        });
    }

    /* ------------------------------------------------------------------ */
    /* 反馈                                                               */
    /* ------------------------------------------------------------------ */

    /** 岩块离开时，施法者手上的一记闪光。 */
    _launchFx() {
        const c = settings.meteor;
        const g = settings.global;

        this._launchPoint(_pos);

        // 默认关闭：如此贴近身体朝向相机那一侧的膨胀外壳，读起来像是一个粘在施法者
        // 身上的球，而不是一记爆闪；而下面的火花加上屏幕闪光已经足以演绎这次释放。
        // 想让它回来，就把 `muzzleSize` 调大。
        if (c.muzzleSize > 0) {
            this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
                radius: c.muzzleSize * 0.25,
                endRadius: c.muzzleSize * g.explosionIntensity,
                life: 0.4,
                intensity: c.muzzleIntensity,
                opacity: 0.85,
                fresnel: 1.2,
                displace: 0.45,
                colorA: getColor(c.colorHot),
                colorB: getColor(c.colorFlameMid),
                colorC: getColor(c.colorFlameEdge),
            });
        }

        _emit.position = _pos;
        _emit.radius = 0.22;
        _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
        _emit.speed = c.sparkSpeed * 0.9;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.9;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.16;
        _emit.sizeVariance = 0.7;
        _emit.life = c.sparkLifetime * 0.8;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = frame.uTime.value;
        this.sparks.emit(Math.round(30 * g.particleCount), _emit);

        this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
    }

    /**
     * 沿本帧覆盖的那段弧线撒下余烬、火花和烟雾。
     *
     * 分散在上一帧的位置与这一帧的位置之间的几个点上：一颗以 20 m/s 飞行的陨石
     * 每帧会走过一米，如果所有粒子都从头端发射，拖尾会明显地串成一粒一粒。
     */
    _trailFx(dt) {
        const c = settings.meteor;
        const g = settings.global;
        const time = frame.uTime.value;
        const radius = this._radius();

        // 拖尾是从岩块的*背面*推出去的，而岩块已经不在了。
        this._headingAt(this.u, _heading);
        _back.copy(_heading).multiplyScalar(-1);

        let emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate) * g.particleCount);
        if (emberCount > 0) {
            _emit.direction = _dir
                .copy(_back)
                .setY(_back.y + 0.35)
                .normalize();
            _emit.speed = c.emberSpeed;
            _emit.speedVariance = 0.7;
            _emit.spread = 0.85;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.13;
            _emit.sizeVariance = 0.6;
            _emit.life = c.emberLifetime;
            _emit.lifeVariance = 0.45;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;

            const batches = Math.min(emberCount, TRAIL_BATCHES);
            const per = Math.ceil(emberCount / batches);
            while (emberCount > 0) {
                this._arcPoint(lerp(this._lastU, this.u, Math.random()), _pos);
                _emit.position = _pos;
                _emit.radius = radius * 0.9;
                this.embers.emit(Math.min(per, emberCount), _emit);
                emberCount -= per;
            }
        }

        const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate) * g.particleCount);
        if (sparkCount > 0) {
            this._arcPoint(lerp(this._lastU, this.u, Math.random()), _pos);
            _emit.position = _pos;
            _emit.radius = radius * 0.7;
            _emit.direction = _dir
                .copy(_back)
                .setY(_back.y + 0.2)
                .normalize();
            _emit.speed = c.sparkSpeed;
            _emit.speedVariance = 0.85;
            _emit.spread = 0.95;
            _emit.size = 0.15;
            _emit.sizeVariance = 0.7;
            _emit.life = c.sparkLifetime;
            _emit.lifeVariance = 0.55;
            _emit.spin = 0;
            _emit.time = time;
            this.sparks.emit(sparkCount, _emit);
        }

        const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate) * g.particleCount);
        if (smokeCount > 0) {
            this._arcPoint(lerp(this._lastU, this.u, Math.random()), _pos);
            _emit.position = _pos;
            _emit.radius = radius * 1.1;
            _emit.direction = _dir.copy(_back);
            _emit.speed = c.smokeSpeed;
            _emit.speedVariance = 0.6;
            _emit.spread = 0.75;
            _emit.size = 0.85;
            _emit.sizeVariance = 0.5;
            _emit.life = c.smokeLifetime;
            _emit.lifeVariance = 0.4;
            _emit.spin = 0.5;
            _emit.time = time;
            this.smoke.emit(smokeCount, _emit);
        }
    }

    /** 岩块消失之后，弹坑仍在继续燃烧。 */
    _craterFx(dt, scale) {
        const c = settings.meteor;
        const g = settings.global;
        const time = frame.uTime.value;

        this._arcPoint(1, _impact);

        const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * 0.5 * scale) * g.particleCount);
        if (emberCount > 0) {
            _emit.position = _pos.copy(_impact).setY(0.25);
            _emit.radius = c.scorchRadius * 0.9;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.emberSpeed * 0.8;
            _emit.speedVariance = 0.75;
            _emit.spread = 0.9;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.14;
            _emit.sizeVariance = 0.6;
            _emit.life = c.emberLifetime * 1.2;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;
            this.embers.emit(emberCount, _emit);
        }

        const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * 0.8 * scale) * g.particleCount);
        if (smokeCount > 0) {
            _emit.position = _pos.copy(_impact).setY(0.2);
            _emit.radius = c.scorchRadius * 1.1;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.smokeSpeed * 1.2;
            _emit.speedVariance = 0.6;
            _emit.spread = 0.85;
            _emit.size = 1.3;
            _emit.sizeVariance = 0.5;
            _emit.life = c.smokeLifetime * 1.4;
            _emit.lifeVariance = 0.4;
            _emit.spin = 0.6;
            _emit.time = time;
            this.smoke.emit(smokeCount, _emit);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 阶段                                                               */
    /* ------------------------------------------------------------------ */

    onTravel(dt) {
        this._syncUniforms(0);

        // 光源跟着陨石走，而不是跟着它下方的地面。`advance()` 已经把 `position`
        // 放在地面线上了，所以这里再把它抬到弧线上。
        this._arcPoint(this.u, this.position);

        this._updateRock(0);
        this._updateTrail(0);
        this._trailFx(dt);
        this._lastU = this.u;

        this.ctx.shake.rumble(settings.meteor.rumble * settings.global.cameraShake, dt);
    }

    onImpact() {
        const c = settings.meteor;
        const g = settings.global;
        const time = frame.uTime.value;
        const scale = c.burstSize * g.explosionIntensity;

        this._chunkCount = Math.min(MAX_CHUNKS, Math.max(0, Math.round(c.chunkCount)));

        const hot = getColor(c.colorHot);
        const mid = getColor(c.colorFlameMid);
        const edge = getColor(c.colorFlameEdge);

        this._arcPoint(1, _impact);
        _pos.copy(_impact).setY(_impact.y + scale * 0.28);

        /* 火球，以及一记更快的内层闪光，用它把这次引爆演得可信 */
        this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
            radius: scale * 0.22,
            endRadius: scale,
            life: 0.9,
            intensity: c.burstIntensity,
            opacity: 0.95,
            fresnel: 1.1,
            displace: 0.55,
            turbulence: c.burstTurbulence * 0.6,
            colorA: hot,
            colorB: mid,
            colorC: edge,
        });
        this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
            radius: scale * 0.1,
            endRadius: scale * 0.55,
            life: 0.35,
            intensity: c.burstIntensity * 2.2,
            opacity: 1.0,
            displace: 0.2,
            colorA: hot,
            colorB: hot,
            colorC: mid,
        });

        /* 贴着地面猛地向外弹开的圆环 */
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, _impact, {
            radius: c.shockRadius * g.explosionIntensity,
            life: 0.65,
            width: 0.07,
            intensity: 1.2,
            colorA: getColor(c.colorShockA),
            colorB: getColor(c.colorShockB),
        });

        /*
         * 弹坑：真正撕裂地面的熔融裂缝。不是贴花——而是一张生长出来的缎带网络，
         * 沿裂口边缘有玄武岩被顶起来。见 `effects/GroundFissures.js`。
         */
        this.ctx.fissures.spawn(_impact, {
            radius: c.fissureRadius * g.explosionIntensity,
            life: c.fissureLife,
        });

        /* 底下的一大片焦痕 */
        this.ctx.decals.spawn(DecalType.SCORCH, _impact, {
            radius: c.scorchRadius * g.explosionIntensity,
            life: c.scorchLife,
            intensity: c.scorchIntensity,
            colorA: getColor(c.colorScorch),
            colorB: getColor(c.colorCrack),
            height: 0.015,
        });

        /* 从里面抛出来的一切 */
        _emit.position = _pos;
        _emit.radius = scale * 0.22;
        _emit.direction = _dir.set(0, 0.6, 0);
        _emit.speed = c.emberSpeed * 2.6;
        _emit.speedVariance = 0.8;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.2;
        _emit.sizeVariance = 0.7;
        _emit.life = c.emberLifetime * 1.5;
        _emit.lifeVariance = 0.55;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

        _emit.speed = c.sparkSpeed * 2.4;
        _emit.size = 0.22;
        _emit.life = c.sparkLifetime * 1.6;
        this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

        _emit.position = _pos.copy(_impact).setY(0.25);
        _emit.radius = c.scorchRadius * 0.7;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.debrisSpeed;
        _emit.speedVariance = 0.75;
        _emit.spread = 0.85;
        _emit.size = 0.15;
        _emit.life = c.debrisLifetime;
        _emit.spin = 9;
        this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

        _emit.speed = c.smokeSpeed * 2.6;
        _emit.spread = 1.0;
        _emit.size = 1.7;
        _emit.sizeVariance = 0.5;
        _emit.life = c.smokeLifetime * 1.6;
        _emit.spin = 0.6;
        this.smoke.emit(Math.round(c.burstSmoke * g.particleCount), _emit);

        this.ctx.shake.add(
            c.impactShake * g.explosionIntensity * g.cameraShake,
            1 / Math.max(0.1, c.shakeDuration),
            22
        );
        this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 2.4 * g.explosionIntensity;

        this._updateRock(0);
        this._updateTrail(0);
    }

    onFade(dt, t) {
        const c = settings.meteor;

        // 拖尾不再得到补给，所以它从头端往回烧。
        const burn = saturate(this._sinceImpact / Math.max(0.05, c.trailBurnout));
        this._syncUniforms(burn);

        // 光源落到弹坑上，并停在那里。
        this._arcPoint(1, this.position);

        let retract = 0;
        if (this.phase === AbilityPhase.FADE) {
            retract = saturate((this.fadeTime - c.chunkLinger) / Math.max(0.05, c.chunkSink));
        }

        this._updateRock(retract);
        this._updateTrail(burn);

        // 碎屑躺在那里的时候，弹坑持续燃烧；碎屑退去时它就停下。
        // `t` 在燃烧阶段从 0 走到 1，随后在一切被清理掉的过程中从 1 走到 2。
        if (retract < 0.6) this._craterFx(dt, t <= 1 ? 1 - t * 0.5 : 0.25);
    }

    onDestroy() {
        this._chunkCount = 0;
        this._used = 0;
        this.trailCount = 0;
        this.rock.count = 0;
        this.ribbon.clear();
        this.trailMesh.visible = false;
    }

    dispose() {
        this.geometry.dispose();
        this.ribbon.dispose();
        this.rock.dispose();
        this.material.dispose();
        this.trailMaterial.dispose();
        super.dispose();
    }
}
