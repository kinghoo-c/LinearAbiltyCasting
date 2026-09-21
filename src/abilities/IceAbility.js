import { InstancedMesh, InstancedBufferAttribute, Object3D, Vector3, Quaternion } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createIceMaterial } from '../materials/IceMaterial.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** 每次施放冰晶数量的硬性上限。编辑器的数量滑杆截断到这个值。 */
const MAX_SPIKES = 288;
/**
 * 冰场中不同的冰晶形状。每一种都是自己的 InstancedMesh —— 三次绘制调用换来真正的
 * 轮廓多样性，这是仅靠逐实例缩放做不到的，因为不同的是*晶面*，而不只是比例。
 */
const VARIANTS = 3;
const SLOTS = Math.ceil(MAX_SPIKES / VARIANTS);
const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();

/**
 * ICE —— 沿瞄准线爆发的一场冰川式喷发。
 *
 * 一个节拍，被拉长来演：一道破裂前锋以 `speed` 从施法者脚下冲出去，它身后一片冰晶
 * 尖刺从地面里撕开钻出 —— 靠近施法者处密集而及踝高，到远端张开成一面刀刃之墙，最后
 * 还有一簇收尾的晶簇在撞击点周围扬起。白霜在地面上蔓延，雾从底部翻滚而出，一缕闪屑
 * 从残骸中袅袅升腾。
 *
 * 一切都是生成的：冰晶是程序化几何，它们的着色是一个打过补丁的标准材质（因此能接受
 * 舞台的阴影与探针），白霜是画在四边形上的着色器，而雾、碎屑与闪屑则是 GPU 粒子。
 * 没有从磁盘加载任何东西。
 *
 * **让编辑器得以成立的那条规则。** 一条冰刺记录只存骰子决定的东西 —— 沿线位置的
 * *比例*、带符号的横向*比例*，以及几个无量纲的抖动值。生成时没有捕获任何一米、一弧度
 * 或一秒；它们全都在 update 循环里对着 `settings.ice` 解析。因此拖动 `height` 会把
 * 一片已经立起来的冰场重新长出来，而且是在时钟暂停的情形下做到的 —— 那才是轮廓真正
 * 值得调的时刻。
 *
 * 一条记录*确实*会捕获的唯一数值是时间戳 —— 它自己那次喷发被触发的时刻。那些是事件，
 * 不是尺寸。
 */
export class IceAbility extends Ability {
    constructor(context) {
        super('ice', context);
    }

    /* ------------------------------------------------------------------ */
    /* 构建                                                                */
    /* ------------------------------------------------------------------ */

    createShaders() {
        const environment = this.ctx.environment;

        this.material = createIceMaterial(environment);

        /** 几何控制项的签名，这样只有发生变化时才会重建。 */
        this._shapeKey = '';

        this.meshes = [];
        this.seedAttributes = [];
        this.birthAttributes = [];

        for (let v = 0; v < VARIANTS; v++) {
            const geometry = this._buildGeometry(v);

            const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
            const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
            for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 10;
            geometry.setAttribute('aSeed', seeds);
            geometry.setAttribute('aBirth', births);

            const mesh = new InstancedMesh(geometry, this.material, SLOTS);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            mesh.count = 0;
            // 实心的世界几何：它属于深度预通道，好让雾与闪屑在与它相交的地方柔和地淡出。
            mesh.layers.set(LAYER.WORLD);
            mesh.renderOrder = 2;
            this.group.add(mesh);

            this.meshes.push(mesh);
            this.seedAttributes.push(seeds);
            this.birthAttributes.push(births);
        }

        /**
         * 固定大小的记录池 —— 一次施放不产生任何分配。
         *
         * 见类注释：只有骰子，没有尺寸。
         */
        this.records = [];
        for (let i = 0; i < MAX_SPIKES; i++) {
            this.records.push({
                along: 0, // 沿施放线方向 0..1
                lateral: 0, // 横跨带状区域的 -1..1，聚簇之前
                scatter: 0, // 额外的横向抖动 -1..1
                angle: 0, // 撞击晶簇的方位角，弧度
                radial: 0, // 撞击晶簇的距离，0..1
                impact: false, // 留给远端那一簇
                rubble: false, // 降级为及踝高的残骸
                heightJitter: 0,
                radiusJitter: 0,
                leanJitter: 0,
                pitchJitter: 0,
                yaw: 0,
                stagger: 0, // `riseStagger` 的 0..1
                eruptTime: -1, // 它被触发时的绝对 age，未触发则为 -1
                shattered: false,
            });
        }

        this._activeCount = 0;
        this._impactStart = MAX_SPIKES;
    }

    /** 一种冰晶形状。变体索引只用来扰动种子。 */
    _buildGeometry(variant) {
        const c = settings.ice;
        return createCrystalGeometry({
            seed: 7.3 + variant * 21.7,
            sides: c.facets,
            taper: c.taper,
            roughness: c.roughness,
            bend: c.bend,
        });
    }

    /**
     * 当某个*形状*控制项变动时，重新生成冰晶网格。
     *
     * 晶面数、锥度、粗糙度与弯曲无法表达成逐实例变换，所以它们被烘焙进几何 —— 而一颗
     * 六面冰晶是 108 个三角形，便宜到可以直接重建，不必在顶点着色器里做近似。正是这一点
     * 让它们成为实时滑杆。
     */
    _syncGeometry() {
        const c = settings.ice;
        const key = `${Math.round(c.facets)}|${c.taper.toFixed(3)}|${c.roughness.toFixed(3)}|${c.bend.toFixed(3)}`;
        if (key === this._shapeKey) return;
        this._shapeKey = key;

        for (let v = 0; v < VARIANTS; v++) {
            const mesh = this.meshes[v];
            const previous = mesh.geometry;
            const geometry = this._buildGeometry(v);
            // 逐实例属性是状态，不是形状 —— 把它们一并带过去。
            geometry.setAttribute('aSeed', this.seedAttributes[v]);
            geometry.setAttribute('aBirth', this.birthAttributes[v]);
            mesh.geometry = geometry;
            previous.dispose();
        }
    }

    createParticles() {
        const particles = this.ctx.particles;

        // 从喷发处翻滚而出的地面雾。非加性：它必须*遮挡*，正是这一点让冰场在参考观感里
        // 有了纵深感。
        this.mist = particles.get('ice.mist', {
            capacity: 3200,
            shape: ParticleShape.SMOKE,
            additive: false,
            curl: true,
            softFade: 1.2,
        });
        this.mist.uniforms.uDrag.value = 1.9;
        this.mist.uniforms.uEndSize.value = 3.4;
        this.mist.uniforms.uSizeIn.value = 0.1;
        this.mist.uniforms.uFadeIn.value = 0.14;
        this.mist.uniforms.uFadeOut.value = 0.3;

        // 冰晶破土而出时从它们身上撕下来的碎屑。
        this.shards = particles.get('ice.shards', {
            capacity: 2400,
            shape: ParticleShape.CHIP,
            additive: false,
            lit: true,
            softFade: 0.25,
        });
        this.shards.uniforms.uDrag.value = 0.22;
        this.shards.uniforms.uEndSize.value = 0.85;
        this.shards.uniforms.uFadeOut.value = 0.72;

        // 升腾的闪屑羽流 —— 参考帧的招牌。
        this.glitter = particles.get('ice.glitter', {
            capacity: 2800,
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

        this.mistEmitter = new RateEmitter();
        this.glitterEmitter = new RateEmitter();
        this.frostEmitter = new RateEmitter();
    }

    /* ------------------------------------------------------------------ */
    /* 计时                                                                */
    /* ------------------------------------------------------------------ */

    get instanceCount() {
        return this._activeCount;
    }

    /** 冰场立着度过自己的 lifetime，然后由淡出把它收回。 */
    get impactDuration() {
        return Math.max(0.2, settings.ice.lifetime * settings.global.lifetime);
    }

    get fadeDuration() {
        const c = settings.ice;
        return Math.max(0.2, c.shatterDelay + c.sinkTime);
    }

    /* ------------------------------------------------------------------ */
    /* 施放                                                                */
    /* ------------------------------------------------------------------ */

    onSpawn() {
        const c = settings.ice;

        this.mistEmitter.reset();
        this.glitterEmitter.reset();
        this.frostEmitter.reset();
        this._frostDistance = 0;

        const wanted = Math.min(MAX_SPIKES, Math.max(1, Math.round(c.spikeCount * c.density)));
        // 最后一段被留下来，用于撞击点处扬起的那一簇。
        const impactCount = Math.round(wanted * 0.22);
        this._activeCount = wanted;
        this._impactStart = wanted - impactCount;

        for (let i = 0; i < wanted; i++) {
            const record = this.records[i];
            const impact = i >= this._impactStart;

            record.impact = impact;
            record.eruptTime = -1;
            record.shattered = false;
            record.yaw = Math.random() * TAU;
            record.stagger = Math.random();
            record.heightJitter = randRange(-1, 1);
            record.radiusJitter = randRange(-1, 1);
            record.leanJitter = randRange(-1, 1);
            record.pitchJitter = randRange(-1, 1);
            record.scatter = randRange(-1, 1);
            record.rubble = Math.random() < c.rubble;

            if (impact) {
                record.angle = Math.random() * TAU;
                // sqrt 让晶簇密度均匀，而不是堆在中心。
                record.radial = Math.sqrt(Math.random());
                record.along = 1;
            } else {
                // `frontBias` 小于 1 会把冰场挤向撞击点。
                record.along = Math.pow((i + Math.random()) / Math.max(1, this._impactStart), c.frontBias);
                record.lateral = randRange(-1, 1);
            }
        }

        for (let i = wanted; i < MAX_SPIKES; i++) this.records[i].eruptTime = -1;
        for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    }

    /* ------------------------------------------------------------------ */
    /* 解析一根冰刺 —— 每一米、每一弧度与每一秒都出自这里                  */
    /* ------------------------------------------------------------------ */

    /** 沿线上位置 `s` 处带状区域的半宽，单位米。 */
    _halfWidth(s, c) {
        return lerp(c.widthNear, c.width, Math.pow(saturate(s), c.widthCurve));
    }

    /** 一条记录的带符号横向偏移，表示为局部半宽的比例。 */
    _lateralNorm(record, c) {
        const raw = record.lateral;
        const clumped = Math.sign(raw) * Math.pow(Math.abs(raw), c.clumping);
        return clumped + record.scatter * c.scatter;
    }

    /** 一根冰刺此刻所在的位置，按实时的足迹设置计算。 */
    _spikePosition(record, c, out) {
        if (record.impact) {
            const reach = this._halfWidth(1, c) * 1.25 * record.radial;
            this.pointAt(1, out);
            out.x += Math.cos(record.angle) * reach;
            out.z += Math.sin(record.angle) * reach;
            return out;
        }

        this.pointAt(record.along, out);
        return out.addScaledVector(this.side, this._lateralNorm(record, c) * this._halfWidth(record.along, c));
    }

    /** 一根冰刺的总高度，单位米。 */
    _spikeHeight(record, c, g) {
        let h = lerp(c.heightNear, c.height, Math.pow(saturate(record.along), c.heightCurve));

        // 撞击点处的隆起。
        h *= 1 + (c.peak - 1) * smoothstep(1 - c.peakWidth, 1, record.along);

        // 穹顶状轮廓：两翼的刃比脊线短。
        const edge = record.impact ? record.radial : saturate(Math.abs(this._lateralNorm(record, c)));
        h *= lerp(1, 1 - saturate(c.crown), Math.pow(edge, 1.4));

        h *= 1 + record.heightJitter * c.heightJitter * g.randomness;
        if (record.rubble) h *= c.rubbleScale;

        return Math.max(0.02, h);
    }

    /** 一根冰刺的底部半径，单位米。 */
    _spikeRadius(record, c, g) {
        const grow = lerp(0.72, 1.15, Math.pow(saturate(record.along), 0.6));
        const jitter = 1 + record.radiusJitter * c.radiusJitter * g.randomness;
        return Math.max(0.01, c.radius * grow * jitter * (record.rubble ? 1.25 : 1));
    }

    /* ------------------------------------------------------------------ */
    /* 喷发                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 触发破裂前锋此刻已经到达的每一根冰刺。
     * `limit` 是前锋沿线上推进了多远，0..1。
     */
    _triggerUpTo(limit, includeImpact) {
        const c = settings.ice;
        for (let i = 0; i < this._activeCount; i++) {
            const record = this.records[i];
            if (record.eruptTime >= 0) continue;
            if (record.impact && !includeImpact) continue;
            if (!record.impact && record.along > limit) continue;
            record.eruptTime = this.age + record.stagger * c.riseStagger;
        }
    }

    /**
     * 一根冰刺钻出地面多少，0 → 1，并且会带弹性地冲过 1 一点。
     * 当它还埋在地下等待时返回负数。
     */
    _emergence(record, c) {
        if (record.eruptTime < 0) return -1;
        const elapsed = this.age - record.eruptTime;
        if (elapsed < 0) return -1;

        const riseTime = Math.max(0.02, c.riseTime);
        const rise = Easing.outQuint(saturate(elapsed / riseTime));
        if (elapsed <= riseTime) return rise;

        // 冲出地面时会越过满高，再回弹稳住。
        const after = elapsed - riseTime;
        const spring = Math.sin(after * 14) * Math.exp(-after / Math.max(0.05, c.settle));
        return 1 + c.riseOvershoot * spring;
    }

    /**
     * 用实时设置重建每一个实例矩阵。
     * @param {number} retract 0..1 —— 整片冰场收回地面之下。
     */
    _updateSpikes(dt, retract) {
        const c = settings.ice;
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
                used[variant] = Math.max(used[variant], slot + 1);
                continue;
            }

            const height = this._spikeHeight(record, c, g);
            const radius = this._spikeRadius(record, c, g);

            /* --- 破开地表那一刻的碎屑 --- */
            if (!record.shattered && emerge > 0.25) {
                record.shattered = true;
                this._breachFx(record, c, g, radius);
            }

            /* --- 倾斜：背离施法者，同时沿带状区域向外 --- */
            const outward = record.impact
                ? Math.sign(Math.cos(record.angle)) * record.radial
                : this._lateralNorm(record, c);
            _lean
                .copy(this.direction)
                .multiplyScalar(0.75)
                .addScaledVector(this.side, outward * 0.85);
            if (_lean.lengthSq() < 1e-6) _lean.copy(this.direction);
            _lean.normalize();

            const leanAngle =
                c.lean * (0.35 + 0.65 * record.along) * (1 + record.leanJitter * c.leanJitter * g.randomness);

            // 绕 (up × lean) 旋转，会把冰晶自身的 +Y 扳向 `lean`。
            _axis.crossVectors(_up, _lean).normalize();
            _tilt.setFromAxisAngle(_axis, leanAngle);
            _spin.setFromAxisAngle(_up, record.yaw * c.twist);
            _tilt.multiply(_spin);

            /* --- 把它从地面里滑上来 --- */
            const settled = Math.min(1, emerge);
            this._spikePosition(record, c, _dummy.position);
            _dummy.position.y = (emerge - 1) * height * 0.85;

            if (retract > 0) {
                const sink = Easing.inCubic(retract);
                _dummy.position.y -= sink * (height + radius + 0.4);
            }

            _dummy.quaternion.copy(_tilt);
            _dummy.scale.set(radius, height, radius).multiplyScalar(lerp(0.86, 1, settled));
            _dummy.updateMatrix();

            this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
            this.birthAttributes[variant].array[slot] = saturate(1 - (this.age - record.eruptTime) / birthFade);
            used[variant] = Math.max(used[variant], slot + 1);
        }

        for (let v = 0; v < VARIANTS; v++) {
            this.meshes[v].count = used[v];
            this.meshes[v].instanceMatrix.needsUpdate = true;
            this.birthAttributes[v].needsUpdate = true;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 反馈                                                                */
    /* ------------------------------------------------------------------ */

    _syncUniforms() {
        const c = settings.ice;
        const g = settings.global;

        this._syncGeometry();
        this.material.userData.sync();

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
        this.mist.uniforms.uTurbulence.value = 0.4 * g.turbulence;

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
            getColor(c.colorSparkleA),
            getColor(c.colorSparkleB),
            getColor(c.colorSparkleC),
            getColor(c.colorSparkleD)
        );
        this.glitter.uniforms.uGravity.value.set(0, c.sparkleRise, 0);
        this.glitter.uniforms.uSizeScale.value = c.sparkleSize * g.particleSize * 7;
        this.glitter.uniforms.uLifeScale.value = c.sparkleLifetime * 0.5 * g.particleLifetime;
        this.glitter.uniforms.uSpeedScale.value = g.particleSpeed;
        this.glitter.uniforms.uOpacity.value = g.opacity;
        this.glitter.uniforms.uGlow.value = 0.9 * g.glow;
        this.glitter.uniforms.uTurbulence.value = c.sparkleTurbulence * g.turbulence;
    }

    /** 冰晶破开地表处的碎屑与一小股雾。 */
    _breachFx(record, c, g, radius) {
        const time = frame.uTime.value;

        this._spikePosition(record, c, _pos).setY(0.08);

        _emit.position = _pos;
        _emit.radius = radius * 0.8;
        _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
        _emit.speed = c.shardSpeed;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.75;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.1;
        _emit.sizeVariance = 0.7;
        _emit.life = c.shardLifetime;
        _emit.lifeVariance = 0.45;
        _emit.spin = 7;
        _emit.tint = null;
        _emit.time = time;
        this.shards.emit(Math.round(3 * g.particleCount), _emit);

        // 只有一部分冰刺会冒烟：几百根同时冒会把冰场埋进雾霾里，遮住那身轮廓，而轮廓才
        // 是全部的意义所在。
        if (Math.random() < 0.4) {
            _emit.speed = 0.7;
            _emit.spread = 1.0;
            _emit.size = 0.6;
            _emit.sizeVariance = 0.5;
            _emit.life = c.mistLifetime * 0.7;
            _emit.spin = 0.5;
            this.mist.emit(Math.round(2 * g.particleCount), _emit);
        }
    }

    /** 沿行进中的前锋持续抖落的雾、闪屑与白霜。 */
    _frontFx(dt) {
        const c = settings.ice;
        const g = settings.global;
        const time = frame.uTime.value;
        const halfWidth = this._halfWidth(this.u, c);

        const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate) * g.particleCount);
        if (mistCount > 0) {
            _emit.position = _pos.copy(this.position).setY(0.18);
            _emit.radius = halfWidth * 0.9;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.mistSpeed;
            _emit.speedVariance = 0.7;
            _emit.spread = 1.0;
            _emit.inherit = null;
            _emit.anchor = null;
            _emit.size = 0.9;
            _emit.sizeVariance = 0.5;
            _emit.life = c.mistLifetime;
            _emit.lifeVariance = 0.4;
            _emit.spin = 0.5;
            _emit.tint = null;
            _emit.time = time;
            this.mist.emit(mistCount, _emit);
        }

        const glitterCount = Math.round(this.glitterEmitter.tick(dt, c.sparkleRate) * g.particleCount);
        if (glitterCount > 0) {
            _emit.position = _pos.copy(this.position).setY(0.5);
            _emit.radius = halfWidth;
            _emit.direction = _dir.set(0, 1, 0);
            _emit.speed = c.sparkleSpeed;
            _emit.speedVariance = 0.8;
            _emit.spread = 0.85;
            _emit.size = 0.09;
            _emit.sizeVariance = 0.6;
            _emit.life = c.sparkleLifetime;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.time = time;
            this.glitter.emit(glitterCount, _emit);
        }

        /* 破裂前锋经过时铺在地面上的白霜 */
        const step = 1 / Math.max(0.1, c.frostRate);
        while (this.front - this._frostDistance >= step) {
            this._frostDistance += step;
            const s = saturate(this._frostDistance / this.length);
            const width = this._halfWidth(s, c);
            this.pointAt(s, _pos);
            _pos.x += this.side.x * randRange(-0.7, 0.7) * width;
            _pos.z += this.side.z * randRange(-0.7, 0.7) * width;

            this.ctx.decals.spawn(DecalType.FROST, _pos, {
                radius: width * c.frostSpread * randRange(0.6, 1.15),
                life: c.frostLife,
                width: c.frostCrystals,
                intensity: c.frostIntensity,
                colorA: getColor(c.colorFrost),
                colorB: getColor(c.colorFrostEdge),
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* 阶段                                                                */
    /* ------------------------------------------------------------------ */

    onTravel(dt) {
        this._syncUniforms();
        this._triggerUpTo(this.u, false);
        this._updateSpikes(dt, 0);
        this._frontFx(dt);

        this.ctx.shake.rumble(settings.ice.rumble * settings.global.cameraShake, dt);
    }

    onImpact() {
        const c = settings.ice;
        const g = settings.global;
        const time = frame.uTime.value;

        // 所有还埋着的东西现在都翻上来，包括终点那一簇。
        this._triggerUpTo(1, true);

        // 整段序列共用一个临时向量：下面每个使用者都从它里面复制出自己要的东西，所以它
        // 可以被原地重新瞄准。
        this.pointAt(1, _pos).setY(0.6);

        /* 冻结蒸汽的壳层 */
        this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
            radius: c.burstSize * 0.3,
            endRadius: c.burstSize * g.explosionIntensity,
            life: 0.95,
            intensity: c.burstIntensity,
            opacity: 0.85,
            fresnel: 1.3,
            displace: 0.55,
            squash: 0.72,
            colorA: getColor(c.colorBurstA),
            colorB: getColor(c.colorBurstB),
            colorC: getColor(c.colorBurstC),
        });

        /* 在地面上向外炸开的那道圆环 */
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
            radius: c.shockRadius * g.explosionIntensity,
            life: 0.75,
            width: 0.06,
            intensity: 0.9,
            colorA: getColor(c.colorShockA),
            colorB: getColor(c.colorShockB),
        });

        /* 晶簇下方一大片白霜 */
        this.ctx.decals.spawn(DecalType.FROST, _pos, {
            radius: this._halfWidth(1, c) * c.frostSpread * 2.2,
            life: c.frostLife * 1.3,
            width: c.frostCrystals,
            intensity: c.frostIntensity,
            colorA: getColor(c.colorFrost),
            colorB: getColor(c.colorFrostEdge),
        });

        /* 撞击处甩出来的碎屑、雾与闪屑 */
        _emit.position = _pos.setY(0.4);
        _emit.radius = this._halfWidth(1, c) * 0.8;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.shardSpeed * 1.8;
        _emit.speedVariance = 0.75;
        _emit.spread = 0.9;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.16;
        _emit.sizeVariance = 0.8;
        _emit.life = c.shardLifetime * 1.4;
        _emit.lifeVariance = 0.5;
        _emit.spin = 9;
        _emit.tint = null;
        _emit.time = time;
        this.shards.emit(Math.round(c.burstShards * g.particleCount), _emit);

        _emit.speed = c.mistSpeed * 2.4;
        _emit.spread = 1.0;
        _emit.size = 1.6;
        _emit.life = c.mistLifetime * 1.5;
        _emit.spin = 0.6;
        this.mist.emit(Math.round(90 * g.particleCount), _emit);

        _emit.speed = c.sparkleSpeed * 1.6;
        _emit.spread = 0.8;
        _emit.size = 0.1;
        _emit.life = c.sparkleLifetime * 1.3;
        _emit.spin = 0;
        this.glitter.emit(Math.round(150 * g.particleCount), _emit);

        this.ctx.shake.add(
            c.impactShake * g.explosionIntensity * g.cameraShake,
            1 / Math.max(0.1, c.shakeDuration),
            19
        );
        this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
        this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
    }

    onFade(dt) {
        const c = settings.ice;
        this._syncUniforms();

        let retract = 0;
        if (this.phase === AbilityPhase.FADE) {
            retract = saturate((this.fadeTime - c.shatterDelay) / Math.max(0.05, c.sinkTime));
        }

        this._updateSpikes(dt, retract);

        // 冰场立着的时候一直冒着热气，开始收回时便停下。
        if (retract < 0.6) {
            const g = settings.global;
            const time = frame.uTime.value;
            const count = Math.round(this.glitterEmitter.tick(dt, c.sparkleRate * 0.35) * g.particleCount);
            if (count > 0) {
                this.pointAt(randRange(0.25, 1), _pos).setY(0.35);
                _emit.position = _pos;
                _emit.radius = this._halfWidth(1, c);
                _emit.direction = _dir.set(0, 1, 0);
                _emit.speed = c.sparkleSpeed * 0.7;
                _emit.speedVariance = 0.8;
                _emit.spread = 0.9;
                _emit.inherit = null;
                _emit.anchor = null;
                _emit.size = 0.08;
                _emit.sizeVariance = 0.6;
                _emit.life = c.sparkleLifetime;
                _emit.lifeVariance = 0.5;
                _emit.spin = 0;
                _emit.tint = null;
                _emit.time = time;
                this.glitter.emit(count, _emit);
            }
        }
    }

    onDestroy() {
        this._activeCount = 0;
        for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    }

    dispose() {
        for (const mesh of this.meshes) {
            mesh.geometry.dispose();
            mesh.dispose();
        }
        this.material.dispose();
        super.dispose();
    }
}
