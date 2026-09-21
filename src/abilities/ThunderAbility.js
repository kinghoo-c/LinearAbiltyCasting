import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createLightningMaterial, BoltPass } from '../materials/LightningMaterial.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** 每道闪电的细丝数量硬上限。编辑器里的 `strands` 滑块最多拉到这里。 */
const MAX_STRANDS = 24;
/**
 * 单根细丝上的采样点数。这是一处折角能有多细的上限：频率高于每两个节点一个
 * 折角的成分只会产生混叠，所以 `jitterScale` 超过大约 `nodes / (2 × range)`
 * 之后就不再增加细节了。
 */
const NODES = 72;
/**
 * 一帧的火花被分摊到闪电上的多少个点上。再低一点，每一批都会读成钉在同一个
 * 位置上的星爆。
 */
const SPARK_BATCHES = 6;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _origin = new Vector3();
const _target = new Vector3();

/**
 * THUNDER——一道从手中沿瞄准方向掷出的闪电。
 *
 * 一拍，很短：一道打击前沿以 `speed` 从施法者手中疾冲而出，一束闪电细丝被画
 * 在它身后；这束细丝随后维持 `lifetime` 秒，一路明灭摇曳、反复重击，并在
 * `fadeTime` 内炸散熄灭。火花全程从它身上溅出，下方的地面留下一道分叉的电灼痕
 * 和一片焦黑，远端则得到一层电离空气的外壳。
 *
 * 一切都是程序生成的：闪电是一长条面向相机的缎带，它的每一个顶点都由顶点
 * 着色器放置；灼痕是画在四边形上的着色器；而火花、浮尘、烟雾和碎屑都是 GPU
 * 粒子。没有任何东西从磁盘加载，也没有任何东西是一张贴图。
 *
 * **让编辑器得以工作的规则。** `IceAbility` 保存着一池除了掷骰子什么都没有的
 * 尖刺记录；这个技能连那个都不需要，因为*整条*路径都活在着色器里。一次施放
 * 只捕获一个数字——`_seed`，好让两次施放不会画出完全相同的闪电——然后每帧
 * 对照 `settings.thunder` 求解每一个米、弧度和秒，零长度的一帧也不例外。拖动
 * `jitter` 会重新扭折一道已经在空中的闪电；拖动 `spread` 会重新张开它的扇形；
 * 拖动 `handHeight` 会抬起离开施法者的那一端。这正是打击进行到一半时按 **P**
 * 暂停的意义所在。
 *
 * 一次施放捕获的其他东西只有时间戳。那些是事件。
 */
export class ThunderAbility extends Ability {
    constructor(context) {
        super('thunder', context);
    }

    /* ------------------------------------------------------------------ */
    /* 构建                                                               */
    /* ------------------------------------------------------------------ */

    createShaders() {
        this.geometry = createBoltRibbonGeometry(NODES, MAX_STRANDS);

        // 对同一批细丝做两遍绘制：底下是一层宽而柔的晕，上面是炽热的芯。把晕当作
        // 真正的缎带来画，而不是用泛光伪造它，正是这一点让辉光*贴着*每一处折角。
        this.glowMaterial = createLightningMaterial(BoltPass.GLOW);
        this.coreMaterial = createLightningMaterial(BoltPass.CORE);
        this.boltMaterials = [this.glowMaterial, this.coreMaterial];

        this.meshes = [];
        for (const [index, material] of this.boltMaterials.entries()) {
            const mesh = new Mesh(this.geometry, material);
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            mesh.layers.set(LAYER.VFX);
            // 先画晕，好让芯叠加在它上面。
            mesh.renderOrder = 11 + index * 2;
            this.group.add(mesh);
            this.meshes.push(mesh);
        }

        /** 每次施放都重新掷一次，这样没有两道闪电会画出相同的形状。 */
        this._seed = 0;
        this._strandCount = 1;
        /** 前沿已经推进、并且已经铺下地面灼痕的米数。 */
        this._burnDistance = 0;

        // 每帧交给两个材质的临时状态。一个对象，反复复用——同步闪电不产生任何分配。
        this._state = {
            origin: new Vector3(),
            target: new Vector3(),
            side: new Vector3(),
            progress: 0,
            fade: 1,
            seed: 0,
            strands: 1,
        };
    }

    createParticles() {
        const particles = this.ctx.particles;

        // 火花：在重力下被速度拉伸成条痕。这是参考画面的标志性特征，也是这个系统
        // 要求开启 `stretch` 的原因。
        this.sparks = particles.get('thunder.sparks', {
            capacity: 4000,
            shape: ParticleShape.STREAK,
            additive: true,
            stretch: true,
            softFade: 0.25,
        });
        this.sparks.uniforms.uDrag.value = 1.4;
        this.sparks.uniforms.uEndSize.value = 0.25;
        this.sparks.uniforms.uSizeIn.value = 0.02;
        this.sparks.uniforms.uFadeIn.value = 0.03;
        this.sparks.uniforms.uFadeOut.value = 0.45;

        // 悬浮在闪电周围空气中的缓慢电离浮尘。
        this.motes = particles.get('thunder.motes', {
            capacity: 2400,
            shape: ParticleShape.SOFT,
            additive: true,
            curl: true,
            softFade: 0.4,
        });
        this.motes.uniforms.uDrag.value = 1.6;
        this.motes.uniforms.uEndSize.value = 0.15;
        this.motes.uniforms.uSizeIn.value = 0.06;
        this.motes.uniforms.uFadeIn.value = 0.08;
        this.motes.uniforms.uFadeOut.value = 0.4;

        // 焦黑地面上腾起的薄雾。不做加性混合，因此它真的能遮挡。
        this.smoke = particles.get('thunder.smoke', {
            capacity: 2000,
            shape: ParticleShape.SMOKE,
            additive: false,
            curl: true,
            softFade: 1.1,
        });
        this.smoke.uniforms.uDrag.value = 1.8;
        this.smoke.uniforms.uEndSize.value = 3.0;
        this.smoke.uniforms.uSizeIn.value = 0.12;
        this.smoke.uniforms.uFadeIn.value = 0.16;
        this.smoke.uniforms.uFadeOut.value = 0.3;

        // 被打击从地面上掀起的碎屑。
        this.debris = particles.get('thunder.debris', {
            capacity: 1600,
            shape: ParticleShape.CHIP,
            additive: false,
            lit: true,
            softFade: 0.25,
        });
        this.debris.uniforms.uDrag.value = 0.25;
        this.debris.uniforms.uEndSize.value = 0.8;
        this.debris.uniforms.uFadeOut.value = 0.7;

        this.sparkEmitter = new RateEmitter();
        this.moteEmitter = new RateEmitter();
        this.smokeEmitter = new RateEmitter();
        this.debrisEmitter = new RateEmitter();
    }

    /* ------------------------------------------------------------------ */
    /* 计时                                                               */
    /* ------------------------------------------------------------------ */

    get instanceCount() {
        // 对同一批细丝做两遍绘制。
        return this._strandCount * this.meshes.length;
    }

    /** 闪电落地后维持一段时间，随后炸散熄灭。 */
    get impactDuration() {
        return Math.max(0.05, settings.thunder.lifetime * settings.global.lifetime);
    }

    get fadeDuration() {
        return Math.max(0.05, settings.thunder.fadeTime);
    }

    /** 闪电在冰闪光的地方摇曳明灭——一种生硬、量化的抖动。 */
    lightShimmer() {
        const c = settings.thunder;
        const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
        // 对步进序号做确定性哈希：光源在各级之间跳动，用的正是闪电自身闪烁所依据的
        // 那个时钟。
        const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
        return 1 - saturate(c.lightFlicker) * noise;
    }

    /* ------------------------------------------------------------------ */
    /* 闪电的几何——每一米都由实时设置求解                               */
    /* ------------------------------------------------------------------ */

    /**
     * 闪电离开施法者的位置，世界空间。
     *
     * 基类把 `origin` 放在地面上，因为瞄准指示器指的就是那里；而闪电是从手里
     * 出来的，所以这些偏移在这里施加，而不是烘焙进施放数据里。
     */
    _handPoint(out) {
        const c = settings.thunder;
        out.copy(this.origin).addScaledVector(this.direction, c.handForward).addScaledVector(this.side, c.handSide);
        out.y = c.handHeight;
        return out;
    }

    /** 它落在哪里。 */
    _impactPoint(out) {
        this.pointAt(1, out);
        out.y = settings.thunder.endHeight;
        return out;
    }

    /**
     * 闪电*轴*上沿其方向 `s` 处的一点，0..1。
     *
     * 它精确地镜像了顶点着色器的第一阶段——同样的插值、同样的下垂——这样 CPU
     * 生成的火花和灼痕就会落在 GPU 真正画出的那道闪电上，而不是落在它附近。
     */
    _axisPoint(s, out) {
        const c = settings.thunder;
        const t = saturate(s);
        out.copy(this.origin)
            .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
            .addScaledVector(this.side, c.handSide * (1 - t));
        out.y = lerp(c.handHeight, c.endHeight, t) + c.sag * Math.sin(t * Math.PI);
        return out;
    }

    /** `s` 处整束的半宽，单位米——火花最多能被抛到多远。 */
    _bundleRadius(s) {
        const c = settings.thunder;
        return lerp(c.spreadNear, c.spread, Math.pow(saturate(s), Math.max(0.01, c.spreadCurve)));
    }

    /* ------------------------------------------------------------------ */
    /* 施放                                                               */
    /* ------------------------------------------------------------------ */

    onSpawn() {
        this.sparkEmitter.reset();
        this.moteEmitter.reset();
        this.smokeEmitter.reset();
        this.debrisEmitter.reset();
        this._burnDistance = 0;

        // 一次施放唯一捕获的东西。其他一切都在每帧求解。
        this._seed = Math.random() * 100;

        this._syncUniforms(1);
        this._muzzleFx();
    }

    /* ------------------------------------------------------------------ */
    /* 反馈                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * 把实时设置和当前的施放状态推送给闪电的两遍绘制。
     * @param {number} fade 闪电亮着时为 1，炸散熄灭时渐变到 0
     */
    _syncUniforms(fade) {
        const c = settings.thunder;
        const g = settings.global;
        const state = this._state;

        this._handPoint(state.origin);
        this._impactPoint(state.target);
        state.side.copy(this.side);
        state.progress = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
        state.fade = fade;
        state.seed = this._seed;

        this._strandCount = Math.max(1, Math.min(MAX_STRANDS, Math.round(c.strands)));
        state.strands = this._strandCount;
        this.geometry.instanceCount = this._strandCount;

        for (const material of this.boltMaterials) material.userData.sync(state);

        /* --- 粒子系统，全部四个 --- */
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
        this.sparks.uniforms.uGlow.value = c.glow * 0.6 * g.glow;
        this.sparks.uniforms.uStretch.value = c.sparkStretch;
        this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

        this.motes.setGradient(
            getColor(c.colorMoteA),
            getColor(c.colorMoteB),
            getColor(c.colorMoteC),
            getColor(c.colorMoteD)
        );
        this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
        this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
        this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
        this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
        this.motes.uniforms.uOpacity.value = g.opacity;
        this.motes.uniforms.uGlow.value = 0.9 * g.glow;
        this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
        this.smoke.uniforms.uTurbulence.value = 0.35 * g.turbulence;

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

    /** 闪电离开时，施法者手上的一记闪光。 */
    _muzzleFx() {
        const c = settings.thunder;
        const g = settings.global;

        this._handPoint(_pos);

        this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
            radius: c.muzzleSize * 0.2,
            endRadius: c.muzzleSize * g.explosionIntensity,
            life: 0.3,
            intensity: c.muzzleIntensity,
            opacity: 0.9,
            fresnel: 1.5,
            displace: 0.5,
            colorA: getColor(c.colorMuzzleA),
            colorB: getColor(c.colorMuzzleB),
            colorC: getColor(c.colorMuzzleC),
        });

        _emit.position = _pos;
        _emit.radius = 0.18;
        _emit.direction = _dir.copy(this.direction);
        _emit.speed = c.sparkSpeed * 1.5;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.85;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.2;
        _emit.sizeVariance = 0.7;
        _emit.life = c.sparkLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = frame.uTime.value;
        this.sparks.emit(Math.round(40 * g.particleCount), _emit);

        this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
    }

    /**
     * 沿闪电的全长撒下火花、浮尘、烟雾和碎屑。
     * @param {number} scale 0..1——闪电只剩维持阶段之后就会变稀
     */
    _boltFx(dt, scale) {
        const c = settings.thunder;
        const g = settings.global;
        const time = frame.uTime.value;
        // 只有闪电已经画出来的那一段才允许抛出任何东西。
        const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;

        let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
        if (sparkCount > 0) {
            _emit.direction = _dir.copy(this.direction).multiplyScalar(0.45).setY(0.55).normalize();
            _emit.speed = c.sparkSpeed;
            _emit.speedVariance = 0.85;
            _emit.spread = 1.0;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.16;
            _emit.sizeVariance = 0.7;
            _emit.life = c.sparkLifetime;
            _emit.lifeVariance = 0.55;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;

            // 把这一帧的火花分摊到闪电上的几个点，而不是全部从一个点射出。一条光束是
            // 沿整个长度散逸的，而单一原点会让每一批都读成一次星爆——只要仔细看上一眼
            // 就明显不对。
            const batches = Math.min(sparkCount, SPARK_BATCHES);
            const per = Math.ceil(sparkCount / batches);
            while (sparkCount > 0) {
                const s = randRange(0.05, 1) * reach;
                this._axisPoint(s, _pos);
                _emit.position = _pos;
                _emit.radius = this._bundleRadius(s) * 1.1 + 0.05;
                this.sparks.emit(Math.min(per, sparkCount), _emit);
                sparkCount -= per;
            }
        }

        const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
        if (moteCount > 0) {
            const s = Math.random() * reach;
            this._axisPoint(s, _pos);
            _emit.position = _pos;
            _emit.radius = this._bundleRadius(s) * 1.6 + 0.2;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.moteSpeed;
            _emit.speedVariance = 0.8;
            _emit.spread = 1.0;
            _emit.size = 0.08;
            _emit.sizeVariance = 0.6;
            _emit.life = c.moteLifetime;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.time = time;
            this.motes.emit(moteCount, _emit);
        }

        const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
        if (smokeCount > 0) {
            // 烟雾来自*地面*，而不是闪电——那是焦痕在燃烧。
            this.pointAt(Math.random() * reach, _pos).setY(0.15);
            _emit.position = _pos;
            _emit.radius = c.scorchRadius * 2.5;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.smokeSpeed;
            _emit.speedVariance = 0.7;
            _emit.spread = 0.9;
            _emit.size = 0.8;
            _emit.sizeVariance = 0.5;
            _emit.life = c.smokeLifetime;
            _emit.lifeVariance = 0.4;
            _emit.spin = 0.4;
            _emit.time = time;
            this.smoke.emit(smokeCount, _emit);
        }

        const debrisCount = Math.round(this.debrisEmitter.tick(dt, c.debrisRate * scale) * g.particleCount);
        if (debrisCount > 0) {
            this.pointAt(Math.random() * reach, _pos).setY(0.06);
            _emit.position = _pos;
            _emit.radius = c.scorchRadius * 1.8;
            _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(1).normalize();
            _emit.speed = c.debrisSpeed;
            _emit.speedVariance = 0.75;
            _emit.spread = 0.8;
            _emit.size = 0.1;
            _emit.sizeVariance = 0.7;
            _emit.life = c.debrisLifetime;
            _emit.lifeVariance = 0.5;
            _emit.spin = 8;
            _emit.time = time;
            this.debris.emit(debrisCount, _emit);
        }
    }

    /** 打击前沿扫过地面时，在它上面铺下的灼痕。 */
    _groundFx() {
        const c = settings.thunder;
        const step = 1 / Math.max(0.05, c.arcRate);

        while (this.front - this._burnDistance >= step) {
            this._burnDistance += step;
            const s = saturate(this._burnDistance / this.length);
            this.pointAt(s, _pos);
            // 相对轴线做抖动，这样这些印记不会读成一条虚线。
            const wander = this._bundleRadius(s) * 0.8;
            _pos.x += this.side.x * randRange(-wander, wander);
            _pos.z += this.side.z * randRange(-wander, wander);

            this.ctx.decals.spawn(DecalType.ARC, _pos, {
                radius: c.arcRadius * randRange(0.7, 1.2),
                life: c.arcLife,
                width: c.arcBranches,
                intensity: c.arcIntensity,
                colorA: getColor(c.colorEmber),
                colorB: getColor(c.colorArc),
            });

            this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
                radius: c.scorchRadius * randRange(0.7, 1.3),
                life: c.scorchLife,
                intensity: c.scorchIntensity,
                colorA: getColor(c.colorScorch),
                colorB: getColor(c.colorEmber),
                height: 0.015,
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* 阶段                                                               */
    /* ------------------------------------------------------------------ */

    onTravel(dt) {
        this._syncUniforms(1);

        // 光源跟着闪电的尖端走，而不是跟着它下方的地面。`advance()` 已经把
        // `position` 放在地面线上了，所以这里再把它抬到轴线上。
        this._axisPoint(this.u, this.position);

        this._boltFx(dt, 1);
        this._groundFx();

        this.ctx.shake.rumble(settings.thunder.rumble * settings.global.cameraShake, dt);
    }

    onImpact() {
        const c = settings.thunder;
        const g = settings.global;
        const time = frame.uTime.value;

        this._impactPoint(_pos);

        /* 电离空气的外壳 */
        this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
            radius: c.burstSize * 0.2,
            endRadius: c.burstSize * g.explosionIntensity,
            life: 0.7,
            intensity: c.burstIntensity,
            opacity: 0.9,
            fresnel: 1.6,
            displace: 0.6,
            squash: 0.8,
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstB),
            colorC: getColor(c.colorBurstC),
        });

        /* 贴着地面猛地向外弹开的圆环 */
        this.pointAt(1, _target);
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
            radius: c.shockRadius * g.explosionIntensity,
            life: 0.6,
            width: 0.05,
            intensity: 1.0,
            colorA: getColor(c.colorShockA),
            colorB: getColor(c.colorShockB),
        });

        /* 它接地处的一大片灼痕 */
        this.ctx.decals.spawn(DecalType.ARC, _target, {
            radius: c.arcRadius * 2.4,
            life: c.arcLife * 1.6,
            width: c.arcBranches,
            intensity: c.arcIntensity,
            colorA: getColor(c.colorEmber),
            colorB: getColor(c.colorArc),
        });
        this.ctx.decals.spawn(DecalType.SCORCH, _target, {
            radius: c.scorchRadius * 2.6,
            life: c.scorchLife * 1.4,
            intensity: c.scorchIntensity * 1.3,
            colorA: getColor(c.colorScorch),
            colorB: getColor(c.colorEmber),
            height: 0.015,
        });

        /* 被打击掀飞的火花与碎屑 */
        _emit.position = _pos;
        _emit.radius = 0.3;
        _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
        _emit.speed = c.sparkSpeed * 2.2;
        _emit.speedVariance = 0.85;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.22;
        _emit.sizeVariance = 0.8;
        _emit.life = c.sparkLifetime * 1.5;
        _emit.lifeVariance = 0.6;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

        _emit.position = _target;
        _emit.radius = c.scorchRadius * 2;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.debrisSpeed * 1.8;
        _emit.spread = 0.85;
        _emit.size = 0.14;
        _emit.life = c.debrisLifetime * 1.3;
        _emit.spin = 10;
        this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

        _emit.speed = c.smokeSpeed * 2.2;
        _emit.spread = 1.0;
        _emit.size = 1.5;
        _emit.life = c.smokeLifetime * 1.3;
        _emit.spin = 0.5;
        this.smoke.emit(Math.round(45 * g.particleCount), _emit);

        this.ctx.shake.add(
            c.impactShake * g.explosionIntensity * g.cameraShake,
            1 / Math.max(0.1, c.shakeDuration),
            26
        );
        this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
    }

    onFade(dt, t) {
        // `t` 在闪电维持阶段从 0 走到 1，随后在它炸散熄灭的过程中从 1 走到 2。熄灭是
        // 三次曲线，所以闪电会先撑住、然后骤然消失，而不是慢慢变暗。
        const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
        this._syncUniforms(fade);

        // 前沿抵达之后，光源就停在撞击点上。
        this._axisPoint(1, this.position);

        // 消亡时会变稀：一道正在熄灭的闪电不会还以满速率散逸，但它确实会一直抛火花，
        // 直到彻底放手。
        this._boltFx(dt, fade * (t <= 1 ? 0.6 : 0.35));
    }

    onDestroy() {
        this._strandCount = 1;
        this.geometry.instanceCount = 1;
        for (const material of this.boltMaterials) material.uniforms.uFade.value = 0;
    }

    dispose() {
        this.geometry.dispose();
        for (const material of this.boltMaterials) material.dispose();
        super.dispose();
    }
}
