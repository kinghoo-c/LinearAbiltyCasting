import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * 闪电（bolt）绘制的两个 pass。几何相同、路径相同、uniform 相同——
 * 只有缎带宽度和横跨缎带的剖面不同。
 */
export const BoltPass = Object.freeze({
    CORE: 0, // 白热化的细丝本身
    GLOW: 1, // 包裹细丝的宽大辉光
});

/**
 * 整条闪电都活在顶点着色器里。
 *
 * 一个顶点以 `(t, side)` 的形式进来——它在闪电上的位置，以及它位于缎带的哪
 * 一侧——并以一个世界坐标离开。中间的一切都由 `settings.thunder` 推导而来，
 * 因此 CPU 上不存在会过期的路径：拖动 `jitter` 会重新扭结一条已经在空中飞行
 * 的闪电，拖动 `spread` 会重新把它扇开，两者都在时钟停住的情况下完成。
 *
 * 有三样东西叠加起来构成形状：
 *
 *   1. **轴线**——从手部到落点的一条直线，被 `sag` 压弯。这是唯一知道本次
 *      施放指向何处的部分。
 *   2. **扇面**——垂直于轴线的平面内、逐细丝的常量偏移，从手部的
 *      `spreadNear` 张开到目标处的 `spread`，并以 `twist` 绕轴滚动。正是
 *      这一点把一根细丝与下一根区分开。
 *   3. **扭结（kinks）**——*线性*插值的 value noise 的若干倍频。刻意用线性：
 *      smoothstep 会把棱角磨圆，而这些棱角正是它读起来像闪电、而不是像一根
 *      软管晃动的全部原因。
 *
 * 随后把缎带用局部切线与视线向量叉乘，转向摄像机，这就是为什么闪电从任何角度
 * 看都保持表观粗细，却从来不是一条屏幕空间的线。
 */
const BOLT_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSag;
  uniform float uSeed;
  uniform float uRestrike;

  uniform float uStrands;
  uniform float uSpread;
  uniform float uSpreadNear;
  uniform float uSpreadCurve;
  uniform float uTwist;
  uniform float uTwistSpeed;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uConverge;

  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWidthCurve;
  uniform float uCoreWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;
  uniform float uFade;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  /** *线性*斜坡的 value noise——输出为分段线性，棱角分明。 */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  /**
   * 一根细丝在垂直平面内相对轴线的偏移。
   * span 是本次施放的长度，因此无论闪电伸出多远，uJitterScale 始终保持为
   * 每*米*的扭结数。
   */
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;

    // 固定的循环次数加逐倍频开关：动态上界不可移植，
    // 而且五次乘加无论如何也比那个分支更便宜。
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  vec3 boltPoint(float t, float seed, float radial, vec3 n1, vec3 n2, float span) {
    vec3 axis = mix(uOrigin, uTarget, t);
    axis.y += uSag * sin(t * PI);

    // 手部这一端永远钉死，目标那一端则按 uConverge 要求的那样钉紧——
    // 一条落在瞄准点以外某处的闪电，读起来就是个 bug。
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) *
                 mix(1.0, smoothstep(0.0, pinch, 1.0 - t), clamp(uConverge, 0.0, 1.0));

    vec2 offset = kink(t, seed, span) * uJitter * ends;

    float angle = seed * TAU + (t * uTwist + uTime * uTwistSpeed) * TAU;
    float reach = mix(uSpreadNear, uSpread, pow(clamp(t, 0.0, 1.0), max(uSpreadCurve, 0.01)));
    offset += vec2(cos(angle), sin(angle)) * reach * radial;

    return axis + n1 * offset.x + n2 * offset.y;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- 偏移所在的坐标架 ---- */
    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    // 用 Gram-Schmidt 正交化，而不是直接用原来的侧向量：轴线从手部向下
    // 倾斜，因此 uSide 只与它近似垂直。
    vec3 n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    /* ---- 这是哪根细丝，它披着什么形状 ---- */
    // 打击索引每秒 uRestrike 次把每根细丝弹到新的形状上；kink() 内部的
    // 爬行则在两次之间让它连续滑动。两者合在一起，才让一条持续存在的
    // 闪电不至于看上去像一条静止的缎带。
    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;
    float radial = uStrands <= 1.0 ? 0.0 : aStrand / (uStrands - 1.0);
    vStrand = radial;

    vec3 here = boltPoint(t, seed, radial, n1, n2, span);

    // 用有限差分求切线，并在远端镜像，好让最后一个节点仍然有邻居可看。
    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = boltPoint(ahead, seed, radial, n1, n2, span);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    /* ---- 让缎带转向摄像机 ---- */
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- 宽度 ---- */
    // 逐细丝的断续闪烁，量化到 uFlickerSpeed，好让整束细丝按同一个时钟
    // 频闪，而不是各自独立地闪光。
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale;
    halfWidth *= mix(1.0, uWidthTip, pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01)));
    halfWidth *= mix(uCoreWidth, 1.0, radial);
    halfWidth *= flash * uFade;

    // 全程使用世界空间：技能所在的 group 是单位变换，
    // 走 modelMatrix 只会让它有机会漂移。
    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BOLT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // 打击锋面之前还没有闪电。整条缎带照样完整绘制，在这里被裁掉而不是被
    // 缩放，因此锋面前行时*形状*从不改变——改变的只是它存在多少。
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef BOLT_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    // 前缘才是空气真正被击穿的地方。
    color += uColorCore * smoothstep(uProgress - tip * 2.0, uProgress, vT) * uTipGlow;

    // 量化而非正弦：真实的闪电是在不同亮度之间卡顿跳动，
    // 而不是像呼吸一样起伏。
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    alpha *= drawn * flicker * vFlash * uFade * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * 闪电的一个 pass。
 *
 * 两个 pass 共用除定义自身的那两个（`uWidthScale`、`uPassOpacity`）之外的
 * 全部 uniform，因此 `userData.sync()` 可以给两者传入同一份状态，编辑器也就
 * 把它们一并驱动。
 *
 * @param {number} pass BoltPass.*
 */
export function createLightningMaterial(pass = BoltPass.CORE) {
    const glow = pass === BoltPass.GLOW;

    const material = new ShaderMaterial({
        defines: glow ? { BOLT_GLOW: '' } : {},
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: sharedUniforms({
            uOrigin: { value: new Vector3() },
            uTarget: { value: new Vector3(0, 0, 1) },
            uSide: { value: new Vector3(1, 0, 0) },
            uSag: { value: 0.2 },
            uSeed: { value: 0 },
            uRestrike: { value: 24 },
            uProgress: { value: 0 },
            uFade: { value: 1 },

            uStrands: { value: 9 },
            uSpread: { value: 0.75 },
            uSpreadNear: { value: 0.05 },
            uSpreadCurve: { value: 1.6 },
            uTwist: { value: 0.45 },
            uTwistSpeed: { value: 0.8 },
            uBranchDim: { value: 0.72 },

            uJitter: { value: 0.34 },
            uJitterScale: { value: 0.85 },
            uOctaves: { value: 4 },
            uJitterFalloff: { value: 0.55 },
            uCrawl: { value: 3.2 },
            uPinch: { value: 0.14 },
            uConverge: { value: 0.8 },

            uWidth: { value: 0.085 },
            uWidthTip: { value: 0.5 },
            uWidthCurve: { value: 1 },
            uCoreWidth: { value: 2.1 },
            uCoreSharp: { value: 3.4 },
            uGlowFalloff: { value: 2.4 },
            uWidthScale: { value: glow ? 8 : 1 },
            uPassOpacity: { value: glow ? 0.32 : 1 },
            uSoftFade: { value: 0.5 },

            uFlicker: { value: 0.3 },
            uFlickerSpeed: { value: 34 },
            uStrandFlash: { value: 0.5 },
            uTipGlow: { value: 2 },
            uTipLength: { value: 0.08 },

            uOpacity: { value: 1 },
            uGlow: { value: 2.3 },
            uColorCore: { value: new Color(1, 1, 1) },
            uColorInner: { value: new Color(0.78, 0.92, 1) },
            uColorOuter: { value: new Color(0.22, 0.62, 1) },
            uColorHalo: { value: new Color(0.04, 0.24, 0.78) },
        }),
        vertexShader: BOLT_VERTEX,
        fragmentShader: BOLT_FRAGMENT,
    });

    /**
     * 把实时设置与当前的施放状态推入 uniform。
     *
     * 每帧调用——包括沙盒暂停时的零长度帧，正是这一点让下面每个控件都是一个
     * 实时的滑杆。
     *
     * @param {object} state { origin, target, side, progress, fade, seed, strands }
     */
    material.userData.sync = (state) => {
        const c = settings.thunder;
        const g = settings.global;
        const u = material.uniforms;

        u.uOrigin.value.copy(state.origin);
        u.uTarget.value.copy(state.target);
        u.uSide.value.copy(state.side);
        u.uSeed.value = state.seed;
        u.uProgress.value = state.progress;
        u.uFade.value = state.fade;
        u.uStrands.value = state.strands;

        u.uSag.value = c.sag;
        u.uRestrike.value = c.restrike;

        u.uSpread.value = c.spread;
        u.uSpreadNear.value = c.spreadNear;
        u.uSpreadCurve.value = c.spreadCurve;
        u.uTwist.value = c.twist;
        u.uTwistSpeed.value = c.twistSpeed;
        u.uBranchDim.value = c.branchDim;

        // 扭结是 `global.randomness` 与噪声乘数唯一能起作用的地方，
        // 所以只在这里缩放，而不是到处都缩放。
        u.uJitter.value = c.jitter * g.randomness * g.noiseStrength;
        u.uJitterScale.value = c.jitterScale * g.noiseFrequency;
        u.uOctaves.value = Math.round(c.octaves);
        u.uJitterFalloff.value = c.jitterFalloff;
        u.uCrawl.value = c.crawl * g.noiseSpeed;
        u.uPinch.value = c.pinch;
        u.uConverge.value = c.converge;

        u.uWidth.value = c.width;
        u.uWidthTip.value = c.widthTip;
        u.uWidthCurve.value = c.widthCurve;
        u.uCoreWidth.value = c.coreWidth;
        u.uCoreSharp.value = c.coreSharp;
        u.uGlowFalloff.value = c.glowFalloff;
        u.uWidthScale.value = glow ? c.glowWidth : 1;
        u.uPassOpacity.value = glow ? c.glowOpacity : 1;
        u.uSoftFade.value = c.softFade;

        u.uFlicker.value = c.flicker;
        u.uFlickerSpeed.value = c.flickerSpeed;
        u.uStrandFlash.value = c.strandFlash;
        u.uTipGlow.value = c.tipGlow;
        u.uTipLength.value = c.tipLength;

        u.uOpacity.value = c.opacity * g.opacity;
        u.uGlow.value = c.glow;
        u.uColorCore.value.copy(getColor(c.colorCore));
        u.uColorInner.value.copy(getColor(c.colorInner));
        u.uColorOuter.value.copy(getColor(c.colorOuter));
        u.uColorHalo.value.copy(getColor(c.colorHalo));
    };

    return material;
}
