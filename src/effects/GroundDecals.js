import { Mesh, PlaneGeometry, ShaderMaterial, AdditiveBlending, NormalBlending, Color, Group } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { ObjectPool } from '../utils/ObjectPool.js';

/**
 * SCORCH、SHOCKWAVE、FROST 和 ARC 被现有的技能使用；其余是通用的地面痕迹，
 * 留给接下来要做的任何东西，并且在被生成之前不产生任何开销（three 会在每个
 * 贴花类型首次使用时编译一个程序）。
 */
export const DecalType = Object.freeze({
    SCORCH: 0, // 烧焦的地面，余烬渐渐冷却           （火 / 雷）
    RIPPLE: 1, // 向外扩散的水环                   （水）
    CRACK: 2, // 带炽热辉光的放射状裂痕            （土）
    SHOCKWAVE: 3, // 细小的扩散圆环                 （所有冲击）
    DUSTRING: 4, // 贴地的柔和尘团                 （土 / 风）
    FOAM: 5, // 在湿石头上铺开的海沫                （水）
    FROST: 6, // 以板块状向外爬行的雾凇              （冰）
    ARC: 7, // 分叉的电流灼痕                        （雷）
});

const DECAL_VERTEX = /* glsl */ `
  uniform vec3 uLightDir;      // 世界空间，指向太阳
  varying vec2 vUv;
  varying vec3 vLight;         // 同一个方向，但在贴花自己的坐标系里

  void main() {
    vUv = uv;

    // 贴花生成时带有随机偏航角，用来解相关它们的噪声，因此直接取自世界空间的
    // 主光方向会让每块痕迹都从房间的不同侧面被照亮。在这里一次性把它旋转进
    // 这个四边形的坐标系：片元阶段的 c.x 沿局部 +X 延伸，c.y 沿局部 -Z 延伸。
    vec3 ax = normalize(modelMatrix[0].xyz);
    vec3 ay = normalize(modelMatrix[1].xyz);
    vec3 az = normalize(modelMatrix[2].xyz);
    vLight = normalize(vec3(dot(uLightDir, ax), dot(uLightDir, ay), -dot(uLightDir, az)));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DECAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;        // 0..1 归一化的生命周期
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uWidth;      // 裂缝 / 圆环的厚度
  uniform float uRadius;     // 足迹半径（米），用于世界尺度的噪声颗粒
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform float uGlobalGlow;
  varying vec2 vUv;
  varying vec3 vLight;

  ${noiseGLSL}
  ${commonGLSL}

  /**
   * q 处（距这块痕迹中心的米数）积存雪的深度，约 0..1。
   *
   * 用了三个尺度，因为正是这才让粉末读起来像粉末而不是一张贴图：能看出
   * 形状的堆积雪丘、地壳被压实开裂后形成的块状台阶，以及表层供光捕捉的
   * 细颗粒。它是一个 *高度* 场——FROST 贴花对它求导得到法线，这正是这块
   * 痕迹不再显得平坦的全部原因。
   */
  float snowDepth(vec2 q, float seed, float sharpness) {
    float drift = fbm3(vec3(q * 0.85, seed)) * 0.5 + 0.5;
    vec2  cell  = voronoi2(q * (1.4 + sharpness * 0.9) + seed * 7.0);
    float slabs = smoothstep(0.0, 0.55, cell.x) * 0.30 + cell.y * 0.12;
    float grain = snoise01(vec3(q * (7.0 + sharpness * 5.0), seed * 3.0)) * 0.15;
    return drift * 0.60 + slabs + grain;
  }

  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    if (d > 1.0) discard;

    float alpha = 0.0;
    vec3 color = uColorA;
    float fadeOut = 1.0 - smoothstep(0.55, 1.0, uAge);

    #if DECAL == 0                                   /* 烧焦 */
      float n = fbm3(vec3(c * 2.4, uSeed * 13.0));
      float burn = smoothstep(1.0, 0.15, d + n * 0.45);
      float embers = pow(max(0.0, snoise(vec3(c * 6.0, uSeed * 9.0 + uTime * 0.35))), 4.0);
      alpha = burn * (0.85 * fadeOut);
      color = mix(uColorA, uColorB, embers * (1.0 - uAge));
      color += embers * uColorB * 2.5 * (1.0 - smoothstep(0.0, 0.6, uAge));

    #elif DECAL == 1                                 /* 涟漪 */
      float radius = mix(0.05, 1.0, sqrt(uAge));
      float ring = smoothstep(uWidth, 0.0, abs(d - radius));
      float inner = smoothstep(radius, radius - 0.35, d) * 0.22;
      float wobble = 0.75 + 0.25 * snoise(vec3(c * 5.0, uSeed * 4.0 + uTime));
      alpha = (ring * wobble + inner) * fadeOut;
      color = mix(uColorA, uColorB, ring);

    #elif DECAL == 2                                 /* 裂痕 */
      float ang = atan(c.y, c.x);
      float branch = ridged(vec3(cos(ang), sin(ang), uSeed * 5.0) * 2.6, 4);
      float spread = smoothstep(0.0, 0.45, uAge);
      float radial = smoothstep(spread, spread * 0.35, d);
      float crack = smoothstep(0.55 - uWidth * 0.35, 0.85, branch) * radial;
      float glow = crack * (1.0 - smoothstep(0.1, 0.8, uAge));
      alpha = clamp(crack * 0.95 * fadeOut, 0.0, 1.0);
      color = mix(uColorA, uColorB, glow);
      color += uColorB * glow * 1.8;

    #elif DECAL == 3                                 /* 冲击波 */
      float radius = mix(0.0, 1.0, pow(uAge, 0.55));
      float ring = smoothstep(uWidth, 0.0, abs(d - radius));
      alpha = ring * (1.0 - uAge) * 0.9;
      color = mix(uColorA, uColorB, ring);

    #elif DECAL == 4                                 /* 尘团 */
      float radius = mix(0.1, 1.0, pow(uAge, 0.4));
      float n = fbm3(vec3(c * 3.1, uSeed * 7.0 + uTime * 0.2));
      float puff = smoothstep(radius, radius * 0.35, d) * (0.6 + n * 0.5);
      alpha = puff * (1.0 - uAge) * 0.7;
      color = mix(uColorA, uColorB, n * 0.5 + 0.5);

    #elif DECAL == 6                                 /* 雾凇 */
      // 寒冷穿过地面时被压进地里的雪。
      //
      // 旧版本用 atan() 驱动它的轮廓，而角度查表会让沿某个方位角的每一个
      // 半径都拿到同一个瓣值——那字面上就是画一颗星的方法，而它画出来的
      // 正是一颗星。这里的一切改为在 *平面* 里采样，并且这块痕迹是 **被
      // 着色** 的——由一个高度场决定，而不是透过一张遮罩染色：便宜的前向
      // 差分给出法线，场景自己的主光方向照亮它，结果就会像粉末一样堆积并
      // 接住光，而不是读成一张粘在地板上的蓝白色贴纸。
      //
      // uWidth（"晶体锐度"滑杆）是颗粒的频率。
      float seed = uSeed * 37.0;
      float sharp = clamp(uWidth, 0.05, 4.0);
      // 按米采样，因此一小块雾凇和一次冲击留下的宽大薄片拥有相同尺寸的
      // 颗粒，读起来是同一种物质。
      vec2 q = c * max(0.35, uRadius);

      /* ---- 雪堆：边缘毛糙的伸展，永远不是一个圆盘 ---- */
      vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;
      float lobes = fbm3(vec3(q * 0.8 + warp, seed + 13.0));
      float grow = pow(uAge, 0.30);
      float reach = d * (1.0 - lobes * 0.40);
      float cover = smoothstep(grow, grow - 0.38, reach);
      if (cover < 0.004) discard;

      /* ---- 起伏 ---- */
      float e = 0.16;                               // 两次采样之间的米数
      float h  = snowDepth(q, seed, sharp);
      float hx = snowDepth(q + vec2(e, 0.0), seed, sharp);
      float hy = snowDepth(q + vec2(0.0, e), seed, sharp);
      // 一个浅的凸起：雪是软的，而一个过陡的假法线会读成砾石。
      vec3 nrm = normalize(vec3((h - hx) / e * 0.30, 1.0, (h - hy) / e * 0.30));

      float lambert = clamp(dot(nrm, normalize(vLight)), 0.0, 1.0);
      // 雪散射得很深，所以它自身的阴影永远不会变黑——它会变蓝。
      float shade = 0.36 + 0.64 * pow(lambert, 0.8);

      /* ---- 它铺得有多厚 ---- */
      // 中间厚，到边缘碎成零散的颗粒，因此这块痕迹在任何地方都没有印出来的轮廓。
      float lie = smoothstep(0.10, 0.52, cover * (0.34 + 0.78 * h));

      alpha = lie * fadeOut * 0.95;
      color = mix(uColorB * 0.55, mix(uColorA, vec3(1.0), 0.45), shade);

      // 冰面的闪光，出现在地壳接住光的地方——在时间上做了阶梯化，所以它们是
      // 随着这块痕迹沉降而闪烁，而不是在爬动。
      float glint = smoothstep(0.90, 1.0, snoise01(vec3(q * 9.0, floor(uTime * 7.0) * 0.37 + seed)));
      color += glint * pow(lambert, 2.0) * 1.5 * (1.0 - smoothstep(0.0, 0.7, uAge));

      // 正在推进的唇缘还在冻结，所以它在行进过程中持续亮着。
      float lip = smoothstep(0.10, 0.0, abs(reach - grow)) * (1.0 - smoothstep(0.0, 0.5, uAge));
      color = mix(color, mix(uColorB, vec3(1.0), 0.6), lip * 0.55);
      alpha = clamp(alpha + lip * cover * 0.25 * fadeOut, 0.0, 1.0);

    #elif DECAL == 5                                 /* 海沫 */
      // 一层被冲击抛向外侧的泡沫，随后从中间排空、干回成一个圆环，
      // 底下是被打湿的石头，它逐渐变暗并慢慢蒸发。
      float front = mix(0.12, 1.0, pow(uAge, 0.42));
      float n = fbm3(vec3(c * 2.6, uSeed * 17.0 + uTime * 0.12));
      // 水向外以手指状的水流推动，所以锋面永远不会是一个干净的圆。
      float ang = atan(c.y, c.x);
      float fingers = 0.68 + 0.32 * snoise(vec3(cos(ang), sin(ang), uSeed * 3.0) * 3.5);
      float edge = d + n * 0.26;
      float reach = front * fingers;

      float sheet = smoothstep(reach, reach - 0.3, edge);
      float drain = smoothstep(reach * uAge * 0.9 - 0.05, reach * uAge + 0.3, edge + n * 0.12);
      float foam = sheet * mix(1.0, drain, smoothstep(0.12, 0.85, uAge));

      // 单元（cell）噪声把这张薄片变成气泡，而不是一片平涂的白漆。
      vec2 cell = voronoi2(c * 9.0 + uSeed * 30.0);
      float bubbles = smoothstep(0.55, 0.04, cell.x);
      float rim = smoothstep(0.09, 0.0, abs(edge - reach)) * (1.0 - uAge);

      float wet = sheet * (1.0 - smoothstep(0.3, 1.0, uAge));
      float mask = clamp(foam * (0.5 + 0.65 * bubbles) + rim * 0.9, 0.0, 1.0);
      alpha = clamp(wet * 0.5 + mask, 0.0, 1.0) * fadeOut;
      color = mix(uColorA, uColorB, clamp(mask * 1.3, 0.0, 1.0));

    #else                                            /* 电弧 */
      // 一道闪电接地时留下的灼痕。
      //
      // 丝状场是在 *平面* 里、而非角度上采样的。角度函数会让某个方位角上的
      // 每一个半径都拿到同一个值，从而从中心画出笔直的辐条——那是烟花，不是
      // 灼痕。在 2D 里采样并扭曲查表，能让丝状纹路像电流实际那样蜿蜒、分叉。
      // uWidth 决定它分得多细。
      float warp = fbm3(vec3(c * 1.7, uSeed * 3.0)) * 0.5;
      float fil = ridged(vec3(c * (2.4 + uWidth * 4.0) + warp, uSeed * 11.0), 4);
      float veins = smoothstep(0.70, 0.96, fil);

      // 一个向外张开的毛糙锋面，所以这道印记是从落点扩散开的，而不是一出现
      // 就是完整的。
      float grow = pow(uAge, 0.35);
      float edge = d + fbm3(vec3(c * 2.2, uSeed * 5.0)) * 0.25;
      float front = smoothstep(grow, grow * 0.15, edge);
      float hot = veins * front * (1.0 - smoothstep(0.0, 0.45, uAge));

      alpha = clamp(veins * front * 1.1, 0.0, 1.0) * fadeOut;
      color = mix(uColorA, uColorB, clamp(veins * 1.4, 0.0, 1.0));
      color += uColorB * hot * 1.8;
    #endif

    alpha *= uIntensity;
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * 池化的地面贴花：烧焦痕、涟漪、裂痕、冲击波与海沫。
 *
 * 每个贴花都是躺在地面上的单个四边形，配一个完全程序化的片元着色器，所以
 * 既没有贴花贴图，也没有投影开销。每个贴花一个材质实例让 uniform 保持独立，
 * 而 three 的程序缓存仍然只为每个贴花类型编译一个程序。
 */
export class DecalSystem {
    constructor(scene) {
        this.group = new Group();
        this.group.name = 'GroundDecals';
        scene.add(this.group);

        this.geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
        this.active = [];

        // 每个类型一个池，这样着色器里的 `#define` 对每个材质都保持不变。
        this.pools = new Map();
    }

    _poolFor(type) {
        let pool = this.pools.get(type);
        if (!pool) {
            pool = new ObjectPool(
                () => this._createDecal(type),
                (decal) => {
                    decal.mesh.visible = false;
                    this.group.remove(decal.mesh);
                }
            );
            this.pools.set(type, pool);
        }
        return pool;
    }

    _createDecal(type) {
        const additive = type === DecalType.RIPPLE || type === DecalType.SHOCKWAVE || type === DecalType.ARC;
        const material = new ShaderMaterial({
            defines: { DECAL: type },
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: additive ? AdditiveBlending : NormalBlending,
            toneMapped: false,
            uniforms: sharedUniforms({
                uAge: { value: 0 },
                uSeed: { value: Math.random() },
                uIntensity: { value: 1 },
                uWidth: { value: 0.12 },
                uRadius: { value: 1 },
                uColorA: { value: new Color(0.1, 0.06, 0.05) },
                uColorB: { value: new Color(1, 0.5, 0.15) },
            }),
            vertexShader: DECAL_VERTEX,
            fragmentShader: DECAL_FRAGMENT,
        });

        const mesh = new Mesh(this.geometry, material);
        mesh.layers.set(LAYER.VFX);
        mesh.renderOrder = additive ? 8 : 6;
        mesh.frustumCulled = false;

        return { mesh, material, type, age: 0, life: 1, radius: 1, growth: 0 };
    }

    /**
     * @param {number} type   DecalType.*
     * @param {THREE.Vector3} position
     * @param {object} options
     */
    spawn(type, position, options = {}) {
        const {
            radius = 2,
            life = 2,
            colorA = null,
            colorB = null,
            intensity = 1,
            width = 0.12,
            growth = 0,
            height = 0.02,
        } = options;

        const decal = this._poolFor(type).acquire();
        const u = decal.material.uniforms;

        decal.age = 0;
        decal.life = Math.max(0.05, life);
        decal.radius = radius;
        decal.growth = growth;

        u.uAge.value = 0;
        u.uSeed.value = Math.random();
        u.uIntensity.value = intensity;
        u.uWidth.value = width;
        u.uRadius.value = radius;
        if (colorA) u.uColorA.value.copy(colorA);
        if (colorB) u.uColorB.value.copy(colorB);

        decal.mesh.position.set(position.x, height, position.z);
        decal.mesh.rotation.y = Math.random() * Math.PI * 2;
        decal.mesh.scale.setScalar(radius * 2);
        decal.mesh.visible = true;

        this.group.add(decal.mesh);
        this.active.push(decal);
        return decal;
    }

    update(dt) {
        for (let i = this.active.length - 1; i >= 0; i--) {
            const decal = this.active[i];
            decal.age += dt;
            const t = decal.age / decal.life;
            decal.material.uniforms.uAge.value = t;

            if (decal.growth !== 0) {
                decal.mesh.scale.setScalar(decal.radius * 2 * (1 + decal.growth * t));
            }

            if (t >= 1) {
                this.active.splice(i, 1);
                this._poolFor(decal.type).release(decal);
            }
        }
    }

    clear() {
        for (const decal of this.active) this._poolFor(decal.type).release(decal);
        this.active.length = 0;
    }

    dispose() {
        this.clear();
        for (const pool of this.pools.values()) pool.dispose((decal) => decal.material.dispose());
        this.pools.clear();
        this.geometry.dispose();
        this.group.parent?.remove(this.group);
    }
}
