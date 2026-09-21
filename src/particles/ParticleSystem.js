import {
    InstancedBufferGeometry,
    InstancedBufferAttribute,
    BufferAttribute,
    Mesh,
    ShaderMaterial,
    AdditiveBlending,
    NormalBlending,
    Color,
    Vector3,
    Sphere,
    DynamicDrawUsage,
    DoubleSide,
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';

/** 片元轮廓。全部为程序化生成——不使用任何精灵贴图。 */
export const ParticleShape = Object.freeze({
    SOFT: 0, // 圆形、边缘羽化——余烬、液滴、尘埃
    SMOKE: 1, // 被 fbm 侵蚀的烟团
    STREAK: 2, // 沿速度方向拉伸的火花
    LEAF: 3, // 两端收尖的叶片轮廓
    CHIP: 4, // 棱角分明的岩石碎块
    RING: 5, // 细薄的扩散圆环——冲击波
});

const FLOATS = {
    start: 3,
    origin: 3,
    velocity: 3,
    color: 3,
    spawn: 1,
    life: 1,
    size: 1,
    seed: 1,
    spin: 1,
};

const _tmpColor = new Color();
const _tmpVec = new Vector3();

/**
 * 池化的、GPU 模拟的粒子系统。
 *
 * 每个粒子的运动（速度、重力、阻力、湍流、旋转）、尺寸曲线、
 * 颜色渐变和透明度衰减，全部在顶点/片元着色器中基于少量逐实例
 * attribute 求值。CPU 只负责*写入生成数据*；主线程上没有任何逐帧
 * 模拟，构造之后也不再分配任何内存。
 *
 * 粒子存放在环形缓冲中：生成数量超过容量时会回收最旧的槽位，
 * 这正是沙盒场景（用户可以狂放技能）所需要的池化行为。
 */
export class ParticleSystem {
    /**
     * @param {object} options
     * @param {string} options.name
     * @param {number} options.capacity              最大同时存活粒子数
     * @param {number} options.shape                 ParticleShape.*
     * @param {boolean} [options.additive]           加法混合还是普通混合
     * @param {boolean} [options.curl]               启用 curl noise 湍流
     * @param {boolean} [options.stretch]            沿速度方向拉伸
     * @param {boolean} [options.swirl]              围绕移动锚点旋转
     * @param {boolean} [options.lit]                廉价的方向性着色（碎石/树叶）
     */
    constructor({
        name,
        capacity = 2000,
        shape = ParticleShape.SOFT,
        additive = true,
        curl = false,
        stretch = false,
        swirl = false,
        lit = false,
        softFade = 0.6,
    }) {
        this.name = name;
        this.capacity = capacity;
        this.cursor = 0;

        /* ---------------- 几何体 ---------------- */
        const geometry = new InstancedBufferGeometry();
        geometry.setAttribute(
            'position',
            new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)
        );
        geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
        geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

        this.data = {};
        this.attributes = {};
        for (const [key, itemSize] of Object.entries(FLOATS)) {
            const array = new Float32Array(capacity * itemSize);
            const attribute = new InstancedBufferAttribute(array, itemSize).setUsage(DynamicDrawUsage);
            this.data[key] = array;
            this.attributes[key] = attribute;
            geometry.setAttribute(`a${key[0].toUpperCase()}${key.slice(1)}`, attribute);
        }
        // 所有粒子初始都是死亡状态（生成时间远在过去，寿命为零）。
        this.data.life.fill(0);
        geometry.instanceCount = capacity;
        geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
        this.geometry = geometry;

        /* ---------------- 材质 ---------------- */
        const defines = { SHAPE: shape };
        if (curl) defines.USE_CURL = '';
        if (stretch) defines.USE_STRETCH = '';
        if (swirl) defines.USE_SWIRL = '';
        if (lit) defines.USE_LIT = '';

        this.material = new ShaderMaterial({
            defines,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: additive ? AdditiveBlending : NormalBlending,
            side: DoubleSide,
            toneMapped: false,
            uniforms: sharedUniforms({
                uGravity: { value: new Vector3(0, -4.5, 0) },
                uDrag: { value: 0.9 },
                uTurbulence: { value: 0.6 },
                uTurbFrequency: { value: 0.45 },
                uTurbSpeed: { value: 0.35 },
                uSwirl: { value: 0 },
                uSwirlExpand: { value: 0.4 },
                uSpeedScale: { value: 1 },
                uSizeScale: { value: 1 },
                uLifeScale: { value: 1 },
                uEndSize: { value: 0.4 },
                uSizeIn: { value: 0.08 },
                uFadeIn: { value: 0.08 },
                uFadeOut: { value: 0.55 },
                uOpacity: { value: 1 },
                uGlow: { value: 1 },
                uStretch: { value: 0.15 },
                uSoftFade: { value: softFade },
                uColor0: { value: new Color(1, 1, 1) },
                uColor1: { value: new Color(1, 0.7, 0.3) },
                uColor2: { value: new Color(0.6, 0.15, 0.05) },
                uColor3: { value: new Color(0.08, 0.06, 0.06) },
                uLightDir: { value: new Vector3(0.4, 0.8, 0.35).normalize() },
                uSoftness: { value: 1 },
            }),
            vertexShader: PARTICLE_VERTEX,
            fragmentShader: PARTICLE_FRAGMENT,
        });

        this.mesh = new Mesh(geometry, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.matrixAutoUpdate = false;
        this.mesh.layers.set(LAYER.VFX);
        this.mesh.renderOrder = additive ? 12 : 10;
        this.mesh.name = `Particles:${name}`;

        this._ranges = [];
        this._dirty = false;
    }

    get object3D() {
        return this.mesh;
    }

    get uniforms() {
        return this.material.uniforms;
    }

    /**
     * 生成 `count` 个粒子。
     *
     * `params` 只被读取、从不被持有——调用方应当为每个发射器复用同一个
     * 临时对象，以保证帧内零分配。
     *
     * @param {number} count
     * @param {object} p
     * @param {Vector3} p.position           发射点
     * @param {number}  [p.radius]           围绕发射点的随机偏移半径
     * @param {Vector3} [p.direction]        基础速度方向（已归一化）
     * @param {number}  [p.speed]            沿 `direction` 的基础速率
     * @param {number}  [p.speedVariance]    0..1 的速率随机化幅度
     * @param {number}  [p.spread]           0..1 的锥形张开度（1 = 整个球面）
     * @param {Vector3} [p.inherit]          叠加到每个粒子上的速度
     * @param {Vector3} [p.anchor]           旋转锚点（默认为 `position`）
     * @param {number}  [p.size]             基础尺寸
     * @param {number}  [p.sizeVariance]
     * @param {number}  [p.life]             寿命（秒）
     * @param {number}  [p.lifeVariance]
     * @param {number}  [p.spin]             弧度/秒
     * @param {Color}   [p.tint]             逐粒子颜色乘数
     * @param {number}  [p.time]             当前模拟时间（必填）
     */
    emit(count, p) {
        if (count <= 0) return;
        count = Math.min(count, this.capacity);

        const {
            position,
            radius = 0,
            direction = null,
            speed = 1,
            speedVariance = 0.35,
            spread = 0.5,
            inherit = null,
            anchor = null,
            size = 0.2,
            sizeVariance = 0.4,
            life = 1,
            lifeVariance = 0.3,
            spin = 0,
            tint = null,
            time = 0,
        } = p;

        const d = this.data;

        for (let n = 0; n < count; n++) {
            const i = this.cursor;
            this.cursor = (this.cursor + 1) % this.capacity;
            this._markDirty(i);

            const i3 = i * 3;

            // --- 位置 -------------------------------------------------------
            let ox = 0;
            let oy = 0;
            let oz = 0;
            if (radius > 0) {
                // 球体内近似均匀分布的一点。
                const u = Math.random();
                const r = radius * Math.cbrt(u);
                const theta = Math.random() * Math.PI * 2;
                const phi = Math.acos(2 * Math.random() - 1);
                const s = Math.sin(phi);
                ox = r * s * Math.cos(theta);
                oy = r * Math.cos(phi);
                oz = r * s * Math.sin(theta);
            }
            d.start[i3 + 0] = position.x + ox;
            d.start[i3 + 1] = position.y + oy;
            d.start[i3 + 2] = position.z + oz;

            const a = anchor ?? position;
            d.origin[i3 + 0] = a.x;
            d.origin[i3 + 1] = a.y;
            d.origin[i3 + 2] = a.z;

            // --- 速度 -------------------------------------------------------
            if (direction) {
                _tmpVec.copy(direction);
            } else {
                _tmpVec.set(0, 1, 0);
            }
            if (spread > 0) {
                _tmpVec.x += (Math.random() - 0.5) * 2 * spread;
                _tmpVec.y += (Math.random() - 0.5) * 2 * spread;
                _tmpVec.z += (Math.random() - 0.5) * 2 * spread;
            }
            _tmpVec.normalize().multiplyScalar(speed * (1 + (Math.random() - 0.5) * 2 * speedVariance));
            if (inherit) _tmpVec.add(inherit);

            d.velocity[i3 + 0] = _tmpVec.x;
            d.velocity[i3 + 1] = _tmpVec.y;
            d.velocity[i3 + 2] = _tmpVec.z;

            // --- 标量 -------------------------------------------------------
            d.spawn[i] = time;
            d.life[i] = Math.max(0.05, life * (1 + (Math.random() - 0.5) * 2 * lifeVariance));
            d.size[i] = Math.max(0.001, size * (1 + (Math.random() - 0.5) * 2 * sizeVariance));
            d.seed[i] = Math.random();
            d.spin[i] = (Math.random() - 0.5) * 2 * spin;

            // --- 着色 -------------------------------------------------------
            if (tint) {
                d.color[i3 + 0] = tint.r;
                d.color[i3 + 1] = tint.g;
                d.color[i3 + 2] = tint.b;
            } else {
                d.color[i3 + 0] = 1;
                d.color[i3 + 1] = 1;
                d.color[i3 + 2] = 1;
            }
        }
    }

    /**
     * 仍然存活的粒子数，精确值。
     *
     * 只用于 HUD 读数，所以在统计间隔里调用而不是每帧调用——
     * 模拟本身从不需要它。
     */
    countLive(time) {
        const { spawn, life } = this.data;
        const lifeScale = this.uniforms.uLifeScale.value;
        let live = 0;
        for (let i = 0; i < this.capacity; i++) {
            const age = time - spawn[i];
            if (age >= 0 && age <= life[i] * lifeScale) live++;
        }
        return live;
    }

    _markDirty(index) {
        this._dirty = true;
        const ranges = this._ranges;
        // 生成是连续的，所以并入最后一个区间几乎总是
        // 一次比较的事。
        const last = ranges[ranges.length - 1];
        if (last && index === last[0] + last[1]) {
            last[1]++;
        } else {
            ranges.push([index, 1]);
        }
    }

    /** 只上传本帧发生变化的那些槽位。 */
    flush() {
        if (!this._dirty) return;
        for (const [key, itemSize] of Object.entries(FLOATS)) {
            const attribute = this.attributes[key];
            attribute.needsUpdate = true;
            attribute.clearUpdateRanges?.();
            for (const [start, count] of this._ranges) {
                attribute.addUpdateRange?.(start * itemSize, count * itemSize);
            }
        }
        this._ranges.length = 0;
        this._dirty = false;
    }

    /** 便捷方法：用十六进制字符串设置 4 个色标的寿命渐变。 */
    setGradient(c0, c1, c2, c3) {
        const u = this.uniforms;
        u.uColor0.value.copy(c0);
        u.uColor1.value.copy(c1);
        u.uColor2.value.copy(c2);
        u.uColor3.value.copy(c3 ?? c2);
    }

    reset() {
        this.data.life.fill(0);
        this.data.spawn.fill(-1e4);
        for (const key of Object.keys(FLOATS)) this.attributes[key].needsUpdate = true;
        this._ranges.length = 0;
        this._dirty = false;
        this.cursor = 0;
    }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
    }
}

/* ---------------------------------------------------------------------- */
/* 着色器                                                                  */
/* ---------------------------------------------------------------------- */

const PARTICLE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform vec3  uGravity;
  uniform float uDrag;
  uniform float uTurbulence;
  uniform float uTurbFrequency;
  uniform float uTurbSpeed;
  uniform float uSwirl;
  uniform float uSwirlExpand;
  uniform float uSpeedScale;
  uniform float uSizeScale;
  uniform float uLifeScale;
  uniform float uEndSize;
  uniform float uSizeIn;
  uniform float uStretch;

  attribute vec3  aStart;
  attribute vec3  aOrigin;
  attribute vec3  aVelocity;
  attribute vec3  aColor;
  attribute float aSpawn;
  attribute float aLife;
  attribute float aSize;
  attribute float aSeed;
  attribute float aSpin;

  varying vec2  vUv;
  varying float vT;
  varying float vSeed;
  varying vec3  vTint;
  varying float vViewZ;
  varying vec3  vNormalish;

  ${noiseGLSL}

  void main() {
    vUv = uv;
    vSeed = aSeed;
    vTint = aColor;

    float life = aLife * uLifeScale;
    float age = uTime - aSpawn;
    float t = age / max(life, 1e-4);
    vT = t;

    // 死亡粒子被推出裁剪体之外；GPU 会在光栅化之前
    // 丢掉整个三角形。
    if (age < 0.0 || t > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec3 vel = aVelocity * uSpeedScale;

    // 解析式的指数阻尼——精确，且与帧率无关。
    float k = max(uDrag, 1e-3);
    float travel = (1.0 - exp(-k * age)) / k;
    vec3 pos = aStart + vel * travel + 0.5 * uGravity * age * age;

    #ifdef USE_SWIRL
      // 绕一个行进中的锚点旋转：锚点随发射器速度漂移，
      // 粒子的偏移则在它周围旋转并扩张。
      vec3 anchor = aOrigin + vel * travel;
      vec3 rel = aStart - aOrigin;
      float ang = uSwirl * age + aSeed * 6.2831;
      float c = cos(ang), s = sin(ang);
      vec3 rotated = vec3(rel.x * c - rel.z * s, rel.y, rel.x * s + rel.z * c);
      rotated *= 1.0 + uSwirlExpand * t;
      pos = anchor + rotated + vec3(0.0, 0.5 * uGravity.y * age * age, 0.0);
    #endif

    // 湍流：一种廉价的确定性摆动，较重的烟/火系统可选用
    // 真正的 curl noise 升级。
    #ifdef USE_CURL
      pos += curlNoise(aStart * uTurbFrequency + vec3(0.0, uTime * uTurbSpeed, 0.0) + aSeed * 4.0)
             * uTurbulence * age;
    #else
      vec3 wobble = vec3(
        sin(age * 3.1 + aSeed * 41.0),
        cos(age * 2.3 + aSeed * 17.0),
        sin(age * 2.7 + aSeed * 73.0)
      );
      pos += wobble * uTurbulence * age * 0.55;
    #endif

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    vViewZ = mvPosition.z;

    // 沿寿命的尺寸。
    float grow = smoothstep(0.0, max(uSizeIn, 1e-3), t);
    float size = aSize * uSizeScale * mix(1.0, uEndSize, t) * grow;

    vec2 corner = position.xy * size;

    #ifdef USE_STRETCH
      vec3 velView = (modelViewMatrix * vec4(vel, 0.0)).xyz;
      vec2 dir = normalize(velView.xy + vec2(1e-5));
      vec2 perp = vec2(-dir.y, dir.x);
      float stretch = 1.0 + uStretch * length(vel);
      corner = dir * (position.y * size * stretch) + perp * (position.x * size);
      vNormalish = vec3(dir, 0.0);
    #else
      float rot = aSpin * age + aSeed * 6.2831;
      corner = rot2(rot) * corner;
      vNormalish = normalize(vec3(position.xy, 0.75));
    #endif

    mvPosition.xy += corner;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFadeIn;
  uniform float uFadeOut;
  uniform float uSoftFade;
  uniform float uSoftness;
  uniform vec3  uColor0;
  uniform vec3  uColor1;
  uniform vec3  uColor2;
  uniform vec3  uColor3;
  uniform vec3  uLightDir;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vT;
  varying float vSeed;
  varying vec3  vTint;
  varying float vViewZ;
  varying vec3  vNormalish;

  ${noiseGLSL}
  ${commonGLSL}

  float shapeMask(vec2 uv) {
    vec2 c = (uv - 0.5) * 2.0;
    float d = length(c);

    #if SHAPE == 0                       // 圆形羽化
      return smoothstep(1.0, 0.0, d);

    #elif SHAPE == 1                     // 烟团
      float n = fbm3(vec3(c * 1.6, vSeed * 21.0 + uTime * 0.25));
      return smoothstep(1.0, 0.05, d + n * 0.42) * 0.9;

    #elif SHAPE == 2                     // 拉丝
      float core = smoothstep(1.0, 0.0, abs(c.x) * 3.4);
      float len = smoothstep(1.0, 0.0, abs(c.y));
      return core * len;

    #elif SHAPE == 3                     // 叶片
      float w = max(0.0, 1.0 - c.y * c.y);
      float body = smoothstep(w * 0.62, w * 0.30, abs(c.x));
      float vein = smoothstep(0.06, 0.0, abs(c.x)) * 0.35;
      return clamp(body - vein * 0.4, 0.0, 1.0);

    #elif SHAPE == 4                     // 碎块
      float ang = atan(c.y, c.x);
      float r = 0.62 + 0.24 * sin(ang * 5.0 + vSeed * 30.0) + 0.1 * sin(ang * 9.0 - vSeed * 11.0);
      return smoothstep(r, r - 0.14, d);

    #else                                // 圆环
      return smoothstep(0.14, 0.0, abs(d - 0.82));
    #endif
  }

  void main() {
    if (vT < 0.0 || vT > 1.0) discard;

    float mask = shapeMask(vUv);
    if (mask <= 0.004) discard;

    // 沿寿命的 alpha。
    float fade = smoothstep(0.0, max(uFadeIn, 1e-3), vT) *
                 (1.0 - smoothstep(clamp(uFadeOut, 0.0, 0.999), 1.0, vT));

    float alpha = mask * fade * uOpacity;

    // 软粒子：在四边形与不透明几何体相交的地方淡出。
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    vec3 color = gradient4(uColor0, uColor1, uColor2, uColor3, vT) * vTint;

    #ifdef USE_LIT
      // 廉价的包裹式漫反射，让不透明碎屑不至于读成扁平的剪影。
      float ndl = dot(normalize(vNormalish), uLightDir) * 0.5 + 0.5;
      color *= mix(0.45, 1.25, ndl);
    #endif

    color *= uGlow * uGlobalGlow;

    // 非预乘：three 的加法/普通混合模式本身
    // 都会再乘上源 alpha。
    gl_FragColor = vec4(color, alpha);
  }
`;
