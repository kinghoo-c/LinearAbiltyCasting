import { ShaderMaterial, AdditiveBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ==================================================================== */
/* 王冠所站立的地面                                                       */
/* ==================================================================== */

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 指示器承诺的那个圆，被**冻结**进了地面。
 *
 * 与瞄准圈、Voltaic Snare 的焦土场相同的符号距离构造、相同的粗边界——
 * 这种对应关系正是重点所在：你点击之前量出的范围，就是之后立在地面上的
 * 东西。它不与它们共享的是处理方式。捕兽夹的场是烧焦、布着脉络的，而
 * 这一片是*一张冰壳*，由三样真正读作冻土的东西搭成：
 *
 *   - **板块（plates）。** 一个 voronoi 场，它的*接缝*是亮的，因为霜在
 *     两块板相接处堆积得最厚。单元 id 还打散了每块板的色调，于是冰壳
 *     有刻面，而不是一片匀开的色。
 *   - **手指（fingers）。** 域扭曲的脊状噪声，按半径加权：霜从不以圆的
 *     形式推进，它是伸出去的。在*平面*上采样，绝不在 `atan()` 上采样——
 *     后者会让同一方位上的每个半径拿到同一个值，并从中心画出死直的辐条。
 *   - **一条锋面（front）。** `uFreeze` 表示冰推进到了多远，占边界的
 *     0..1，同样带有把边缘拖离正圆的角向指状结构。王冠张开时它向前推进，
 *     崩解时*回退*，于是圆盘向外冻结、向内消融，而不是原地淡出。
 *
 * 它是一个由技能自己持有的网格，而不是一个池化的贴花，原因只有一个：
 * 贴花在生成时就锁定了半径，而这个圆在仍然立着的时候必须随 `zoneRadius`
 * 重新缩放。
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // 四边形覆盖的米数，从一边到另一边
  uniform float uRadius;      // 足迹半径，单位米
  uniform float uBoundary;    // 作为边缘的那条带的厚度
  uniform float uBoundaryGlow;
  uniform float uFill;
  uniform float uFalloff;
  uniform float uPlates;
  uniform float uPlateScale;
  uniform float uSeam;
  uniform float uFingers;
  uniform float uFingerScale;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uFreeze;      // 0..1 —— 冰壳已经铺开了多远
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorField;
  uniform vec3  uColorEdge;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → 米，从足迹的中心量起 ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * 0.4;
    float inner = max(0.01, uRadius - uBoundary * 0.6);

    float aa = fwidth(d) + 0.02;
    if (d > outer + aa * 4.0) discard;

    /* ---- 冰实际推进到了多远 ---- */
    // 锋面被一次角向查询拖离正圆——这是角向函数唯一用对的地方，
    // 因为这里*就是*一条边界。
    vec2  bearing = d > 1e-4 ? p / d : vec2(1.0, 0.0);
    float fingers = 0.78 + 0.3 * snoise(vec3(bearing * 3.1, uSeed * 6.0));
    float reach   = uFreeze * outer * fingers;
    float frozen  = smoothstep(reach, reach - uBoundary * 1.6, d);
    if (frozen < 0.004) discard;

    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    /* ---- 冰壳：板块，以及堆积在其接缝里的霜 ---- */
    vec2  cell  = voronoi2(p * uPlateScale + uSeed * 20.0);
    float seams = smoothstep(0.28, 0.02, cell.x) * uSeam;
    float plate = mix(0.55, 1.0, cell.y) * uPlates;

    /* ---- 在它上面爬行的霜指 ---- */
    float warp = fbm3(vec3(p * 0.5, uTime * 0.12 + uSeed)) * uWarp;
    float fil  = ridged(vec3(p * uFingerScale + warp, uSeed * 11.0 + uTime * uCrawl), 4);
    float frost = smoothstep(0.66, 0.95, fil) * uFingers * (0.35 + 0.65 * radial);

    /* ---- 压力环，向内朝尖塔行进 ---- */
    float ring = 0.5 + 0.5 * cos((radial * uRings + uTime * uRingSpeed) * TAU);
    ring = pow(ring, 8.0) * interior;

    /* ---- 一道缓慢的寒气扫掠，让立着的场永远不完全静止 ---- */
    float ang = atan(p.y, p.x) / TAU + 0.5;
    float sweepPhase = fract(ang - uTime * uSweepSpeed);
    float sweep = pow(1.0 - sweepPhase, 6.0) * smoothstep(0.0, 0.05, sweepPhase) * uSweep * interior;

    /* ---- 尖塔所立的那汪池水 ---- */
    float core = smoothstep(uCoreSize * uRadius, 0.0, d) * uCore;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float wash  = interior * pow(radial, uFalloff) * uFill * plate;
    float body  = (wash + frost * 0.8) * breathe;
    float lines = (band * uBoundaryGlow + seams * interior * 0.9 + ring * 0.4 + sweep + core) * breathe;

    float alpha = clamp(body + lines, 0.0, 1.0) * frozen * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorField * body + uColorEdge * lines;
    // 正在推进的唇边仍在冻结，所以它在行进途中始终发亮。
    color += uColorEdge * smoothstep(uBoundary * 1.2, 0.0, abs(d - reach)) * 0.9 *
             step(0.02, uFreeze) * step(uFreeze, 0.985);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * 地板上的这张冰壳。一个四边形，每帧依据 `settings.glacier` 重新调整
 * 尺寸、重新着色。
 */
export function createFrostFieldMaterial() {
    const material = new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: sharedUniforms({
            uQuadSize: { value: 12 },
            uRadius: { value: 4.6 },
            uBoundary: { value: 0.4 },
            uBoundaryGlow: { value: 2.4 },
            uFill: { value: 0.26 },
            uFalloff: { value: 1.4 },
            uPlates: { value: 1 },
            uPlateScale: { value: 2.2 },
            uSeam: { value: 0.8 },
            uFingers: { value: 0.9 },
            uFingerScale: { value: 1.6 },
            uWarp: { value: 0.5 },
            uCrawl: { value: 0.12 },
            uRings: { value: 2.6 },
            uRingSpeed: { value: -0.5 },
            uSweep: { value: 0.4 },
            uSweepSpeed: { value: 0.12 },
            uCore: { value: 1 },
            uCoreSize: { value: 0.2 },
            uPulse: { value: 0.18 },
            uPulseSpeed: { value: 1.6 },
            uFreeze: { value: 0 },
            uSeed: { value: 0 },
            uFade: { value: 1 },
            uOpacity: { value: 1 },
            uColorField: { value: new Color(0.66, 0.9, 1) },
            uColorEdge: { value: new Color(1, 1, 1) },
        }),
        vertexShader: FIELD_VERTEX,
        fragmentShader: FIELD_FRAGMENT,
    });

    /**
     * @param {object} state { radius, quadSize, freeze, fade, seed }
     */
    material.userData.sync = (state) => {
        const c = settings.glacier;
        const g = settings.global;
        const u = material.uniforms;

        u.uQuadSize.value = state.quadSize;
        u.uRadius.value = state.radius;
        u.uFreeze.value = state.freeze;
        u.uFade.value = state.fade;
        u.uSeed.value = state.seed;

        u.uBoundary.value = c.fieldBoundary;
        u.uBoundaryGlow.value = c.fieldBoundaryGlow;
        u.uFill.value = c.fieldFill;
        u.uFalloff.value = c.fieldFalloff;
        u.uPlates.value = c.fieldPlates;
        u.uPlateScale.value = c.fieldPlateScale * g.noiseFrequency;
        u.uSeam.value = c.fieldSeam * g.shaderIntensity;
        u.uFingers.value = c.fieldFingers * g.shaderIntensity;
        u.uFingerScale.value = c.fieldFingerScale * g.noiseFrequency;
        u.uWarp.value = c.fieldWarp * g.noiseStrength;
        u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
        u.uRings.value = c.fieldRings;
        u.uRingSpeed.value = c.fieldRingSpeed;
        u.uSweep.value = c.fieldSweep;
        u.uSweepSpeed.value = c.fieldSweepSpeed;
        u.uCore.value = c.fieldCore;
        u.uCoreSize.value = c.fieldCoreSize;
        u.uPulse.value = c.fieldPulse;
        u.uPulseSpeed.value = c.fieldPulseSpeed;
        u.uOpacity.value = c.fieldOpacity * g.opacity;
        u.uColorField.value.copy(getColor(c.colorField));
        u.uColorEdge.value.copy(getColor(c.colorFieldEdge));
    };

    return material;
}

/* ==================================================================== */
/* 立在环上的那幅冷气帘幕                                                 */
/* ==================================================================== */

/**
 * 一根处在*参数*空间里的圆柱：`uv.x` 绕边界走一圈，`uv.y` 从地面到帘幕
 * 顶部；顶点阶段让它随高度向外张开，并用片元阶段侵蚀它所使用的那同一份
 * 噪声，把剪影推离正圆。没有这层位移，无论片元着色器怎么使劲，这层纱都
 * 是一根圆柱，读起来像一台造雾机，而不是从冰墙上泻下的空气。
 */
const VEIL_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uFlare;
  uniform float uBillow;
  uniform float uScale;
  uniform float uFlow;
  uniform float uSeed;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    vUv = uv;

    vec3 pos = position;
    vec2 outward = normalize(pos.xz + vec2(1e-5));

    // 冷气从边沿跌落时是向*外*溢出的，所以帘幕随高度向外倾，
    // 而不是笔直地立着。
    pos.xz *= 1.0 + uFlare * pow(clamp(uv.y, 0.0, 1.0), 1.6);

    // 米级的叶瓣，于是剪影绕着环鼓起又收窄。
    float lobe = snoise(vec3(outward * uScale * 1.4, uTime * uFlow * 0.35 + uSeed));
    pos.xz += outward * lobe * uBillow * (0.25 + 0.75 * uv.y);

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * 纱幕本身：脊状噪声被沿垂直方向狠狠拉伸，并*向下*滚动，越往上阈值越硬，
 * 于是帘幕朝顶部撕裂成一挂挂彼此分开的蒸汽，而不是终结于一条直线。
 * 与深度预通道做软淡出——正是这一点让它能立在碎片之间而不切进它们。
 */
const VEIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uStretch;
  uniform float uFlow;
  uniform float uErode;
  uniform float uFalloff;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorVeil;
  uniform vec3  uColorCrest;
  uniform float uGlobalGlow;

  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float up = clamp(vUv.y, 0.0, 1.0);

    // 在世界空间采样，于是环被重新缩放时帘幕不会游移；并在 Y 上压扁，
    // 让这些结构是一挂挂的落瀑而不是云团。
    vec3 sp = vec3(vWorld.xz * uScale, vWorld.y * uScale * uStretch + uTime * uFlow + uSeed * 7.0);
    float fil = ridged(sp, 4);

    // 越往上侵蚀越狠：帘幕顶部大半是空隙。
    float threshold = mix(0.52, 0.95, up * uErode);
    float veil = smoothstep(threshold, threshold + 0.22, fil);

    // 朝地面加权，并在贴近地面处收断，让帘幕在与地面相接的地方
    // 不会以一条硬线收尾。
    float profile = pow(1.0 - up, uFalloff) * smoothstep(0.0, 0.08, up);

    float alpha = veil * profile * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorVeil, uColorCrest, clamp(veil * 1.3 * (1.0 - up), 0.0, 1.0));
    gl_FragColor = vec4(color * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * 立着的那幅冻结蒸汽帘幕。一根架在边界上的开口圆柱，每帧依据
 * `settings.glacier` 重新调整尺寸、重新着色。
 */
export function createFrostVeilMaterial() {
    const material = new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: sharedUniforms({
            uFlare: { value: 0.35 },
            uBillow: { value: 0.22 },
            uScale: { value: 1.4 },
            uStretch: { value: 0.55 },
            uFlow: { value: 0.35 },
            uErode: { value: 0.55 },
            uFalloff: { value: 1.8 },
            uSoftFade: { value: 0.8 },
            uSeed: { value: 0 },
            uFade: { value: 1 },
            uOpacity: { value: 0.55 },
            uColorVeil: { value: new Color(0.55, 0.82, 1) },
            uColorCrest: { value: new Color(1, 1, 1) },
        }),
        vertexShader: VEIL_VERTEX,
        fragmentShader: VEIL_FRAGMENT,
    });

    /**
     * @param {object} state { fade, seed }
     */
    material.userData.sync = (state) => {
        const c = settings.glacier;
        const g = settings.global;
        const u = material.uniforms;

        u.uFade.value = state.fade;
        u.uSeed.value = state.seed;

        u.uFlare.value = c.veilFlare;
        u.uBillow.value = c.veilBillow * g.noiseStrength;
        u.uScale.value = c.veilScale * g.noiseFrequency;
        u.uStretch.value = c.veilStretch;
        u.uFlow.value = c.veilFlow * g.noiseSpeed;
        u.uErode.value = c.veilErode;
        u.uFalloff.value = c.veilFalloff;
        u.uSoftFade.value = c.veilSoftFade;
        u.uOpacity.value = c.veil * g.opacity;
        u.uColorVeil.value.copy(getColor(c.colorVeil));
        u.uColorCrest.value.copy(getColor(c.colorVeilCrest));
    };

    return material;
}
