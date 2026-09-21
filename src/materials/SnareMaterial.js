import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * 笼子绘制的两个 pass。几何相同、路径相同、uniform 相同——只有缎带宽度和
 * 横跨缎带的剖面不同，与闪电（bolt）完全一致。
 */
export const SnarePass = Object.freeze({
    CORE: 0, // 白热化的细丝本身
    GLOW: 1, // 包裹它们的宽大辉光
});

/**
 * 一根细丝所能扮演的四种身份。
 *
 * 角色由实例索引对四个实时计数比较得出，正是这一点让一条实例化条带就能画出
 * 整个陷阱：将它种入地面的鞭索、中央的柱体、向外爬到边界的触须，以及绕边界
 * 奔跑的弧线，是四条*参数化路径*，而不是四个网格。无论空中有多少细丝，两次
 * draw call 就覆盖全部，而把某个计数设为零即彻底注销该角色——这正是陷阱炸开
 * 的一瞬间牵引索消失的方式。
 */
export const SnareRole = Object.freeze({
    LEASH: 0,
    COLUMN: 1,
    TENDRIL: 2,
    RIM: 3,
});

/**
 * 整个笼子都活在顶点着色器里。
 *
 * 一个顶点以 `(t, side)` 的形式进来——它在自己那根细丝上的位置，以及它位于
 * 缎带的哪一侧——并以一个世界坐标离开。任何路径都不存在于 CPU 上，因此没有
 * 会过期的记录：拖动 `zoneRadius` 会重新缩放一个已经立在那里的陷阱，拖动
 * `height` 会重新生长柱体，而两者都是在时钟停住的情况下完成的。
 *
 * 有三样东西叠加在一起，与闪电（bolt）上的做法相同：
 *
 *   1. **路径**——角色自己的中心线。牵引索是一条下垂的线，柱体是一段扭转的
 *      攀升，触须是一条向外跑去的蜿蜒，边环则是绕圆周行进的弧。这是唯一
 *      知道陷阱几何的部分。
 *   2. **坐标架**——对那条路径做有限差分得到的切线，以及由它得到的两个
 *      法线。下面所有偏移都活在这个坐标架里，正是这一点让同一个 kink 函数
 *      既能服务竖直的柱子，也能服务平贴地面爬行的细丝。
 *   3. **扭结（kinks）**——*线性*插值的 value noise 的若干倍频。刻意用线性：
 *      smoothstep 会把棱角磨圆，而这些棱角正是它读起来像闪电、而不是像一根
 *      软管晃动的全部原因。
 *
 * 两个贴地角色会压制该偏移的竖直分量，并把结果钳在地面之上，因为一个 y 自由
 * 的扭结，会让一根细丝有一半长度埋在地下。
 */
const CAGE_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uCentre;      // 陷阱在地面上的落点
  uniform vec3  uHand;        // 牵引索离开施法者的位置
  uniform vec3  uFront;       // 牵引索行进中的前端
  uniform float uRadius;      // 占地半径，单位米——已由炸开过程缓动过
  uniform float uHeight;      // 柱体高度，单位米
  uniform float uSeed;
  uniform float uRestrike;
  uniform float uFade;

  uniform float uCountLeash;
  uniform float uCountColumn;
  uniform float uCountTendril;
  uniform float uCountRim;

  uniform float uLeashSag;
  uniform float uLeashSpread;
  uniform float uLeashCling;
  uniform float uLeashKink;
  uniform float uLeashWidth;

  uniform float uHeightCurve;
  uniform float uThroat;
  uniform float uColumnSpread;
  uniform float uColumnCurve;
  uniform float uColumnFlare;
  uniform float uColumnTwist;
  uniform float uColumnSpin;
  uniform float uColumnKink;
  uniform float uColumnWidth;
  uniform float uColumnTaper;

  uniform float uTendrilInner;
  uniform float uTendrilReach;
  uniform float uTendrilCurve;
  uniform float uTendrilWander;
  uniform float uTendrilArch;
  uniform float uTendrilHug;
  uniform float uTendrilSpin;
  uniform float uTendrilKink;
  uniform float uTendrilWidth;
  uniform float uTendrilDim;

  uniform float uRimSpan;
  uniform float uRimSpeed;
  uniform float uRimHeight;
  uniform float uRimJitter;
  uniform float uRimKink;
  uniform float uRimWidth;
  uniform float uRimDim;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;

  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vDim;
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
   * 一根细丝在垂直平面内相对其路径的偏移。
   * span 是那条路径的长度，因此无论这根细丝是 20 米长的鞭索，还是沿边环 1 米
   * 的一跳，uJitterScale 始终保持为每*米*的扭结数。
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

  /** 该角色在 t 处的中心线，尚未加入任何扭结。 */
  vec3 pathAt(float role, float f, float seed, float t) {
    if (role < 0.5) {
      /* ---- 牵引索：从手部到行进前端的一条线 ---- */
      vec3 p = mix(uHand, uFront, t);
      p.y += uLeashSag * sin(t * PI);
      // 负的下垂量会把鞭索压到地面上，而这正是抽向地面的鞭索该待的地方
      // ——但不是穿过去。
      p.y = max(p.y, uLeashCling);
      return p;
    }

    if (role < 1.5) {
      /* ---- 柱体：从中央扭转地攀升而出 ---- */
      float a = f * TAU + (t * uColumnTwist + uTime * uColumnSpin) * TAU;
      float r = uRadius * (mix(uThroat, uColumnSpread, pow(t, max(uColumnCurve, 0.01)))
                           + uColumnFlare * smoothstep(0.72, 1.0, t));
      vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
      p.y = pow(t, max(uHeightCurve, 0.01)) * uHeight;
      return p;
    }

    if (role < 2.5) {
      /* ---- 触须：一条向边界蜿蜒而去的曲线 ---- */
      // 偏向量是逐细丝的常量而非噪声，这样触须才会*始终一致*地弯曲，
      // 就像一次已经选定方向的放电；叠在它上面的扭结负责其余的部分。
      float veer = (hash11(seed + 5.0) - 0.5) * 2.0 * uTendrilWander;
      float a = f * TAU + uTime * uTendrilSpin * TAU + hash11(seed) * 0.4 + veer * pow(t, 1.4);
      float r = uRadius * mix(uTendrilInner, uTendrilReach, pow(t, max(uTendrilCurve, 0.01)));
      vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
      p.y = uTendrilHug + uTendrilArch * sin(t * PI);
      return p;
    }

    /* ---- 边环弧：电流沿着边界跳跃 ---- */
    float a = (f + uTime * uRimSpeed) * TAU + hash11(seed) * 0.3 + t * uRimSpan * TAU;
    float r = uRadius * (1.0 + uRimJitter * 0.25 * sin(t * 6.0 + seed));
    vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
    p.y = uTendrilHug + uRimHeight * sin(t * PI);
    return p;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- 这根细丝扮演的是哪个角色 ---- */
    float b1 = uCountLeash;
    float b2 = b1 + uCountColumn;
    float b3 = b2 + uCountTendril;

    float role = 0.0;
    float local = aStrand;
    float count = max(uCountLeash, 1.0);
    if (aStrand >= b3) {
      role = 3.0; local = aStrand - b3; count = max(uCountRim, 1.0);
    } else if (aStrand >= b2) {
      role = 2.0; local = aStrand - b2; count = max(uCountTendril, 1.0);
    } else if (aStrand >= b1) {
      role = 1.0; local = aStrand - b1; count = max(uCountColumn, 1.0);
    }
    // 刻意用开区间：对于绕圆展开的那些角色，0 和 1 会把两根细丝放在同一个
    // 方位角上。
    float f = local / count;

    // 打击索引每秒 uRestrike 次把每根细丝弹到新的形状上；kink() 内部的
    // 爬行则在两次之间让它连续滑动。
    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;

    /* ---- 逐角色的常量 ---- */
    float amp = uLeashKink;
    float widthMul = uLeashWidth;
    float span = max(length(uFront - uHand), 0.01);
    float dim = 1.0;
    if (role > 2.5) {
      amp = uRimKink; widthMul = uRimWidth; dim = uRimDim;
      span = max(uRadius * uRimSpan * TAU, 0.01);
    } else if (role > 1.5) {
      amp = uTendrilKink; widthMul = uTendrilWidth; dim = uTendrilDim;
      span = max(uRadius * max(uTendrilReach - uTendrilInner, 0.05), 0.01);
    } else if (role > 0.5) {
      amp = uColumnKink; widthMul = uColumnWidth;
      span = max(uHeight, 0.01);
    }
    vDim = dim;

    /* ---- 偏移所在的坐标架 ---- */
    float step_ = 0.02;
    vec3 here = pathAt(role, f, seed, t);
    vec3 behind = pathAt(role, f, seed, max(t - step_, 0.0));
    vec3 ahead = pathAt(role, f, seed, min(t + step_, 1.0));

    vec3 tangent = ahead - behind;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
    // 柱体是竖直走向的，因此常用的世界向上参考方向，恰恰会在最需要这个
    // 坐标架的那个角色上退化。
    vec3 upRef = abs(tangent.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 n1 = normalize(cross(tangent, upRef));
    vec3 n2 = normalize(cross(tangent, n1));

    /* ---- 扭结，以及把鞭索各细丝分开的那把扇子 ---- */
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) * smoothstep(0.0, pinch, 1.0 - t);

    vec2 k = kink(t, seed, span) * amp * uJitter * ends;
    if (role < 0.5) {
      float fan = (f - 0.5) * 2.0 * uLeashSpread;
      k += vec2(cos(seed), sin(seed)) * fan * ends;
    }

    vec3 offset = n1 * k.x + n2 * k.y;
    // 地面角色把扭结限制在地面平面内。这里若让 y 自由，每条触须都会有一半
    // 被埋掉，效果读起来就成了一条断断续续的虚线。
    if (role > 1.5) offset.y *= 0.3;

    vec3 world = here + offset;
    vec3 nextWorld = ahead + offset;
    if (role > 1.5) {
      world.y = max(world.y, uTendrilHug * 0.4);
      nextWorld.y = max(nextWorld.y, uTendrilHug * 0.4);
    }

    /* ---- 让缎带转向摄像机 ---- */
    vec3 tan2 = nextWorld - world;
    tan2 = length(tan2) > 1e-5 ? normalize(tan2) : tangent;
    vec3 toCamera = normalize(cameraPosition - world);
    vec3 binormal = cross(tan2, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- 宽度 ---- */
    // 逐细丝的断续闪烁，量化到 uFlickerSpeed，好让整个笼子按同一个时钟
    // 频闪，而不是各自独立地闪光。
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale * widthMul;
    // 每根细丝都是一条两端松开的弧，因此两端都会收细。
    halfWidth *= mix(1.0, pow(sin(clamp(t, 0.0, 1.0) * PI), 0.35), 0.85);
    if (role > 0.5 && role < 1.5) halfWidth *= mix(1.0, uColumnTaper, t);
    halfWidth *= flash * uFade;

    // 全程使用世界空间：技能所在的 group 是单位变换，
    // 走 modelMatrix 只会让它有机会漂移。
    vec4 mv = viewMatrix * vec4(world + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CAGE_FRAGMENT = /* glsl */ `
  #define PI 3.141592653589793

  uniform float uTime;
  uniform float uSeed;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
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
  varying float vDim;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef CAGE_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    // 量化而非正弦：真实的闪电是在不同亮度之间卡顿跳动，
    // 而不是像呼吸一样起伏。
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    // 松开的端头既要收细也要淡出。只收窄的缎带会在每个尖端留下一个硬点，
    // 而这里每根细丝都有两个端头。
    alpha *= pow(sin(clamp(vT, 0.0, 1.0) * PI), 0.35);
    alpha *= flicker * vFlash * vDim * uFade * uPassOpacity * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * 笼子的一个 pass。
 *
 * 两个 pass 共用除定义自身的那两个（`uWidthScale`、`uPassOpacity`）之外的
 * 全部 uniform，因此 `userData.sync()` 可以给两者传入同一份状态，编辑器也就
 * 把它们一并驱动。
 *
 * @param {number} pass SnarePass.*
 */
export function createSnareCageMaterial(pass = SnarePass.CORE) {
    const glow = pass === SnarePass.GLOW;

    const material = new ShaderMaterial({
        defines: glow ? { CAGE_GLOW: '' } : {},
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: sharedUniforms({
            uCentre: { value: new Vector3() },
            uHand: { value: new Vector3() },
            uFront: { value: new Vector3(0, 0, 1) },
            uRadius: { value: 4.4 },
            uHeight: { value: 6.2 },
            uSeed: { value: 0 },
            uRestrike: { value: 21 },
            uFade: { value: 1 },

            uCountLeash: { value: 3 },
            uCountColumn: { value: 8 },
            uCountTendril: { value: 12 },
            uCountRim: { value: 7 },

            uLeashSag: { value: -0.35 },
            uLeashSpread: { value: 0.22 },
            uLeashCling: { value: 0.12 },
            uLeashKink: { value: 0.3 },
            uLeashWidth: { value: 1 },

            uHeightCurve: { value: 0.85 },
            uThroat: { value: 0.07 },
            uColumnSpread: { value: 0.17 },
            uColumnCurve: { value: 1.35 },
            uColumnFlare: { value: 0.12 },
            uColumnTwist: { value: 0.55 },
            uColumnSpin: { value: 0.4 },
            uColumnKink: { value: 0.24 },
            uColumnWidth: { value: 1.6 },
            uColumnTaper: { value: 0.55 },

            uTendrilInner: { value: 0.06 },
            uTendrilReach: { value: 1 },
            uTendrilCurve: { value: 0.8 },
            uTendrilWander: { value: 0.9 },
            uTendrilArch: { value: 0.22 },
            uTendrilHug: { value: 0.05 },
            uTendrilSpin: { value: 0.05 },
            uTendrilKink: { value: 0.18 },
            uTendrilWidth: { value: 0.75 },
            uTendrilDim: { value: 0.8 },

            uRimSpan: { value: 0.19 },
            uRimSpeed: { value: 0.28 },
            uRimHeight: { value: 0.35 },
            uRimJitter: { value: 0.16 },
            uRimKink: { value: 0.12 },
            uRimWidth: { value: 0.7 },
            uRimDim: { value: 0.9 },

            uJitter: { value: 1 },
            uJitterScale: { value: 1.4 },
            uOctaves: { value: 4 },
            uJitterFalloff: { value: 0.55 },
            uCrawl: { value: 2.4 },
            uPinch: { value: 0.16 },

            uWidth: { value: 0.032 },
            uWidthScale: { value: glow ? 6.2 : 1 },
            uPassOpacity: { value: glow ? 0.44 : 1 },
            uStrandFlash: { value: 0.45 },
            uFlickerSpeed: { value: 30 },
            uFlicker: { value: 0.26 },
            uCoreSharp: { value: 4.4 },
            uGlowFalloff: { value: 2.3 },
            uSoftFade: { value: 0.7 },

            uOpacity: { value: 1 },
            uGlow: { value: 2.2 },
            uColorCore: { value: new Color(1, 1, 1) },
            uColorInner: { value: new Color(0.86, 0.82, 1) },
            uColorOuter: { value: new Color(0.56, 0.42, 1) },
            uColorHalo: { value: new Color(0.16, 0.05, 0.55) },
        }),
        vertexShader: CAGE_VERTEX,
        fragmentShader: CAGE_FRAGMENT,
    });

    /**
     * 把实时设置与当前的施放状态推入 uniform。
     *
     * 每帧调用——包括沙盒暂停时的零长度帧，正是这一点让下面每个控件都是一个
     * 实时的滑杆。
     *
     * @param {object} state
     *   { centre, hand, front, radius, height, fade, seed, counts }
     */
    material.userData.sync = (state) => {
        const c = settings.snare;
        const g = settings.global;
        const u = material.uniforms;

        u.uCentre.value.copy(state.centre);
        u.uHand.value.copy(state.hand);
        u.uFront.value.copy(state.front);
        u.uRadius.value = state.radius;
        u.uHeight.value = state.height;
        u.uSeed.value = state.seed;
        u.uFade.value = state.fade;

        u.uCountLeash.value = state.counts.leash;
        u.uCountColumn.value = state.counts.column;
        u.uCountTendril.value = state.counts.tendril;
        u.uCountRim.value = state.counts.rim;

        u.uRestrike.value = c.restrike;

        u.uLeashSag.value = c.leashSag;
        u.uLeashSpread.value = c.leashSpread;
        u.uLeashCling.value = c.leashCling;
        u.uLeashKink.value = c.leashKink;
        u.uLeashWidth.value = c.leashWidth;

        u.uHeightCurve.value = c.heightCurve;
        u.uThroat.value = c.throat;
        u.uColumnSpread.value = c.columnSpread;
        u.uColumnCurve.value = c.columnCurve;
        u.uColumnFlare.value = c.columnFlare;
        u.uColumnTwist.value = c.columnTwist;
        u.uColumnSpin.value = c.columnSpin;
        u.uColumnKink.value = c.columnKink;
        u.uColumnWidth.value = c.columnWidth;
        u.uColumnTaper.value = c.columnTaper;

        u.uTendrilInner.value = c.tendrilInner;
        u.uTendrilReach.value = c.tendrilReach;
        u.uTendrilCurve.value = c.tendrilCurve;
        u.uTendrilWander.value = c.tendrilWander;
        u.uTendrilArch.value = c.tendrilArch;
        u.uTendrilHug.value = c.tendrilHug;
        u.uTendrilSpin.value = c.tendrilSpin;
        u.uTendrilKink.value = c.tendrilKink;
        u.uTendrilWidth.value = c.tendrilWidth;
        u.uTendrilDim.value = c.tendrilDim;

        u.uRimSpan.value = c.rimSpan;
        u.uRimSpeed.value = c.rimSpeed;
        u.uRimHeight.value = c.rimHeight;
        u.uRimJitter.value = c.rimJitter;
        u.uRimKink.value = c.rimKink;
        u.uRimWidth.value = c.rimWidth;
        u.uRimDim.value = c.rimDim;

        // 扭结是 `global.randomness` 与噪声乘数唯一能起作用的地方，
        // 所以只在这里缩放，而不是到处都缩放。
        u.uJitter.value = c.jitter * g.randomness * g.noiseStrength;
        u.uJitterScale.value = c.jitterScale * g.noiseFrequency;
        u.uOctaves.value = Math.round(c.octaves);
        u.uJitterFalloff.value = c.jitterFalloff;
        u.uCrawl.value = c.crawl * g.noiseSpeed;
        u.uPinch.value = c.pinch;

        u.uWidth.value = c.width;
        u.uWidthScale.value = glow ? c.glowWidth : 1;
        u.uPassOpacity.value = glow ? c.glowOpacity : 1;
        u.uStrandFlash.value = c.strandFlash;
        u.uFlickerSpeed.value = c.flickerSpeed;
        u.uFlicker.value = c.flicker;
        u.uCoreSharp.value = c.coreSharp;
        u.uGlowFalloff.value = c.glowFalloff;
        u.uSoftFade.value = c.softFade;

        u.uOpacity.value = c.opacity * g.opacity;
        u.uGlow.value = c.glow;
        u.uColorCore.value.copy(getColor(c.colorCore));
        u.uColorInner.value.copy(getColor(c.colorInner));
        u.uColorOuter.value.copy(getColor(c.colorOuter));
        u.uColorHalo.value.copy(getColor(c.colorHalo));
    };

    return material;
}

/* ==================================================================== */
/* 烧进地面的场                                                          */
/* ==================================================================== */

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 指示器所承诺的那个圆，被烧进了地面。
 *
 * 与瞄准圈相同的符号距离构造，同样的粗环带，因为这种对应关系*就是*效果
 * 本身：你点击之前量出来的范围，就是现在立在地面上的范围。它没有沿用的是
 * 处理方式——内部是被烧焦并布满脉络的，而不是一层淡淡的水洗；圆环是一道
 * 灼痕而不是一条线；而且里面的一切都在爬行。
 *
 * 它是一个由技能自身持有的网格，而不是池化的贴花，只有这一个原因：贴花在
 * 生成时就固定了半径，而这个圆必须在仍然立着的时候随 `zoneRadius` 重新
 * 缩放。
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uBoundary;
  uniform float uBoundaryGlow;
  uniform float uFill;
  uniform float uFalloff;
  uniform float uVeins;
  uniform float uVeinScale;
  uniform float uVeinSharp;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uSpokes;
  uniform float uSpokeLength;
  uniform float uSpin;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uPulse;
  uniform float uPulseSpeed;
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
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * 0.4;
    float inner = max(0.01, uRadius - uBoundary * 0.6);

    float aa = fwidth(d) + 0.02;
    if (d > outer + aa * 4.0) discard;

    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    /* ---- 烧过整个圆盘的脉络 ---- */
    // 在*平面*上采样并做域扭曲，绝不用 atan()：角向查表会让同一方位上的每个
    // 半径都拿到同一个值，并从中心画出死直的辐条——那是烟花，不是灼痕。
    float warp = fbm3(vec3(p * 0.5, uTime * 0.2 + uSeed)) * uWarp;
    float fil = ridged(vec3(p * uVeinScale + warp, uSeed * 11.0 + uTime * uCrawl), 4);
    float veins = smoothstep(mix(0.55, 0.86, uVeinSharp), 0.98, fil) * interior * uVeins;

    /* ---- 从中央向外跑出的压力环 ---- */
    float ring = 0.5 + 0.5 * cos((radial * uRings - uTime * uRingSpeed) * TAU);
    ring = pow(ring, 8.0) * interior;

    /* ---- 绕边界步进的刻度 ---- */
    float ang = atan(p.y, p.x) / TAU + 0.5;
    float spokePhase = fract(ang * uSpokes + uTime * uSpin * uSpokes);
    float spoke = 1.0 - smoothstep(0.22, 0.3, spokePhase);
    spoke *= smoothstep(inner - uSpokeLength, inner, d) * smoothstep(outer, inner, d);

    /* ---- 柱体所站立的那滩光 ---- */
    float core = smoothstep(uCoreSize * uRadius, 0.0, d) * uCore;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float wash = interior * pow(radial, uFalloff) * uFill;
    float lines = (band * uBoundaryGlow + spoke + core + ring * 0.35) * breathe;
    float body = (wash + veins * 0.9) * breathe;

    float alpha = clamp(body + lines, 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorField * body + uColorEdge * lines;
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * 地面场。单个 quad，每帧依据 `settings.snare` 重新调整尺寸并重新着色。
 */
export function createSnareFieldMaterial() {
    const material = new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: sharedUniforms({
            uQuadSize: { value: 12 },
            uRadius: { value: 4.4 },
            uBoundary: { value: 0.4 },
            uBoundaryGlow: { value: 2.6 },
            uFill: { value: 0.3 },
            uFalloff: { value: 1.7 },
            uVeins: { value: 1 },
            uVeinScale: { value: 1.5 },
            uVeinSharp: { value: 0.72 },
            uWarp: { value: 0.55 },
            uCrawl: { value: 0.5 },
            uRings: { value: 2.4 },
            uRingSpeed: { value: 0.8 },
            uSpokes: { value: 20 },
            uSpokeLength: { value: 0.5 },
            uSpin: { value: 0.05 },
            uCore: { value: 1.3 },
            uCoreSize: { value: 0.22 },
            uPulse: { value: 0.3 },
            uPulseSpeed: { value: 3.4 },
            uSeed: { value: 0 },
            uFade: { value: 1 },
            uOpacity: { value: 1 },
            uColorField: { value: new Color(0.56, 0.42, 1) },
            uColorEdge: { value: new Color(1, 1, 1) },
        }),
        vertexShader: FIELD_VERTEX,
        fragmentShader: FIELD_FRAGMENT,
    });

    /**
     * @param {object} state { radius, quadSize, fade, seed }
     */
    material.userData.sync = (state) => {
        const c = settings.snare;
        const g = settings.global;
        const u = material.uniforms;

        u.uQuadSize.value = state.quadSize;
        u.uRadius.value = state.radius;
        u.uFade.value = state.fade;
        u.uSeed.value = state.seed;

        u.uBoundary.value = c.fieldBoundary;
        u.uBoundaryGlow.value = c.fieldBoundaryGlow;
        u.uFill.value = c.fieldFill;
        u.uFalloff.value = c.fieldFalloff;
        u.uVeins.value = c.fieldVeins * g.shaderIntensity;
        u.uVeinScale.value = c.fieldVeinScale * g.noiseFrequency;
        u.uVeinSharp.value = c.fieldVeinSharp;
        u.uWarp.value = c.fieldWarp * g.noiseStrength;
        u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
        u.uRings.value = c.fieldRings;
        u.uRingSpeed.value = c.fieldRingSpeed;
        u.uSpokes.value = Math.max(0, Math.round(c.fieldSpokes));
        u.uSpokeLength.value = c.fieldSpokeLength;
        u.uSpin.value = c.fieldSpin;
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
