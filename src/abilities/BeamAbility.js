import { IcosahedronGeometry, Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createBeamMaterial, BeamPass } from '../materials/BeamMaterial.js';
import {
    createBeamTubeGeometry,
    createBeamRingGeometry,
    createBoltRibbonGeometry,
} from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** 硬上限。编辑器的 `coils` / `rings` 滑块就钳制在这里。 */
const MAX_COILS = 8;
const MAX_RINGS = 12;

/** 光柱的细分程度。这些数字里不含任何关于*形状*的设定。 */
const TUBE_NODES = 96;
const TUBE_SIDES = 26;
const COIL_NODES = 128;
const RING_SEGMENTS = 44;

/**
 * 一帧的火花要分摊到光柱上的多少个点。与闪电一样：单一原点会让每一批
 * 火花都读成星爆状，而光束是沿整条长度散落的。
 */
const SPARK_BATCHES = 5;

const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _radial = new Vector3();
const _target = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * BEAM —— 一道驻留在瞄准线上的持续光柱。
 *
 * 另外三个技能都是三拍，它有四拍。施法者先双手卷起一团光球（`charge`），
 * 再把它放出去，化作一道以 `speed` 冲向远方的光柱，*保持*在那里对着地面
 * 灼烧 `lifetime` 秒，最后让它在 `fadeTime` 内塌缩回一根细线。持续保持
 * 才是这个技能的要点：它是沙盒里唯一一个落地一秒之后仍在持续施放的技能。
 *
 * 多出来的这一拍完全没向基类要任何东西。`advance()` 只是拒绝让前端离开
 * 手心，直到光球蓄满能量为止，因此相位状态机照旧走 travel → impact →
 * fade，而 `IMPACT`（命中）那一段就成了灼烧。
 *
 * 一切都是生成的：光柱是一根参数化圆管，按三种半径画三遍；线圈是把闪电的
 * 带状条弯成螺旋；冲击圆盘是一个实例化的圆环，被时钟推着滑向远方；蓄能球
 * 是被噪声侵蚀过的球体；而火花、微粒、蒸汽和碎屑都是 GPU 粒子。不从磁盘
 * 加载任何东西，也没有任何东西是贴图。
 *
 * **不是电属性。** 风暴长枪的全部性格在于它的噪声是分段线性的、并且保留着
 * 折角；而这里每一个噪声项都是平滑的，沿流动方向被拉得很长，并一路向远方
 * 爬行 —— 因为会折弯的光柱就是闪电。这两个技能共用同一个色系是刻意的 ——
 * 把它们区分开的完全只是运动方式。
 *
 * **让编辑器可用的那条规则。** 一次施放只捕获一个数字 —— `_seed`，好让
 * 两道光束不会画出完全相同的光柱 —— 外加若干时间戳。每一米、每一弧度和
 * 每一秒都在每一帧对照 `settings.beam` 解算，零长度的一帧也不例外。拖动
 * `radius` 会重新钻出一根已经在灼烧的光束；拖动 `coilTurns` 会重新缠绕
 * 它的飘带；拖动 `flare` 会重新张开远端的锥体。用 **P** 在灼烧中途暂停，
 * 就是为了这个。
 */
export class BeamAbility extends Ability {
    constructor(context) {
        super('beam', context);
    }

    /* ------------------------------------------------------------------ */
    /* 构建                                                                */
    /* ------------------------------------------------------------------ */

    createShaders() {
        this.tubeGeometry = createBeamTubeGeometry(TUBE_NODES, TUBE_SIDES);
        this.coilGeometry = createBoltRibbonGeometry(COIL_NODES, MAX_COILS);
        this.ringGeometry = createBeamRingGeometry(MAX_RINGS, RING_SEGMENTS);
        this.orbGeometry = new IcosahedronGeometry(1, 4);

        /*
         * 三个几何体、六个 pass。三个圆管 pass 是同一个网格的三种半径 ——
         * 关于核心（core）为什么相对包裹它的外壳（sheath）是里外翻转地加权的，
         * 见 `materials/BeamMaterial.js`。
         *
         * 这里的一切都是加法混合且关闭了 `depthWrite`，所以绘制顺序与正确性
         * 无关；这些渲染顺序只是让这个技能与其他 VFX 处在同一个区间里。
         */
        const passes = [
            [BeamPass.HALO, this.tubeGeometry, 11],
            [BeamPass.SHELL, this.tubeGeometry, 12],
            [BeamPass.CORE, this.tubeGeometry, 13],
            [BeamPass.COIL, this.coilGeometry, 13],
            [BeamPass.RING, this.ringGeometry, 13],
            [BeamPass.ORB, this.orbGeometry, 14],
        ];

        this.materials = [];
        this.meshes = [];
        for (const [pass, geometry, renderOrder] of passes) {
            const material = createBeamMaterial(pass);
            const mesh = new Mesh(geometry, material);
            mesh.frustumCulled = false;
            mesh.layers.set(LAYER.VFX);
            mesh.renderOrder = renderOrder;
            // 除光球之外，每个 pass 都由它的顶点着色器放到世界空间里。光球是唯一
            // 跟随模型矩阵的东西，因为技能需要在蓄能的过程中移动并缩放它。
            if (pass === BeamPass.ORB) this.orbMesh = mesh;
            else mesh.matrixAutoUpdate = false;
            this.group.add(mesh);
            this.materials.push(material);
            this.meshes.push(mesh);
        }

        /** 每次施放都重新随机，让两道光束不会画出相同的光柱。 */
        this._seed = 0;
        this._coilCount = 1;
        this._ringCount = 1;
        /** 光球是否已经松手 —— 释放只会触发一次。 */
        this._fired = false;
        /** 前端行程中已经结算成地面灼烧的米数。 */
        this._burnDistance = 0;
        /** 停在施法者双手之间的那盏光。随施放一起释放。 */
        this.muzzleLight = null;

        // 每帧交给全部六个材质的暂存状态。就一个对象，反复复用 ——
        // 同步光束时不产生任何内存分配。
        this._state = {
            origin: new Vector3(),
            target: new Vector3(),
            side: new Vector3(),
            progress: 0,
            fade: 1,
            widthFade: 1,
            charge: 0,
            seed: 0,
            coils: 1,
            rings: 1,
        };
    }

    createParticles() {
        const particles = this.ctx.particles;

        // 从光柱上洒落的火花：按速度拉长的条纹，先沿径向抛出，
        // 随后被 `sparkForward` 拖向远方。
        this.sparks = particles.get('beam.sparks', {
            capacity: 5000,
            shape: ParticleShape.STREAK,
            additive: true,
            stretch: true,
            softFade: 0.25,
        });
        this.sparks.uniforms.uDrag.value = 1.5;
        this.sparks.uniforms.uEndSize.value = 0.2;
        this.sparks.uniforms.uSizeIn.value = 0.02;
        this.sparks.uniforms.uFadeIn.value = 0.03;
        this.sparks.uniforms.uFadeOut.value = 0.4;

        // 微粒（motes）：蓄能时盘旋着被吸进光球的那股吸入流，以及开火之后
        // 缭绕在光柱周围的飘浮物。一套系统，两份差事 —— 它们是同一种光晕，
        // 区别只在于被抛出的方向。
        this.motes = particles.get('beam.motes', {
            capacity: 3600,
            shape: ParticleShape.SOFT,
            additive: true,
            curl: true,
            softFade: 0.4,
        });
        this.motes.uniforms.uDrag.value = 1.1;
        this.motes.uniforms.uEndSize.value = 0.12;
        this.motes.uniforms.uSizeIn.value = 0.05;
        this.motes.uniforms.uFadeIn.value = 0.07;
        this.motes.uniforms.uFadeOut.value = 0.35;

        // 从灼烧点下方的地面上被冲刷起来的蒸汽。非加法混合，因此会遮挡。
        this.smoke = particles.get('beam.smoke', {
            capacity: 2200,
            shape: ParticleShape.SMOKE,
            additive: false,
            curl: true,
            softFade: 1.1,
        });
        this.smoke.uniforms.uDrag.value = 1.7;
        this.smoke.uniforms.uEndSize.value = 3.2;
        this.smoke.uniforms.uSizeIn.value = 0.12;
        this.smoke.uniforms.uFadeIn.value = 0.18;
        this.smoke.uniforms.uFadeOut.value = 0.3;

        // 沿灼烧线从地面上掀起来的碎屑。
        this.debris = particles.get('beam.debris', {
            capacity: 1800,
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
        this.intakeEmitter = new RateEmitter();
        this.smokeEmitter = new RateEmitter();
        this.debrisEmitter = new RateEmitter();
        this.splashEmitter = new RateEmitter();
        // 贴花和压力壳也走粒子用的同一个分数速率发射器来限流，
        // 这样"每秒多少个环"就与帧率无关。
        this.pulseEmitter = new RateEmitter();
        this.dustEmitter = new RateEmitter();
        this.shockEmitter = new RateEmitter();
    }

    /* ------------------------------------------------------------------ */
    /* 时序                                                                */
    /* ------------------------------------------------------------------ */

    get instanceCount() {
        // 三个圆管 pass、线圈、圆盘，还有光球。
        return 4 + this._coilCount + this._ringCount;
    }

    /** 光束在它落地的地方灼烧，然后塌缩。 */
    get impactDuration() {
        return Math.max(0.05, settings.beam.lifetime * settings.global.lifetime);
    }

    get fadeDuration() {
        return Math.max(0.05, settings.beam.fadeTime);
    }

    /** 光球蓄能蓄到了什么程度，0..1。 */
    get charge() {
        return saturate(this.age / Math.max(0.01, settings.beam.charge));
    }

    /**
     * 光束是嗡鸣，闪电才是忽明忽暗 —— 一条缓慢的正弦，而不是量化过的抖动。
     * 这里*绝不能*发生的一件事是闪烁：那会立刻被读成风暴长枪的光。
     */
    lightShimmer() {
        const c = settings.beam;
        return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
    }

    /**
     * 把前端按在手心里，直到光球蓄满能量。
     *
     * 这就是第四拍的全部。基类是在最初的零点几秒内从静止缓入；这里同样的
     * 缓入改为以释放的那一刻为基准，而不是以施放的那一刻为基准。
     */
    advance(dt) {
        const c = this.config;
        const charge = Math.max(0, c.charge);
        if (this.age < charge) return false;

        const speed = c.speed * settings.global.speed;
        const since = this.age - charge;
        this.front += speed * Easing.outQuad(saturate(since / 0.05)) * dt;

        const previousU = this.u;
        this.u = saturate(this.front / this.length);
        this.pointAt(this.u, this.position);
        return this.u >= 1 && previousU < 1;
    }

    /* ------------------------------------------------------------------ */
    /* 光束的几何 —— 每一米都由实时设置解算                                */
    /* ------------------------------------------------------------------ */

    /**
     * 光柱离开施法者的位置，世界空间。
     *
     * 基类把 `origin` 放在地板上，因为瞄准指示器瞄准的就是那里；而光束是从
     * 一双手里出来的，所以这些偏移在这里施加，而不是被烘焙进施放过程里。
     */
    _handPoint(out) {
        const c = settings.beam;
        out.copy(this.origin).addScaledVector(this.direction, c.handForward).addScaledVector(this.side, c.handSide);
        out.y = c.handHeight;
        return out;
    }

    /** 它落在哪里。 */
    _impactPoint(out) {
        this.pointAt(1, out);
        out.y = settings.beam.endHeight;
        return out;
    }

    /**
     * 光柱*轴线*上沿其长度 `s` 处的一点，0..1。
     *
     * 与顶点着色器的第一阶段对应，但去掉了不足分米级的漂移，这样 CPU 生成的
     * 火花和灼烧就落在 GPU 实际绘制的那道光束上，而不是它附近。
     */
    _axisPoint(s, out) {
        const c = settings.beam;
        const t = saturate(s);
        out.copy(this.origin)
            .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
            .addScaledVector(this.side, c.handSide * (1 - t));
        out.y = lerp(c.handHeight, c.endHeight, t);
        return out;
    }

    /**
     * 光柱在 `s` 处的半宽，单位米 —— 火花会被抛离轴线多远。与着色器里的
     * `beamRadius()` 对应，但去掉了脉动，这样喷溅就落在 GPU 正在绘制的那层
     * 表面上。
     */
    _beamRadius(s) {
        const c = settings.beam;
        const t = saturate(s);
        const r = lerp(c.radiusNear, c.radius, Math.pow(t, Math.max(0.01, c.radiusCurve)));
        return r * (1 + c.flare * smoothstep(1 - Math.max(1e-3, c.flareWidth), 1, t));
    }

    /** 垂直于光柱的单位向量，`a` 为绕其一周的弧度角。 */
    _radialAt(a, out) {
        return out.copy(this.side).multiplyScalar(Math.cos(a)).addScaledVector(_up, Math.sin(a)).normalize();
    }

    /* ------------------------------------------------------------------ */
    /* 施放                                                                */
    /* ------------------------------------------------------------------ */

    onSpawn() {
        for (const emitter of [
            this.sparkEmitter,
            this.moteEmitter,
            this.intakeEmitter,
            this.smokeEmitter,
            this.debrisEmitter,
            this.splashEmitter,
            this.pulseEmitter,
            this.dustEmitter,
            this.shockEmitter,
        ]) {
            emitter.reset();
        }

        this._burnDistance = 0;
        this._fired = false;

        // 一次施放唯一捕获的东西。其余一切都逐帧解算。
        this._seed = Math.random() * 100;

        // 第二盏光，停在施法者双手之间，好让起手蓄力真的照亮托着它的身体。
        // 当同时有多次施放在飞行中时，池子可能返回 null —— 下面每一处使用
        // 都有防护。
        this.muzzleLight = this.ctx.lights.acquire();

        this._syncUniforms(0, 1, 1);
    }

    /* ------------------------------------------------------------------ */
    /* 反馈                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 把实时设置和当前施放状态推送到全部六个 pass。
     *
     * @param {number} dt        秒，用于枪口光的缓动
     * @param {number} fade      光束亮着时为 1，随其熄灭渐降到 0
     * @param {number} widthFade 光柱*宽度*的同一路参数 —— 它收成细线的速度比
     *                           变暗更快，正是这一点让熄灭读起来像一个脆断
     */
    _syncUniforms(dt, fade, widthFade) {
        const c = settings.beam;
        const g = settings.global;
        const state = this._state;

        this._handPoint(state.origin);
        this._impactPoint(state.target);
        state.side.copy(this.side);
        state.progress = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
        state.fade = fade;
        state.widthFade = widthFade;
        state.charge = this.charge;
        state.seed = this._seed;

        this._coilCount = Math.max(1, Math.min(MAX_COILS, Math.round(c.coils)));
        this._ringCount = Math.max(1, Math.min(MAX_RINGS, Math.round(c.rings)));
        state.coils = this._coilCount;
        state.rings = this._ringCount;
        this.coilGeometry.instanceCount = this._coilCount;
        this.ringGeometry.instanceCount = this._ringCount;

        for (const material of this.materials) material.userData.sync(state);

        /* --- 光球：在这里定位并定尺寸，在着色器里着色 --- */
        const swell = 1 + c.orbThrob * Math.sin(this.age * c.orbThrobSpeed * TAU);
        const size = c.orbSize * (0.28 + 0.72 * Easing.outCubic(state.charge)) * swell * widthFade;
        this.orbMesh.position.copy(state.origin);
        this.orbMesh.scale.setScalar(Math.max(0.01, size));

        if (this.muzzleLight) {
            this.ctx.lights.set(
                this.muzzleLight,
                state.origin,
                getColor(c.lightColor),
                c.muzzleLightIntensity * state.charge * fade,
                c.muzzleLightRadius,
                dt
            );
        }

        /* --- 粒子系统，一共四套 --- */
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
        this.motes.uniforms.uGlow.value = 1.1 * g.glow;
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
        this.smoke.uniforms.uTurbulence.value = 0.4 * g.turbulence;

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
     * 起手蓄力：把光从空气里*向内*拉来，被光球吞掉。
     *
     * 这就是光柱稍后要洒出的同一套微粒系统，只是抛射方向相反 —— 在双手周围
     * 的一层球壳上发射，速度指向手心。批次很小，方向互相独立，因为每帧只有
     * 一个方向会读成一股水流，而不是一次吸入。
     */
    _intakeFx(dt) {
        const c = settings.beam;
        const g = settings.global;
        const charge = this.charge;
        const time = frame.uTime.value;

        let count = Math.round(this.intakeEmitter.tick(dt, c.intakeRate * (0.35 + charge)) * g.particleCount);
        if (count <= 0) return;

        this._handPoint(_target);
        _emit.radius = 0.12;
        _emit.speedVariance = 0.35;
        _emit.spread = 0.12;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.09;
        _emit.sizeVariance = 0.6;
        _emit.lifeVariance = 0.3;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;

        // 球壳随光球填满而收紧，于是吸入流可见地收拢进来。
        const shell = c.intakeRadius * lerp(1, 0.45, charge);
        const per = Math.max(1, Math.round(count / 6));

        while (count > 0) {
            const theta = Math.random() * TAU;
            const phi = Math.acos(randRange(-1, 1));
            const s = Math.sin(phi);
            _dir.set(s * Math.cos(theta), Math.cos(phi) * 0.7, s * Math.sin(theta)).normalize();

            _pos.copy(_target).addScaledVector(_dir, shell * randRange(0.7, 1.15));
            _emit.position = _pos;
            _emit.direction = _dir.multiplyScalar(-1);
            _emit.speed = c.intakeSpeed;
            _emit.life = (shell / Math.max(0.5, c.intakeSpeed)) * 1.5;
            this.motes.emit(Math.min(per, count), _emit);
            count -= per;
        }
    }

    /** 释放：光球松手，光柱被从它里面甩出去。 */
    _releaseFx() {
        const c = settings.beam;
        const g = settings.global;

        this._handPoint(_pos);

        // 是一层压力壳而不是火球 —— 这里没有东西在燃烧，只是空气被推开了。
        this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
            radius: c.muzzleSize * 0.2,
            endRadius: c.muzzleSize * g.explosionIntensity,
            life: 0.4,
            intensity: c.muzzleIntensity,
            opacity: 0.9,
            fresnel: 2.0,
            displace: 0.35,
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstC),
        });

        // ……以及施法者脚下的地板上同样的一推。
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.origin, {
            radius: c.muzzleSize * 2.2 * g.explosionIntensity,
            life: 0.5,
            width: 0.06,
            intensity: 0.9,
            colorA: getColor(c.colorShockA),
            colorB: getColor(c.colorShockB),
        });

        _emit.position = _pos;
        _emit.radius = 0.22;
        _emit.direction = _dir.copy(this.direction);
        _emit.speed = c.sparkSpeed * 1.8;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.7;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.2;
        _emit.sizeVariance = 0.7;
        _emit.life = c.sparkLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = frame.uTime.value;
        this.sparks.emit(Math.round(70 * g.particleCount), _emit);

        this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
        this.ctx.shake.add(
            c.impactShake * 0.45 * g.explosionIntensity * g.cameraShake,
            1 / Math.max(0.1, c.shakeDuration),
            30
        );
        this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
    }

    /**
     * 光柱沿其长度洒落的东西。
     * @param {number} scale 0..1 —— 随光束塌缩而变稀
     */
    _columnFx(dt, scale) {
        const c = settings.beam;
        const g = settings.global;
        const time = frame.uTime.value;
        // 只有光柱已经画出来的那一段才被允许抛洒任何东西。
        const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;

        let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
        if (sparkCount > 0) {
            _emit.speed = c.sparkSpeed;
            _emit.speedVariance = 0.8;
            _emit.spread = 0.35;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.15;
            _emit.sizeVariance = 0.7;
            _emit.life = c.sparkLifetime;
            _emit.lifeVariance = 0.55;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;

            const per = Math.ceil(sparkCount / Math.min(sparkCount, SPARK_BATCHES));
            while (sparkCount > 0) {
                const s = randRange(0.04, 1) * reach;
                const radius = this._beamRadius(s);
                this._radialAt(Math.random() * TAU, _radial);
                this._axisPoint(s, _pos).addScaledVector(_radial, radius * randRange(0.8, 1.25));

                _emit.position = _pos;
                _emit.radius = radius * 0.3;
                // 从表面抛出，然后被流动拖向远方。这就是"压力"的读感，
                // 也正是火花绝不能与闪电的火花共享的一点 —— 后者的火花是往下掉的。
                _emit.direction = _dir.copy(_radial).addScaledVector(this.direction, c.sparkForward).normalize();
                this.sparks.emit(Math.min(per, sparkCount), _emit);
                sparkCount -= per;
            }
        }

        const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
        if (moteCount > 0) {
            const s = Math.random() * reach;
            this._axisPoint(s, _pos);
            _emit.position = _pos;
            _emit.radius = this._beamRadius(s) * 2.2;
            _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
            _emit.speed = c.moteSpeed;
            _emit.speedVariance = 0.8;
            _emit.spread = 0.9;
            _emit.size = 0.09;
            _emit.sizeVariance = 0.6;
            _emit.life = c.moteLifetime;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.time = time;
            this.motes.emit(moteCount, _emit);
        }

        const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
        if (smokeCount > 0) {
            // 蒸汽来自*地面*，不是光柱，而且是从光柱下方被横着吹出去，
            // 而不是被抬升。
            const s = Math.random() * reach;
            this.pointAt(s, _pos).setY(0.12);
            this._radialAt(randRange(0, TAU), _radial).setY(Math.abs(_radial.y) * 0.35);
            _emit.position = _pos;
            _emit.radius = c.scorchRadius * 1.6;
            _emit.direction = _dir.copy(_radial).normalize();
            _emit.speed = c.smokeSpeed;
            _emit.speedVariance = 0.7;
            _emit.spread = 0.55;
            _emit.size = 0.9;
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
            _emit.radius = c.scorchRadius * 1.4;
            _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
            _emit.speed = c.debrisSpeed;
            _emit.speedVariance = 0.75;
            _emit.spread = 0.8;
            _emit.size = 0.1;
            _emit.sizeVariance = 0.7;
            _emit.life = c.debrisLifetime;
            _emit.lifeVariance = 0.5;
            _emit.spin = 9;
            _emit.time = time;
            this.debris.emit(debrisCount, _emit);
        }
    }

    /** 前缘掠过地面时在地板上留下的灼痕。 */
    _groundFx() {
        const c = settings.beam;
        const step = 1 / Math.max(0.05, c.scorchRate);

        while (this.front - this._burnDistance >= step) {
            this._burnDistance += step;
            const s = saturate(this._burnDistance / this.length);
            this.pointAt(s, _pos);
            // 相对轴线做抖动，这样这条线不会读成一排印章。
            const wander = this._beamRadius(s) * 0.5;
            _pos.x += this.side.x * randRange(-wander, wander);
            _pos.z += this.side.z * randRange(-wander, wander);

            this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
                radius: c.scorchRadius * randRange(0.8, 1.3),
                life: c.scorchLife,
                intensity: c.scorchIntensity,
                colorA: getColor(c.colorScorch),
                colorB: getColor(c.colorEmber),
                height: 0.015,
            });
        }
    }

    /**
     * 光束驻留在远端时，那一头正在做的事。
     *
     * 这是其他三个技能都没有的那一半：一个持续发生的命中。火花被沿光束*反*
     * 抛回来，压力壳从灼烧点脱落，尘土和冲击波环被推着扫过地面 —— 全部按
     * 速率限流，因此与帧率无关，而且每一个速率都是一个实时滑块。
     *
     * @param {number} scale 0..1 —— 随光束塌缩而变稀
     */
    _burnFx(dt, scale) {
        const c = settings.beam;
        const g = settings.global;
        const time = frame.uTime.value;

        this._impactPoint(_pos);
        this.pointAt(1, _target);

        const splash = Math.round(this.splashEmitter.tick(dt, c.splashRate * scale) * g.particleCount);
        if (splash > 0) {
            _emit.position = _pos;
            _emit.radius = this._beamRadius(1) * 0.7;
            // 沿光路往回、并向上：这是有东西被钻削时甩出来的冲刷，
            // 而不是离开它的爆炸。
            _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.65).setY(0.75).normalize();
            _emit.speed = c.sparkSpeed * 1.4;
            _emit.speedVariance = 0.9;
            _emit.spread = 0.95;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.18;
            _emit.sizeVariance = 0.8;
            _emit.life = c.sparkLifetime * 1.2;
            _emit.lifeVariance = 0.6;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;
            this.sparks.emit(splash, _emit);
        }

        if (this.pulseEmitter.tick(dt, c.pulseRate * scale) > 0) {
            this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
                radius: c.pulseSize * 0.25,
                endRadius: c.pulseSize * g.explosionIntensity,
                life: 0.45,
                intensity: c.pulseIntensity,
                opacity: 0.8,
                fresnel: 2.2,
                displace: 0.3,
                squash: 0.85,
                colorA: getColor(c.colorBurstA),
                colorB: getColor(c.colorBurstC),
            });
            this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.2 * g.explosionIntensity);
        }

        if (this.dustEmitter.tick(dt, c.dustRate * scale) > 0) {
            this.ctx.decals.spawn(DecalType.DUSTRING, _target, {
                radius: c.dustRadius * randRange(0.75, 1.15),
                life: c.dustLife,
                intensity: 0.7,
                colorA: getColor(c.colorDustA),
                colorB: getColor(c.colorDustB),
                height: 0.02,
            });
        }

        if (this.shockEmitter.tick(dt, c.shockRate * scale) > 0) {
            this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
                radius: c.shockRadius * 0.55 * g.explosionIntensity,
                life: 0.45,
                width: 0.04,
                intensity: 0.8,
                colorA: getColor(c.colorShockA),
                colorB: getColor(c.colorShockB),
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* 相位                                                                */
    /* ------------------------------------------------------------------ */

    onTravel(dt) {
        const c = settings.beam;
        const g = settings.global;

        this._syncUniforms(dt, 1, 1);

        if (this.age < c.charge) {
            // 仍在起手蓄力。镜头框住的是施法者，不是那条空荡荡的线。
            this._handPoint(this.position);
            this._intakeFx(dt);
            this.ctx.shake.rumble(c.chargeShake * this.charge * g.cameraShake, dt);
            return;
        }

        if (!this._fired) {
            this._fired = true;
            this._releaseFx();
        }

        // 光跟着前缘走，而不是跟着它下方的地面。`advance()` 已经把 `position`
        // 放在了地面线上，所以把它抬到轴线上来。
        this._axisPoint(this.u, this.position);

        this._columnFx(dt, 1);
        this._groundFx();
        this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
    }

    onImpact() {
        const c = settings.beam;
        const g = settings.global;
        const time = frame.uTime.value;

        this._impactPoint(_pos);
        this.pointAt(1, _target);

        /* 它落地处那层被压缩的空气壳 */
        this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
            radius: c.burstSize * 0.18,
            endRadius: c.burstSize * g.explosionIntensity,
            life: 0.75,
            intensity: c.burstIntensity,
            opacity: 0.9,
            fresnel: 1.8,
            displace: 0.5,
            squash: 0.85,
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstB),
            colorC: getColor(c.colorBurstC),
        });

        /* 啪地一下沿地面向外张开的那个环 */
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
            radius: c.shockRadius * g.explosionIntensity,
            life: 0.65,
            width: 0.05,
            intensity: 1.0,
            colorA: getColor(c.colorShockA),
            colorB: getColor(c.colorShockB),
        });

        /* 灼烧点下方一片很宽的焦痕 */
        this.ctx.decals.spawn(DecalType.SCORCH, _target, {
            radius: c.scorchRadius * 3.2,
            life: c.scorchLife * 1.4,
            intensity: c.scorchIntensity * 1.4,
            colorA: getColor(c.colorScorch),
            colorB: getColor(c.colorEmber),
            height: 0.015,
        });
        this.ctx.decals.spawn(DecalType.DUSTRING, _target, {
            radius: c.dustRadius * 1.8,
            life: c.dustLife * 1.6,
            intensity: 0.85,
            colorA: getColor(c.colorDustA),
            colorB: getColor(c.colorDustB),
            height: 0.02,
        });

        /* 从打击处炸出的火花和碎屑 */
        _emit.position = _pos;
        _emit.radius = 0.35;
        _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.35).setY(0.85).normalize();
        _emit.speed = c.sparkSpeed * 2.4;
        _emit.speedVariance = 0.85;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.24;
        _emit.sizeVariance = 0.8;
        _emit.life = c.sparkLifetime * 1.6;
        _emit.lifeVariance = 0.6;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

        _emit.position = _target;
        _emit.radius = c.scorchRadius * 2.2;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.debrisSpeed * 1.9;
        _emit.spread = 0.85;
        _emit.size = 0.14;
        _emit.life = c.debrisLifetime * 1.3;
        _emit.spin = 11;
        this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

        _emit.speed = c.smokeSpeed * 2.4;
        _emit.spread = 1.0;
        _emit.size = 1.4;
        _emit.life = c.smokeLifetime * 1.2;
        _emit.spin = 0.5;
        this.smoke.emit(Math.round(55 * g.particleCount), _emit);

        this.ctx.shake.add(
            c.impactShake * g.explosionIntensity * g.cameraShake,
            1 / Math.max(0.1, c.shakeDuration),
            24
        );
        this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
    }

    onFade(dt, t) {
        const c = settings.beam;
        const g = settings.global;

        // 光束灼烧期间 `t` 从 0 走到 1，随后塌缩期间再从 1 走到 2。
        let fade = 1;
        let widthFade = 1;
        if (t > 1) {
            const k = saturate(t - 1);
            // 亮度先撑着，然后才熄灭；*宽度*则提前收窄。两者合起来读作光柱啪地
            // 收回成一根细线然后熄灭，而不是一根粗光束在慢慢变暗。
            fade = 1 - Easing.inCubic(k);
            widthFade = Math.max(0.04, 1 - Easing.outCubic(k) * 0.94);
        }

        this._syncUniforms(dt, fade, widthFade);

        // 前端抵达之后，这盏光就留在灼烧点上。
        this._axisPoint(1, this.position);

        const scale = t <= 1 ? 1 : fade * 0.5;
        this._columnFx(dt, scale * 0.85);
        this._burnFx(dt, scale);

        if (t <= 1) this.ctx.shake.rumble(c.burnShake * g.cameraShake, dt);
    }

    onDestroy() {
        this.ctx.lights.release(this.muzzleLight);
        this.muzzleLight = null;
        this._coilCount = 1;
        this._ringCount = 1;
        this.coilGeometry.instanceCount = 1;
        this.ringGeometry.instanceCount = 1;
        for (const material of this.materials) {
            material.uniforms.uFade.value = 0;
            material.uniforms.uCharge.value = 0;
        }
    }

    dispose() {
        this.tubeGeometry.dispose();
        this.coilGeometry.dispose();
        this.ringGeometry.dispose();
        this.orbGeometry.dispose();
        for (const material of this.materials) material.dispose();
        super.dispose();
    }
}
