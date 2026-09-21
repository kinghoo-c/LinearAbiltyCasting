import { Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createSnareCageMaterial, createSnareFieldMaterial, SnarePass } from '../materials/SnareMaterial.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange } from '../utils/math.js';

/**
 * 每个角色的硬性上限。编辑器的滑杆在此处被截断，而它们的总和就是构建这条带状几何
 * 时使用的实例数 —— 一个缓冲区，只分配一次。
 */
const MAX_LEASH = 6;
const MAX_COLUMN = 16;
const MAX_TENDRIL = 20;
const MAX_RIM = 14;
const MAX_FILAMENTS = MAX_LEASH + MAX_COLUMN + MAX_TENDRIL + MAX_RIM;

/**
 * 单根细丝上的采样点数。这是折角能有多细的上限：频率高于每两个节点一个折角的
 * 任何细节都只会产生混叠。
 */
const NODES = 64;

/** 一帧的火花分摊到几个原点发射。单一原点读起来像一次星芒爆发。 */
const SPARK_BATCHES = 5;
/** ……上升气流同理，否则它会变成一根旋转的软管。 */
const UPDRAFT_BATCHES = 4;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();

/**
 * SNARE —— 第一个**远程施放（far cast）**：种在某个点上的陷阱。
 *
 * 另外四个技能都是沿一条直线射出的射击。这一个用圆圈瞄准（见
 * `effects/ZoneIndicator.js`），而这个圆圈与玩家之间达成的约定就是整个技能的
 * 设计：点击之前它画出的那圈粗边界，正是卷须止步之处、边沿电弧巡行之处，也是
 * 之后场域燃烧之处。单个数字 `zoneRadius` 同时驱动指示器与效果的每一部分，所以
 * 拖动它会把承诺与回报一起重新缩放 —— 对一个已经立起来的陷阱也一样。
 *
 * 四个节拍，虽然只有三个阶段：
 *
 *   1. **travel** —— 一条电流牵引索甩过地面直奔目标点，一路留下灼痕。
 *   2. **snap** —— 冲击阶段最初的 `snapTime`：牵引索被丢弃，圆环越过自身半径猛力
 *      弹开再收回到半径上，柱体从正中撕裂着拔起。
 *   3. **hold** —— `lifetime` 的其余部分：笼体反复劈击，卷须爬行，边沿电弧巡行，
 *      整个圆盘上方的空气被拽进立柱里。
 *   4. **collapse** —— `fadeTime`：立柱细成一根线，然后熄灭。
 *
 * 一切都是生成的。笼体是一条实例化的带状几何，它的四种角色在顶点着色器里决定
 * （`materials/SnareMaterial.js`）；场域是一个用到有符号距离与扭曲噪声的四边形；
 * 灼痕是共用的贴花；火花、上升气流、烟尘与碎屑则是 GPU 粒子。
 *
 * **让编辑器得以成立的那条规则。** 一次施放只捕获一个数字 —— 一个种子 —— 外加
 * 几个时间戳。没有记录任何一米、一弧度或一秒：足迹、柱体、卷须、边沿电弧与场域
 * 全都在 update 循环里对着 `settings.snare` 解析，而这个循环在零长度的一帧里
 * 也照样运行。
 */
export class SnareAbility extends Ability {
    constructor(context) {
        super('snare', context);
    }

    /* ------------------------------------------------------------------ */
    /* 构建                                                                */
    /* ------------------------------------------------------------------ */

    createShaders() {
        this.geometry = createBoltRibbonGeometry(NODES, MAX_FILAMENTS);

        // 对同一批细丝做两遍：下面是一层宽阔柔和的光晕，上面是炽热的芯线。把辉光当作
        // 真实带状几何来画、而不是丢给 bloom 去补，才能让它紧贴每一处折角。
        this.glowMaterial = createSnareCageMaterial(SnarePass.GLOW);
        this.coreMaterial = createSnareCageMaterial(SnarePass.CORE);
        this.cageMaterials = [this.glowMaterial, this.coreMaterial];

        this.meshes = [];
        for (const [index, material] of this.cageMaterials.entries()) {
            const mesh = new Mesh(this.geometry, material);
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            mesh.layers.set(LAYER.VFX);
            mesh.renderOrder = 11 + index * 2;
            this.group.add(mesh);
            this.meshes.push(mesh);
        }

        /* ---- 地面上的场域 ---- */
        this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
        this.fieldMaterial = createSnareFieldMaterial();
        this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
        this.field.name = 'SnareField';
        this.field.layers.set(LAYER.VFX);
        this.field.renderOrder = 7; // 在贴花之上，笼体之下
        this.field.frustumCulled = false;
        this.group.add(this.field);

        /** 每次施放都重新掷一次，这样两个陷阱不会画出同样的形状。 */
        this._seed = 0;
        /** 圆环开始张开以来的秒数。只驱动炸开那一下，别的都不管。 */
        this._openTime = 0;
        /** 已经以地面灼痕形式付出的牵引索行进米数。 */
        this._burnDistance = 0;
        this._filamentCount = 1;

        // 每帧交给材质的临时状态。一个对象反复复用 —— 同步陷阱不产生任何分配。
        this._state = {
            centre: new Vector3(),
            hand: new Vector3(),
            front: new Vector3(),
            radius: 1,
            height: 1,
            fade: 1,
            seed: 0,
            counts: { leash: 0, column: 0, tendril: 0, rim: 0 },
        };
        this._fieldState = { radius: 1, quadSize: 1, fade: 1, seed: 0 };
    }

    createParticles() {
        const particles = this.ctx.particles;

        // 火花：受重力作用、随速度拉长的条纹，从笼体上甩出来。
        this.sparks = particles.get('snare.sparks', {
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

        // 上升气流 —— 这个技能的招牌系统。微尘从整个圆盘上被拾起，向内收拢并被拽上
        // 立柱；正是这个读感在说陷阱在拉扯空气，而不是干坐在那里。
        this.updraft = particles.get('snare.updraft', {
            capacity: 3000,
            shape: ParticleShape.SOFT,
            additive: true,
            curl: true,
            softFade: 0.4,
        });
        this.updraft.uniforms.uDrag.value = 0.9;
        this.updraft.uniforms.uEndSize.value = 0.2;
        this.updraft.uniforms.uSizeIn.value = 0.05;
        this.updraft.uniforms.uFadeIn.value = 0.1;
        this.updraft.uniforms.uFadeOut.value = 0.45;

        // 从烧焦地面上刮下来的烟霾。非加性，这样它才真的会遮挡。
        this.smoke = particles.get('snare.smoke', {
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

        // 从圆环内部的地面上撕下来的碎屑。
        this.debris = particles.get('snare.debris', {
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
        this.updraftEmitter = new RateEmitter();
        this.smokeEmitter = new RateEmitter();
        this.debrisEmitter = new RateEmitter();
        this.arcEmitter = new RateEmitter();
        this.pulseEmitter = new RateEmitter();
        this.ringEmitter = new RateEmitter();
    }

    /* ------------------------------------------------------------------ */
    /* 计时                                                                */
    /* ------------------------------------------------------------------ */

    get instanceCount() {
        return this._filamentCount * this.meshes.length;
    }

    /** 陷阱先炸开，然后立住。 */
    get impactDuration() {
        return Math.max(0.05, settings.snare.lifetime * settings.global.lifetime);
    }

    get fadeDuration() {
        return Math.max(0.05, settings.snare.fadeTime);
    }

    /** 笼体会在冰面反光之处忽明忽暗 —— 一种生硬、量化的抖动。 */
    lightShimmer() {
        const c = settings.snare;
        const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
        const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
        return 1 - saturate(c.lightFlicker) * noise;
    }

    /* ------------------------------------------------------------------ */
    /* 几何 —— 每一米都从实时设置解析出来                                  */
    /* ------------------------------------------------------------------ */

    /** 牵引索离开施法者手部的位置，世界空间。 */
    _handPoint(out) {
        const c = settings.snare;
        out.copy(this.origin).addScaledVector(this.direction, c.handForward).addScaledVector(this.side, c.handSide);
        out.y = c.handHeight;
        return out;
    }

    /** 陷阱的中心 —— 瞄准线的远端。 */
    _centrePoint(out) {
        return this.pointAt(1, out).setY(0);
    }

    /** 牵引索行进中的末端。一旦抵达就被钉在中心上。 */
    _frontPoint(out) {
        const c = settings.snare;
        const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
        return this.pointAt(u, out).setY(c.leashCling);
    }

    /**
     * 圆环张开了多少（0..1），以及柱体爬升了多高。
     *
     * 两者都只是 `_openTime` 对实时 `snapTime` 的纯函数，所以滑杆在施放途中被拖动时，
     * 炸开过程会自己重新计时。圆环会冲过自身半径再收回半径上 —— 与指示器弹出的那条
     * 曲线相同，这才让陷阱看起来像那个圆圈*变成*了真的，而不是另一段不相干的动画。
     */
    _openAmount() {
        const snap = Math.max(0.01, settings.snare.snapTime);
        const t = saturate(this._openTime / snap);
        const bump = Math.sin(Math.PI * Math.pow(t, 1.7));
        return Easing.outCubic(t) * (1 + 0.16 * bump);
    }

    _climbAmount() {
        // 立柱起步比圆环慢：地面先动，然后其上的空气才溃散开来。
        const snap = Math.max(0.01, settings.snare.snapTime) * 1.7;
        return Easing.outCubic(saturate(this._openTime / snap));
    }

    /** 实时足迹，单位米。也就是指示器量出来的那个。 */
    get radius() {
        return Math.max(0.05, settings.snare.zoneRadius);
    }

    /* ------------------------------------------------------------------ */
    /* 施放                                                                */
    /* ------------------------------------------------------------------ */

    onSpawn() {
        this.sparkEmitter.reset();
        this.updraftEmitter.reset();
        this.smokeEmitter.reset();
        this.debrisEmitter.reset();
        this.arcEmitter.reset();
        this.pulseEmitter.reset();
        this.ringEmitter.reset();

        this._burnDistance = 0;
        this._openTime = 0;
        // 一次施放唯一捕获的东西。其余一切都在每帧解析。
        this._seed = Math.random() * 100;
        this.field.rotation.y = Math.random() * TAU;

        this._sync(1);
        this._muzzleFx();
    }

    /* ------------------------------------------------------------------ */
    /* 反馈                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 把实时设置与当前施放状态推进两个笼体 pass、场域以及四个粒子系统。
     *
     * @param {number} fade 陷阱亮着时为 1，崩塌时渐变到 0
     */
    _sync(fade) {
        const c = settings.snare;
        const g = settings.global;
        const state = this._state;
        const travelling = this.phase === AbilityPhase.TRAVEL;

        this._centrePoint(state.centre);
        this._handPoint(state.hand);
        this._frontPoint(state.front);

        const open = travelling ? 0 : this._openAmount();
        state.radius = Math.max(0.05, this.radius * open);
        state.height = Math.max(0.05, c.height * (travelling ? 0 : this._climbAmount()));
        state.fade = fade;
        state.seed = this._seed;

        // 角色的退场方式是把它的数量设为零，圆环接手的那一瞬间鞭索就是这样消失的。
        const counts = state.counts;
        counts.leash = travelling ? clampCount(c.leashStrands, MAX_LEASH) : 0;
        counts.column = travelling ? 0 : clampCount(c.strands, MAX_COLUMN);
        counts.tendril = travelling ? 0 : clampCount(c.tendrils, MAX_TENDRIL);
        counts.rim = travelling ? 0 : clampCount(c.rimArcs, MAX_RIM);

        this._filamentCount = counts.leash + counts.column + counts.tendril + counts.rim;
        this.geometry.instanceCount = Math.max(1, this._filamentCount);

        for (const material of this.cageMaterials) material.userData.sync(state);

        /* --- 场域 --- */
        const fieldState = this._fieldState;
        fieldState.radius = state.radius;
        fieldState.quadSize = (this.radius + c.fieldBoundary + 0.6) * 2;
        fieldState.fade = travelling ? 0 : fade;
        fieldState.seed = this._seed;
        this.fieldMaterial.userData.sync(fieldState);

        this.field.visible = !travelling;
        this.field.position.set(state.centre.x, c.fieldHeight, state.centre.z);
        this.field.scale.set(fieldState.quadSize, 1, fieldState.quadSize);

        /* --- 四个粒子系统，全都在这 --- */
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

        this.updraft.setGradient(
            getColor(c.colorUpdraftA),
            getColor(c.colorUpdraftB),
            getColor(c.colorUpdraftC),
            getColor(c.colorUpdraftD)
        );
        // 正的 gravity：立柱在把它们抬起来，而不是往下压。
        this.updraft.uniforms.uGravity.value.set(0, c.updraftRise, 0);
        this.updraft.uniforms.uSizeScale.value = c.updraftSize * g.particleSize * 7;
        this.updraft.uniforms.uLifeScale.value = c.updraftLifetime * 0.5 * g.particleLifetime;
        this.updraft.uniforms.uSpeedScale.value = g.particleSpeed;
        this.updraft.uniforms.uOpacity.value = g.opacity;
        this.updraft.uniforms.uGlow.value = 1.1 * g.glow;
        this.updraft.uniforms.uTurbulence.value = c.updraftTurbulence * g.turbulence;

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

    /** 牵引索离开施法者手部时，手上闪的那一下。 */
    _muzzleFx() {
        const c = settings.snare;
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
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstB),
            colorC: getColor(c.colorBurstC),
        });

        _emit.position = _pos;
        _emit.radius = 0.16;
        _emit.direction = _dir.copy(this.direction);
        _emit.speed = c.sparkSpeed * 1.4;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.8;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.18;
        _emit.sizeVariance = 0.7;
        _emit.life = c.sparkLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = frame.uTime.value;
        this.sparks.emit(Math.round(34 * g.particleCount), _emit);

        this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
    }

    /** 牵引索上的火花与它下方的灼痕，发生在它冲向目标点的过程中。 */
    _leashFx(dt) {
        const c = settings.snare;
        const g = settings.global;
        const time = frame.uTime.value;

        const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * 0.5) * g.particleCount);
        if (sparkCount > 0) {
            _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.6).normalize();
            _emit.speed = c.sparkSpeed * 0.8;
            _emit.speedVariance = 0.85;
            _emit.spread = 1.0;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.14;
            _emit.sizeVariance = 0.7;
            _emit.life = c.sparkLifetime * 0.8;
            _emit.lifeVariance = 0.55;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;

            let remaining = sparkCount;
            const per = Math.ceil(sparkCount / Math.min(sparkCount, SPARK_BATCHES));
            while (remaining > 0) {
                this.pointAt(randRange(0.1, 1) * this.u, _pos).setY(c.leashCling + 0.05);
                _emit.position = _pos;
                _emit.radius = 0.22;
                this.sparks.emit(Math.min(per, remaining), _emit);
                remaining -= per;
            }
        }

        // 按行进米数付出的灼痕，从线上抖开，免得读起来像一串点状拖尾。
        const step = 1 / Math.max(0.05, c.trailRate);
        while (this.front - this._burnDistance >= step) {
            this._burnDistance += step;
            const s = saturate(this._burnDistance / this.length);
            this.pointAt(s, _pos);
            _pos.x += this.side.x * randRange(-0.4, 0.4);
            _pos.z += this.side.z * randRange(-0.4, 0.4);

            this.ctx.decals.spawn(DecalType.ARC, _pos, {
                radius: c.arcRadius * randRange(0.5, 0.85),
                life: c.arcLife * 0.7,
                width: c.arcBranches,
                intensity: c.arcIntensity * 0.8,
                colorA: getColor(c.colorEmber),
                colorB: getColor(c.colorArc),
            });
        }
    }

    /**
     * 站立的陷阱抖落出的一切：笼体上的火花、上升气流、烟尘、碎屑、绕着边沿走的
     * 灼痕、压力壳与尘环。
     *
     * @param {number} scale 0..1 —— 随着陷阱崩塌而变稀
     */
    _fieldFx(dt, scale) {
        const c = settings.snare;
        const g = settings.global;
        const time = frame.uTime.value;
        const centre = this._state.centre;
        const radius = this._state.radius;
        const height = this._state.height;

        /* --- 火花，从立柱上、也从边沿上甩出来 --- */
        let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
        if (sparkCount > 0) {
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

            const per = Math.ceil(sparkCount / Math.min(sparkCount, SPARK_BATCHES));
            while (sparkCount > 0) {
                // 三分之二出自立柱，三分之一出自边界 —— 立柱才是响的那部分，但一圈没有
                // 火花的边沿看起来就像画上去的。
                if (Math.random() < 0.66) {
                    _pos.copy(centre).setY(randRange(0.1, 1) * height);
                    _emit.radius = radius * c.columnSpread * 1.4 + 0.1;
                    _emit.direction = _dir.set(0, 1, 0);
                } else {
                    const a = Math.random() * TAU;
                    _pos.set(centre.x + Math.cos(a) * radius, 0.08, centre.z + Math.sin(a) * radius);
                    _emit.radius = 0.25;
                    _emit.direction = _dir.set(Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4).normalize();
                }
                _emit.position = _pos;
                this.sparks.emit(Math.min(per, sparkCount), _emit);
                sparkCount -= per;
            }
        }

        /* --- 上升气流：从圆盘上被拾起，收拢着向内、向上 --- */
        let updraftCount = Math.round(this.updraftEmitter.tick(dt, c.updraftRate * scale) * g.particleCount);
        if (updraftCount > 0) {
            _emit.speed = c.updraftSpeed;
            _emit.speedVariance = 0.5;
            _emit.spread = 0.25; // 很紧：这些是被拽走的，不是被扔出去的
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.09;
            _emit.sizeVariance = 0.6;
            _emit.life = c.updraftLifetime;
            _emit.lifeVariance = 0.45;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;

            const per = Math.ceil(updraftCount / Math.min(updraftCount, UPDRAFT_BATCHES));
            while (updraftCount > 0) {
                const a = Math.random() * TAU;
                const r = radius * (1 - c.updraftInset) * Math.sqrt(Math.random());
                _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.5), centre.z + Math.sin(a) * r);
                _emit.position = _pos;
                _emit.radius = 0.2;
                // 向内、向上 —— 涡旋来自 curl noise，而不是来自一个切向速度，所以它保持
                // 柔和，不会读成一台风扇。
                _emit.direction = _dir
                    .set(centre.x - _pos.x, 0, centre.z - _pos.z)
                    .normalize()
                    .multiplyScalar(0.8)
                    .setY(1)
                    .normalize();
                this.updraft.emit(Math.min(per, updraftCount), _emit);
                updraftCount -= per;
            }
        }

        /* --- 烧焦地面腾起的烟尘 --- */
        const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
        if (smokeCount > 0) {
            const a = Math.random() * TAU;
            const r = radius * Math.sqrt(Math.random());
            _pos.set(centre.x + Math.cos(a) * r, 0.15, centre.z + Math.sin(a) * r);
            _emit.position = _pos;
            _emit.radius = radius * 0.25;
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

        /* --- 从地面上撕下来的碎屑 --- */
        const debrisCount = Math.round(this.debrisEmitter.tick(dt, c.debrisRate * scale) * g.particleCount);
        if (debrisCount > 0) {
            const a = Math.random() * TAU;
            const r = radius * Math.sqrt(Math.random());
            _pos.set(centre.x + Math.cos(a) * r, 0.06, centre.z + Math.sin(a) * r);
            _emit.position = _pos;
            _emit.radius = 0.3;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.debrisSpeed;
            _emit.speedVariance = 0.75;
            _emit.spread = 0.7;
            _emit.size = 0.1;
            _emit.sizeVariance = 0.7;
            _emit.life = c.debrisLifetime;
            _emit.lifeVariance = 0.5;
            _emit.spin = 8;
            _emit.time = time;
            this.debris.emit(debrisCount, _emit);
        }

        /* --- 绕着边界行走的灼痕 --- */
        const arcCount = this.arcEmitter.tick(dt, c.arcRate * scale);
        for (let i = 0; i < arcCount; i++) {
            const a = Math.random() * TAU;
            const r = radius * randRange(0.72, 1.02);
            _pos.set(centre.x + Math.cos(a) * r, 0, centre.z + Math.sin(a) * r);
            this.ctx.decals.spawn(DecalType.ARC, _pos, {
                radius: c.arcRadius * randRange(0.7, 1.25),
                life: c.arcLife,
                width: c.arcBranches,
                intensity: c.arcIntensity,
                colorA: getColor(c.colorEmber),
                colorB: getColor(c.colorArc),
            });
        }

        /* --- 从立柱根部脱落的压力壳 --- */
        // 刻意压得低、小、淡。这么大小的壳若在立柱半高处释放，会像一只多面玻璃罩悬在
        // 空中 —— 它必须靠下方地面的衬托，才能读成从撞击处迸出的压力，而不是一枚停在
        // 半空的泡泡。
        const pulseCount = this.pulseEmitter.tick(dt, c.pulseRate * scale);
        for (let i = 0; i < pulseCount; i++) {
            _pos.copy(centre).setY(height * randRange(0.02, 0.14));
            this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
                radius: c.pulseSize * 0.25,
                endRadius: c.pulseSize * g.explosionIntensity,
                life: 0.42,
                intensity: c.pulseIntensity,
                opacity: 0.3,
                fresnel: 2.2,
                displace: 0.5,
                squash: 0.45, // 压扁：压力在地面上铺开
                colorA: getColor(c.colorBurstA),
                colorB: getColor(c.colorBurstB),
                colorC: getColor(c.colorBurstC),
            });
        }

        /* --- 从地面上推出去的尘环 --- */
        const ringCount = this.ringEmitter.tick(dt, c.ringRate * scale);
        for (let i = 0; i < ringCount; i++) {
            this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
                radius: radius * 1.05,
                life: 0.7,
                width: 0.06,
                intensity: 0.6,
                colorA: getColor(c.colorShockA),
                colorB: getColor(c.colorShockB),
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* 阶段                                                                */
    /* ------------------------------------------------------------------ */

    onTravel(dt) {
        this._sync(1);

        // 光点跟着牵引索的末端跑，略微离开地面。
        this._frontPoint(this.position);
        this.position.y += 0.3;

        this._leashFx(dt);
        this.ctx.shake.rumble(settings.snare.rumble * settings.global.cameraShake, dt);
    }

    onImpact() {
        const c = settings.snare;
        const g = settings.global;
        const time = frame.uTime.value;

        this._openTime = 0;
        this._centrePoint(_pos);

        /* 圆环张开时甩出的那层电离空气壳 */
        // 短且压扁：壳必须在陷阱落定之前消失，否则立起来的立柱一辈子都罩在一口穹顶里。
        this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
            radius: c.burstSize * 0.2,
            endRadius: c.burstSize * g.explosionIntensity,
            life: 0.45,
            intensity: c.burstIntensity,
            opacity: 0.6,
            fresnel: 1.6,
            displace: 0.6,
            squash: 0.55,
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstB),
            colorC: getColor(c.colorBurstC),
        });

        /* 越过边界、在地面上向外炸开的那道圆环 */
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
            radius: c.shockRadius * g.explosionIntensity,
            life: 0.65,
            width: 0.05,
            intensity: 1.0,
            colorA: getColor(c.colorShockA),
            colorB: getColor(c.colorShockB),
        });

        /* 陷阱所立足的那片暗色灼烧印 */
        this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
            radius: c.scorchRadius,
            life: c.scorchLife,
            intensity: c.scorchIntensity,
            colorA: getColor(c.colorScorch),
            colorB: getColor(c.colorEmber),
            height: 0.012,
        });

        /* 它接地时沿边界砸出的灼痕 */
        const marks = 6;
        for (let i = 0; i < marks; i++) {
            const a = (i / marks + Math.random() * 0.1) * TAU;
            const r = this.radius * randRange(0.85, 1.0);
            this._centrePoint(_pos);
            _pos.x += Math.cos(a) * r;
            _pos.z += Math.sin(a) * r;
            this.ctx.decals.spawn(DecalType.ARC, _pos, {
                radius: c.arcRadius * randRange(1.1, 1.7),
                life: c.arcLife * 1.5,
                width: c.arcBranches,
                intensity: c.arcIntensity,
                colorA: getColor(c.colorEmber),
                colorB: getColor(c.colorArc),
            });
        }

        /* 炸开时喷出的火花与碎屑 */
        this._centrePoint(_pos);
        _emit.position = _pos;
        _emit.radius = this.radius * 0.35;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.sparkSpeed * 1.9;
        _emit.speedVariance = 0.85;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.2;
        _emit.sizeVariance = 0.8;
        _emit.life = c.sparkLifetime * 1.4;
        _emit.lifeVariance = 0.6;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

        _emit.radius = this.radius * 0.6;
        _emit.speed = c.debrisSpeed * 1.7;
        _emit.spread = 0.8;
        _emit.size = 0.13;
        _emit.life = c.debrisLifetime * 1.3;
        _emit.spin = 10;
        this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

        _emit.speed = c.smokeSpeed * 2.0;
        _emit.spread = 1.0;
        _emit.size = 1.4;
        _emit.life = c.smokeLifetime * 1.2;
        _emit.spin = 0.5;
        this.smoke.emit(Math.round(40 * g.particleCount), _emit);

        this.ctx.shake.add(
            c.impactShake * g.explosionIntensity * g.cameraShake,
            1 / Math.max(0.1, c.shakeDuration),
            24
        );
        this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
    }

    onFade(dt, t) {
        const c = settings.snare;
        this._openTime += dt;

        // `t` 在陷阱站立期间走 0..1，崩塌期间走 1..2。退出时用三次方曲线，这样立柱会
        // 先撑住、然后消失，而不是一路变暗。
        const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
        this._sync(fade);

        // 光点爬进柱体里，并停在那里。
        this._centrePoint(this.position);
        this.position.y = this._state.height * saturate(c.lightHeight);

        this._fieldFx(dt, fade * (t <= 1 ? 1 : 0.4));
        this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
    }

    onDestroy() {
        this._filamentCount = 1;
        this.geometry.instanceCount = 1;
        this.field.visible = false;
        for (const material of this.cageMaterials) material.uniforms.uFade.value = 0;
        this.fieldMaterial.uniforms.uFade.value = 0;
    }

    dispose() {
        this.geometry.dispose();
        this.fieldGeometry.dispose();
        for (const material of this.cageMaterials) material.dispose();
        this.fieldMaterial.dispose();
        super.dispose();
    }
}

/** 把滑杆截断到它所属角色的硬性上限，并且永不低于一根细丝。 */
function clampCount(value, max) {
    return Math.max(0, Math.min(max, Math.round(value)));
}
