import {
    ShaderMaterial,
    CustomBlending,
    AddEquation,
    OneFactor,
    OneMinusSrcAlphaFactor,
    Color,
    DoubleSide,
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * 在把低频凸起（bulge）计入之前，边缘的撕裂能把密度向外推到超出名义管道半径多远。
 * 与片元着色器里的 `smoothstep(REACH_LO, REACH_HI, q)` 截断保持一致。
 */
export const FIRE_SHRED_REACH = 1.55;

/**
 * 体积向外能达到的总范围，以名义管道半径为单位。
 *
 * 代理外壳必须*包住*密度场：凡是场能达到、而外壳达不到的地方，都会被一条笔直的边切掉。
 * 凸起直接缩放局部半径，因此它会与撕裂范围相乘。
 */
export function fireHullReach() {
    // 这个 1.3 是余量，不是随手凑的。外壳是一条扁平带状面，而它要包住的体积是一段被拉伸的
    // 胶囊体，所以让两者精确对齐，就会把端帽的轮廓正好压在外壳的收尾边上——而一个比代理
    // 多出一个像素的体积，会被一条笔直的线切掉，这正是这项技术最明显的一种失败方式。
    return FIRE_SHRED_REACH * (1 + settings.meteor.trailBulge) * 1.3;
}

/**
 * 沿流方向在 `u` 处的火焰半径，以 `uRadius` 为单位。
 *
 * 两个相互竞争的项：燃烧朝头部增长，而它身后已经燃尽的燃气有时间膨胀——正是这一点让
 * 尾迹呈现出翻涌、大致圆柱形的轮廓，而不是收束成一根针。
 *
 * 顶点着色器（外壳尺寸）、片元着色器（密度场）以及 `MeteorAbility` 的 `radiusProfile`
 * （代理几何）逐字共用这段代码。四者必须一致，否则外壳就会把体积裁掉。
 */
const PROFILE_GLSL = /* glsl */ `
  uniform float uWakeSpread;
  float flameProfile(float u) {
    return (0.34 + 0.66 * pow(u, 0.55)) * (1.0 + uWakeSpread * pow(1.0 - u, 1.8));
  }
`;

/**
 * 流星的燃烧尾迹，以黑体的形式做体积光线步进（raymarch）。
 *
 * 整段是从 freehand firebending 沙盒原样搬过来的，并重新对准流星的弧线：还是同一个
 * 体积渲染器，只是改由 `settings.meteor` 的 `trail*` 参数块驱动，而不是那个项目里的
 * `fire` 块。
 *
 * 这个材质所应用的网格*并不是*火焰——它只是飞行轨迹外围一个朝向相机的代理外壳
 * （见 RibbonGeometry 的 `frame` 选项）。每个片元都用 `aCenter` / `aTangent` 重建曲线
 * 的局部坐标系，从相机穿过自身发出一条射线，并对下面描述的场积分发射与吸收。
 *
 * 场分四层构建，由粗到细，因为这正是眼睛阅读一个真实火球的顺序：
 *
 *  1. *轮廓*——围绕飞行轨迹的胶囊体，横截面为水滴形（浮力把它向上拉伸），其局部半径由
 *     一个频率极低的噪声倍频调制。最后这一点不是装饰：火球的轮廓主要由几米尺度的团块
 *     主导，而火焰细节频率上的多倍频湍流只能啃噬胶囊的边缘——结果看起来依旧是一根带
 *     明暗的管子。
 *  2. *涡旋卷起*——高温气体脱落出环状涡，它们沿尾迹向后传播并随年龄增长。在（沿流方向、
 *     竖直方向）平面内用一道行进波旋转噪声域，会让场自己折叠起来，这正是产生卷曲、蘑菇状
 *     翻涌的原因。普通的 fbm，无论多少倍频，只能做出云；它从来做不出卷曲。
 *  3. *湍流*——5 个逐步做域扭曲（domain warp）的倍频，倍频之间做旋转以消除晶格对齐，
 *     每个倍频向上漂移得都比前一个更快，于是细节超越了它所依附的粗大形状，撕裂成向上
 *     舔舐的舌状结构。
 *  4. *撕裂*——侵蚀在轴上很弱，在边缘却很剧烈，因此火焰保留一颗坚实的燃烧核心，而它的
 *     边缘消散成真实火焰才有的丝缕与脱离的飘絮。
 *
 * 着色由温度驱动，而不是由梯度驱动：
 *
 *   温度       由胶囊衰减承载——即几何形状——两个最粗的噪声倍频只对它做*轻微扰动*，
 *                这样一条舌状结构会沿着自己的脊线保持高温，而不至于让噪声把自己画出来。
 *                它还会随年龄逐渐变平，因为燃尽的燃气已经混合，不再有灼热的轴心和冷却的
 *                表皮之分。
 *   发射       该温度下的普朗克黑体颜色，以 (T/Tcore)^3 辐射。火焰不是一套调色板，
 *                而是一个温度：红色边缘 → 橙色主体 → 白色核心的连续过渡，以及横跨它的
 *                巨大亮度范围，两者都从物理里自然得出。
 *   散射       燃烧核心附近的冷气体被它的光照亮。没有这一项，烟熏的边缘会变成死黑，
 *                而不是发光。
 *   吸收       烟尘消光。冷烟遮挡得很硬，但即便最热的气体也保有一个下限（`uCoreClarity`）：
 *                没有这个下限，步进会把整个火球的深度积分成一个被截断的白色团块，而不是
 *                展示出它靠近相机的那一面。
 *
 * 一条花了很多次渲染才学到的警告，因为本文件里三个彼此独立的决定都受它支配（热度场只用
 * 粗倍频、`uHeatFollow` 取值克制、随年龄压平）：辐射功率是温度的高次幂，所以无论什么在
 * 驱动温度，它的对比度在画面上都会被放大好几倍。把这个放大器对准湍流场，它就会落在场的
 * 等值集上，而那些等值集是层层嵌套的闭合环，于是火焰渲染出来像打磨过的玛瑙——浓密的等高线
 * 缠住每一个团块。再怎么调颜色都救不回来；解法永远是让温度更钝。
 *
 * 最后这一点也正是为什么这里的混合模式用的是预乘的 "over"，而不是其余 VFX 所用的叠加混合：
 * 真实的火焰既发光也遮挡。步进会被不透明深度预通道裁剪，因此体积会被地面和角色遮挡，并在
 * 与它们接触处柔和淡出。
 */
export class VolumetricFireMaterial extends ShaderMaterial {
    constructor() {
        super({
            transparent: true,
            depthWrite: false,
            // 步进内部的逐采样场景深度裁剪能把遮挡处理妥当；去测试扁平代理外壳自身的深度，
            // 反而会把体积切开。
            depthTest: false,
            blending: CustomBlending,
            blendEquation: AddEquation,
            blendSrc: OneFactor,
            blendDst: OneMinusSrcAlphaFactor,
            blendSrcAlpha: OneFactor,
            blendDstAlpha: OneMinusSrcAlphaFactor,
            side: DoubleSide,
            toneMapped: false,
            uniforms: sharedUniforms({
                /* 形状 */
                uRadius: { value: 0.95 },
                uHeadSize: { value: 2.1 },
                uPlume: { value: 1.8 },
                uWakeSpread: { value: 1.1 },
                uStreamLength: { value: 6.0 },
                uArcLength: { value: 7.0 },
                uTailPad: { value: 0.3 },
                uDetachment: { value: 0.5 },
                uSoftness: { value: 0.45 },
                uShred: { value: 1.35 },
                uBulge: { value: 0.28 },
                uBulgeScale: { value: 0.5 },
                /* 运动 */
                uFlow: { value: 2.4 },
                uBuoyancy: { value: 2.6 },
                uSwirl: { value: 0.45 },
                uSwirlSpeed: { value: 0.9 },
                uVortex: { value: 1.15 },
                uRingFreq: { value: 0.55 },
                uRingSpeed: { value: 1.6 },
                uNoiseFrequency: { value: 3.2 },
                uNoiseStrength: { value: 0.9 },
                uWarp: { value: 0.2 },
                uTongue: { value: 0.5 },
                uStreamStretch: { value: 0.3 },
                uWisp: { value: 0.0 },
                uFlicker: { value: 0.45 },
                uLick: { value: 3.2 },
                uOctaves: { value: 5 },
                /* 温度与辐射 */
                uTempCore: { value: 3500 },
                uTempEdge: { value: 1550 },
                uEmissionCurve: { value: 2.6 },
                uHeatFocus: { value: 1.0 },
                uHeatFalloff: { value: 1.15 },
                uHeatFollow: { value: 0.2 },
                uTailHeat: { value: 0.5 },
                uPalette: { value: 0.0 },
                uScatter: { value: 0.9 },
                uScatterFalloff: { value: 2.2 },
                /* 渲染 */
                uDensity: { value: 1.35 },
                uSoot: { value: 1.5 },
                uCoreClarity: { value: 0.62 },
                uEmission: { value: 6.5 },
                uOpacity: { value: 1 },
                uSteps: { value: 44 },
                uSeed: { value: Math.random() * 20 },
                uHeadFade: { value: 0 },
                uTailFade: { value: 0.1 },
                uColorCore: { value: new Color(1, 0.96, 0.82) },
                uColorMid: { value: new Color(1, 0.69, 0.18) },
                uColorEdge: { value: new Color(1, 0.24, 0.06) },
                uColorSmoke: { value: new Color(0.14, 0.1, 0.09) },
            }),
            vertexShader: /* glsl */ `
        uniform float uArcLength;
        uniform float uTailPad;
        uniform float uStreamLength;
        uniform float uRadius;
        uniform float uHeadSize;

        attribute float aDist;
        attribute float aRandom;
        attribute vec3  aCenter;
        attribute vec3  aTangent;

        varying vec3  vCenter;
        varying vec3  vTangent;
        varying float vS;
        varying float vRadius;
        varying vec3  vWorld;
        varying float vRandom;

        ${PROFILE_GLSL}

        void main() {
          vCenter = aCenter;
          vTangent = normalize(aTangent);
          // 距离*流*尾端的米数（外壳两端都做了留白，以便覆盖它的端帽）。
          vS = aDist * uArcLength - uTailPad;
          vRandom = aRandom;

          // 局部管道半径，这样片元可以按它前方的那段火焰来设定自己的步进窗口，而不是按整条
          // 流最粗的部位——细尾巴因此得到细密的步长，而不是大部分都落在空处。
          float u = clamp(vS / max(uStreamLength, 0.01), 0.0, 1.0);
          vRadius = uRadius * flameProfile(u)
                  * (1.0 + (uHeadSize - 1.0) * smoothstep(0.62, 1.0, u));

          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
            fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uRadius;
        uniform float uHeadSize;
        uniform float uPlume;
        uniform float uStreamLength;
        uniform float uDetachment;
        uniform float uSoftness;
        uniform float uShred;
        uniform float uBulge;
        uniform float uBulgeScale;
        uniform float uFlow;
        uniform float uBuoyancy;
        uniform float uSwirl;
        uniform float uSwirlSpeed;
        uniform float uVortex;
        uniform float uRingFreq;
        uniform float uRingSpeed;
        uniform float uNoiseFrequency;
        uniform float uNoiseStrength;
        uniform float uWarp;
        uniform float uTongue;
        uniform float uStreamStretch;
        uniform float uWisp;
        uniform float uFlicker;
        uniform float uLick;
        uniform float uOctaves;
        uniform float uTempCore;
        uniform float uTempEdge;
        uniform float uEmissionCurve;
        uniform float uHeatFocus;
        uniform float uHeatFalloff;
        uniform float uHeatFollow;
        uniform float uTailHeat;
        uniform float uPalette;
        uniform float uScatter;
        uniform float uScatterFalloff;
        uniform float uDensity;
        uniform float uSoot;
        uniform float uCoreClarity;
        uniform float uEmission;
        uniform float uOpacity;
        uniform float uSteps;
        uniform float uSeed;
        uniform float uHeadFade;
        uniform float uTailFade;
        uniform vec3  uColorCore;
        uniform vec3  uColorMid;
        uniform vec3  uColorEdge;
        uniform vec3  uColorSmoke;
        uniform float uShaderIntensity;
        uniform float uGlobalGlow;
        uniform vec2  uResolution;
        uniform sampler2D uSceneDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;

        varying vec3  vCenter;
        varying vec3  vTangent;
        varying float vS;
        varying float vRadius;
        varying vec3  vWorld;
        varying float vRandom;

        ${noiseGLSL}
        ${commonGLSL}
        ${PROFILE_GLSL}

        /* 边缘撕裂的起点与终点。REACH_HI 限定了噪声能把密度推到名义管道之外多远，因而也
           限定了代理外壳需要多宽——它在 JS 一侧由 FIRE_SHRED_REACH 对应镜像。 */
        const float REACH_LO = 1.15;
        const float REACH_HI = 1.55;

        /* 体积步进需要一个*廉价*的场：这是哈希晶格上的三线性 value noise，开销大约只有
           表面着色器所用 simplex noise 的三分之一，而当它的五个倍频被平流、扭曲并卷动
           起来之后，两者已分辨不出差别。 */
        float vnoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);

          float a = hash13(i);
          float b = hash13(i + vec3(1.0, 0.0, 0.0));
          float c = hash13(i + vec3(0.0, 1.0, 0.0));
          float d = hash13(i + vec3(1.0, 1.0, 0.0));
          float e = hash13(i + vec3(0.0, 0.0, 1.0));
          float g = hash13(i + vec3(1.0, 0.0, 1.0));
          float h = hash13(i + vec3(0.0, 1.0, 1.0));
          float k = hash13(i + vec3(1.0, 1.0, 1.0));

          return mix(
            mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
            mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
            f.z
          );
        }

        /* 在倍频之间施加的、行列式为 1 的旋转。Value noise 建立在轴对齐的晶格上，所以沿
           相同坐标轴堆叠倍频会让它们的特征排成可见的网格；在它们之间旋转域可以把这种结构
           打散。 */
        const mat3 OCTAVE_ROT = mat3(
           0.00,  0.80,  0.60,
          -0.80,  0.36, -0.48,
          -0.60, -0.48,  0.64
        );

        /**
         * 湍流火焰场，归一化到 0..1。
         *
         * 有三点让它区别于普通的 fbm，其中两点是免费的——它们复用了已经付过代价的倍频值：
         *
         *  - *渐进式域扭曲*：每个倍频都被前一个倍频位移，这会让场自己折叠起来。直白的 fbm
         *    给出圆润、云朵状的团块；扭曲过的 fbm 给出火焰真正会形成的卷曲、翻涌的片状
         *    结构。
         *  - *浮力剪切*：每个倍频还都比前一个向上漂移得更快，于是细节超越了它所依附的粗大
         *    形状，结构撕裂成向上舔舐的舌状。
         *  - *倍频间旋转*：见 OCTAVE_ROT。
         *
         * @param ridge out — 由两个最细倍频产生的尖锐脊状丝缕，0..1，用来把边缘撕裂成细条。
         * @param coarse out — 截断到两个最大尺度的场，0..1。温度是从*这个*场读取的，
         *              而不是从完整场读取；参见使用它的那处说明。
         */
        float flameFbm(vec3 p, float rise, out float ridge, out float coarse) {
          float v = 0.0;
          float a = 0.5;
          float norm = 0.0;
          float scale = 1.0;
          ridge = 0.0;
          coarse = 0.5;

          for (int i = 0; i < 5; i++) {
            if (float(i) >= uOctaves) break;

            float n = vnoise(p);
            v += a * n;
            norm += a;
            if (i == 1) coarse = v / norm;
            // 脊只来自最细的几个倍频。把粗倍频也一并平均进来，会产生宽而平滑的脊，它们
            // 沿着场的等值线走，看起来像画在火焰上的等高线，而不是火焰内部的丝缕。
            if (i >= 3) ridge = max(ridge, 1.0 - abs(n * 2.0 - 1.0));

            p = OCTAVE_ROT * p * 2.17 + (n - 0.5) * uWarp * vec3(1.7, 0.9, 1.3);
            scale *= 2.17;
            p.y -= rise * scale * (1.0 + 0.6 * float(i));
            a *= 0.55;
          }

          return v / max(norm, 1e-4);
        }

        /**
         * 普朗克辐射体，转换到线性工作空间。
         *
         * 火焰不是一套调色板，而是一个温度。真实火焰边缘呈深红、主体橙黄、核心发白，原因
         * 是这些正是灰体在大约 1200 K 到 3300 K 之间发出的颜色——而核心过曝、边缘依旧
         * 暗淡，则是因为辐射功率按 T^4 缩放。这里两者都从物理里自然得出，不必手工调校，
         * 这也是为什么结果在任何曝光下都能自洽。
         *
         * 拟合：Tanner Helland 的分段近似，在 1000-40000 K 范围内有效。
         */
        vec3 blackbody(float kelvin) {
          float t = clamp(kelvin, 1000.0, 12000.0) * 0.01;
          vec3 c;
          if (t <= 66.0) {
            c.r = 1.0;
            c.g = 0.3900816 * log(t) - 0.6318414;
            c.b = t <= 19.0 ? 0.0 : 0.5432068 * log(t - 10.0) - 1.1962540;
          } else {
            c.r = 1.2929362 * pow(t - 60.0, -0.1332047);
            c.g = 1.1298909 * pow(t - 60.0, -0.0755148);
            c.b = 1.0;
          }
          c = clamp(c, 0.0, 1.0);
          return c * c * (0.6 + 0.4 * c); // 廉价、精度也够用的 sRGB -> 线性
        }

        /**
         * 世界空间中某一点的火焰密度。
         *
         * @param heat out — 归一化温度，在被扰动的表面处为 0，在燃烧核心处为 1。
         * @param bath out — 该点被周围火焰照亮的强度，用于单次散射项。
         */
        float flameSample(vec3 p, out float heat, out float bath) {
          heat = 0.0;
          bath = 0.0;

          vec3 rel = p - vCenter;
          float ax = dot(rel, vTangent);
          vec3 perp = rel - vTangent * ax;

          float s = vS + ax;                                  // 距尾端的米数
          float u = clamp(s / max(uStreamLength, 0.01), 0.0, 1.0);
          float age = 1.0 - u;

          // 鼻部是火球时，其身后翻涌的尾迹。
          float radius = uRadius * flameProfile(u)
                       * (1.0 + (uHeadSize - 1.0) * smoothstep(0.62, 1.0, u));

          // 一个 "up" 取世界向上的局部坐标系（从切线方向投影掉），这样浮力、水滴形拉伸
          // 以及噪声在竖直方向的拉长，全都朝着重力真正在意的方向起作用。
          vec3 upAxis = vec3(0.0, 1.0, 0.0) - vTangent * vTangent.y;
          float upLen = length(upAxis);
          upAxis = upLen > 1e-3 ? upAxis / upLen : vec3(1.0, 0.0, 0.0);
          vec3 sideAxis = cross(vTangent, upAxis);

          float py = dot(perp, upAxis);
          float px = dot(perp, sideAxis);

          // 浮力拉伸：主要朝上，所以横截面是水滴形，而不是对称的管道。下侧只拿到四分之一
          // ——足以让火焰垂坠下来，而不是终止在一个水平的平切面上，那正是不做拉伸的下侧
          // 看起来的样子。
          float plume = max(uPlume, 0.05);
          float shapedY = py > 0.0 ? py / plume : py / (1.0 + (plume - 1.0) * 0.25);
          float rad = length(vec2(px, shapedY));

          // 把两端之外沿轴向溢出的部分折进半径：形成一个胶囊体，这样流的两端是圆帽，而不是
          // 被平切掉。
          float over = s - clamp(s, 0.0, uStreamLength);
          rad = sqrt(rad * rad + over * over);

          // 在付出任何噪声开销*之前*先做保守剔除：即使凸起被完全向外推，场也到不了这里
          // 之外。大多数射线上大多数采样点都落在这里，所以正是这个测试在为外壳所需的余量
          // 买单。
          float qNominal = rad / max(radius, 1e-3);
          if (qNominal > REACH_HI * (1.0 + uBulge)) return 0.0;

          float sFlow = s - uTime * uFlow;                    // 向后流动

          // ---- 1. 轮廓：米级团块 -------------------------
          // 单个倍频，波长与火焰自身宽度同量级。火球的轮廓由这个尺度的团块主导；火焰细节
          // 频率上的湍流只能啃噬胶囊的边缘，结果看起来依旧是一根带明暗的管子。
          float lobe = vnoise(vec3(px, py * 0.8, sFlow * 0.7) * uBulgeScale
                              + vec3(uSeed, uTime * 0.25, 0.0)) * 2.0 - 1.0;
          radius *= 1.0 + uBulge * lobe;

          float q = rad / max(radius, 1e-3);
          float edge = 1.0 - q;
          if (edge < -1.2) return 0.0;

          // ---- 2. 涡旋卷起 ----------------------------------------
          // 噪声域附着在流上（以轴为中心的局部坐标系），这样火焰是被带着走，而不是在世界
          // 里游泳。
          vec2 rp = rot2(s * uSwirl * 0.3 + uTime * uSwirlSpeed + uSeed) * vec2(px, py);

          // 高温气体脱落出环状涡，它们沿尾迹向后传播并随年龄增长。用那道行进波在
          // （沿流方向、竖直方向）平面内旋转域，会让场自己折叠起来——这正是产生卷曲、
          // 蘑菇状翻涌的原因。普通的 fbm，无论倍频多少，只能做出云；它从来做不出卷曲。
          // 旋转在轴上最强，在管道之外衰减殆尽，因此边缘是被核心剪切过去，而不是与核心
          // 一起刚性旋转。
          float phase = s * uRingFreq - uTime * uRingSpeed + uSeed;
          float roll = uVortex * sin(phase * 6.2831853)
                     * smoothstep(0.0, 0.32, age) * exp(-q * q * 0.7);
          vec2 rolled = rot2(roll) * vec2(sFlow * uStreamStretch, rp.y * uTongue);

          // ---- 3. 湍流 --------------------------------------------
          // 刻意做成各向异性：在竖直方向和沿流方向使用更低的频率，把每个结构都拉成又高又
          // 顺流的舌状。
          vec3 np = vec3(rp.x, rolled.y, rolled.x) * uNoiseFrequency;
          np.y -= uTime * uBuoyancy;                          // 高温气体向上攀升

          // 径向剪切。边缘处的气体不受约束，而且比轴上的气体攀升和落后得更久，因此域被
          // 向上并向后拖拽，拖拽的幅度与它离轴多远成正比。正是这一点把圆润的团块变成
          // 从火焰边缘舔起的舌状：没有剪切时，各处结构形状都一样，只是大小在变。
          np.y -= uLick * q * q;
          np.z += uLick * 0.45 * q * q;

          float ridge, coarse;
          float n = flameFbm(np, uTime * uBuoyancy * 0.06, ridge, coarse) * 2.0 - 1.0;
          coarse = coarse * 2.0 - 1.0;

          // 丝缕属于边缘。在主体里它们只会让一颗本应看起来是一整片连续燃烧气体的核心
          // 出现斑驳。
          //
          // 注意符号：脊在噪声的等值线*上*达到峰值，所以加上它会让等值线变粗，火焰最终
          // 被画成一圈圈明亮的闭合环，像一幅等高线图。改为减去它则会加深团块之间的缝隙，
          // 那才是真正把边缘拆成细条的做法。
          float fringe = smoothstep(0.3, 1.05, q);
          float turbulent = n * 0.75 + (0.5 - ridge) * uWisp * fringe;

          // ---- 4. 撕裂 --------------------------------------------------
          // 火焰的心脏几乎不受噪声触及，而边缘却被它撕碎。这种对比——坚实的燃烧核心、
          // 消散成飘絮的边缘——正是"火焰"感的主要来源。
          //
          // REACH_LO 之后的衰减不是为了好看：正是它限定了噪声能把密度推到名义管道之外
          // 多远。没有它，体积会远远超出代理外壳，火焰就会沿着一条明显笔直的边被切掉。
          // 连贯的燃烧核心属于头部。到尾迹远端时，气体已经整段飞行都在翻搅，再没有安静的
          // 轴心剩下，所以侵蚀下限会随年龄抬高。
          float shred = mix(mix(0.26, 1.0, age), 1.8 * uShred, smoothstep(0.06, 1.05, q))
                      * (1.0 - smoothstep(REACH_LO, REACH_HI, q));
          // 湍流在尾迹中*充分发展*，而在头部仍在成长：远端的气体有整段飞行的时间来破碎。
          // 没有这一点，尾巴就会成为体积中最平滑的部分，而一个平滑的场配上硬密度阈值做
          // 步进，会把自己的等值面渲染成一层层同心壳——火焰恰恰在最该显得混沌的地方戴上
          // 了一圈圈等高环。
          float erosion = uNoiseStrength * shred * (1.0 + 1.3 * age);
          float field = edge + turbulent * erosion;
          field -= uDetachment * age * 0.55;                  // 尾迹撕裂成团团烟团

          // 温度有它自己一套、刻意做得更钝的场，原因正是这个着色器里最不显而易见的一点。
          //
          // 辐射功率是温度的高次幂，所以无论什么在驱动温度，它的对比度在画面上都会被放大
          // 好几倍。用完整密度场去驱动它，那份放大就会落在湍流噪声的等值集上——它们是层层
          // 嵌套的闭合环——于是火焰看起来像打磨过的玛瑙：浓密平行的等高线缠住每一个团块。
          // 一旦见过就绝不会认错，而且从颜色端怎么调都调不掉。
          //
          // 所以对比度由胶囊衰减承载，即几何形状：轴上热、向外变冷、自身没有等值集。
          // 噪声只*位移*这个剖面——足以让一条舌状结构沿自己的脊线保持高温，又不足以把
          // 自己画出来。而且做这个位移的是两个最粗的倍频，因为与最小的湍流尺度相比，反应区
          // 是厚的。
          // 这里刻意不用密度所用的、随年龄放大的侵蚀：让尾迹额外的翻搅进入温度会让玛瑙
          // 立刻回来，而且只出现在尾部，那是最不希望它出现的地方。
          float heatField = edge + coarse * uHeatFollow * uNoiseStrength * shred
                          - uDetachment * age * 0.55;

          float d = smoothstep(0.0, clamp(uSoftness, 0.05, 1.0), field);
          if (d <= 0.0) return 0.0;

          d *= smoothstep(0.0, max(uTailFade, 0.01), u);
          d *= 1.0 - smoothstep(1.0 - uHeadFade, 1.0, u) * step(0.001, uHeadFade);

          // ---- 温度 ------------------------------------------------
          // 跟随的是*被扰动后*的形状，而不是到轴的距离，因此被大涡推向外侧的一条舌状
          // 结构会沿自己的脊线保持高温，并朝自己的尖端降温——这之间的差别，就是真正在
          // 燃烧的丝缕，与被人为涂到圆柱上的橙色丝缕之间的差别。若改为从密度读取，整个
          // 核心都会被钳到 1，火焰会被压平成单个白色团块。
          float interior = clamp(heatField * uHeatFocus, 0.0, 1.0);
          // 燃尽的燃气已经混合。它不再有灼热的轴心和冷却的表皮——整体大致是同一个温度，
          // 只是在变暗。随年龄把径向剖面压平，也正是防止细尾巴渲染成一摞嵌套环的关键：
          // 那里径向梯度最陡，因此那里等步长的温度靠得最近，而高次幂的辐射指数会把它们
          // 变成肉眼可见的条带。
          interior = mix(interior, 0.55, age * age * 0.65);
          // ……而且在头部之后，它也有时间把热量辐射掉。
          float cool = mix(uTailHeat, 1.0, pow(u, 0.55));
          heat = clamp(pow(interior, max(uHeatFalloff, 0.05)) * cool, 0.0, 1.0);

          // 靠近燃烧核心的冷气体被它的光照亮。
          bath = exp(-max(q - 0.5, 0.0) * uScatterFalloff) * (1.0 - heat);

          return d * uDensity;
        }

        void main() {
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorld - ro);

          // 外壳是一条穿过轴、朝向相机的带状面，所以每个像素恰好得到一个片元，而这个片元
          // 必须沿自己的射线步进整个体积。用球体做包围是显而易见的实现方式，在这里却会毁掉
          // 性能：火焰被拉伸到高是宽的两倍半，所以一个足以装下它的球，在几乎每条射线实际
          // 行进的方向上都会长出两倍半——固定的步数预算被摊在一块大部分是空的厚板上，
          // 体积的采样分辨率只剩应有的几分之一。
          //
          // 改用体积实际占据的*椭球*来做包围，只多花一个点积，就能把这个倍数直接换回成
          // 步进密度。做法是在压扁后的坐标系里按单位球来解。
          float reach = REACH_HI * (1.0 + uBulge);
          vec3 up = vec3(0.0, 1.0, 0.0) - vTangent * vTangent.y;
          float upLen = length(up);
          up = upLen > 1e-3 ? up / upLen : vec3(1.0, 0.0, 0.0);
          vec3 side = cross(vTangent, up);

          float rPerp = max(vRadius * reach, uRadius * 0.2);
          float rUp   = rPerp * max(uPlume, 1.0);
          float rDown = rPerp * (1.0 + (max(uPlume, 1.0) - 1.0) * 0.25);
          // 羽流只朝上拉伸，所以包围体是一个从轴上抬起的椭球，而不是以轴为中心的椭球。
          float rVert = (rUp + rDown) * 0.5;
          vec3 origin = vCenter + up * (rUp - rDown) * 0.5;
          // 顺着流的方向看过去，射线在整个长度上都留在体积内部；从侧面看，它穿过一个直径
          // 就出去了。
          float axial = abs(dot(rd, vTangent));
          float rLong = mix(rPerp, max(uStreamLength * 0.6, rPerp), axial * axial);

          vec3 o = ro - origin;
          vec3 eo = vec3(dot(o, side) / rPerp, dot(o, up) / rVert, dot(o, vTangent) / rLong);
          vec3 ed = vec3(dot(rd, side) / rPerp, dot(rd, up) / rVert, dot(rd, vTangent) / rLong);
          float ea = dot(ed, ed);
          float eb = dot(eo, ed);
          float ec = dot(eo, eo) - 1.0;
          float disc = eb * eb - ea * ec;
          if (disc <= 0.0) discard;
          float esq = sqrt(disc);
          float maxRadius = rPerp;
          float t0 = max((-eb - esq) / ea, 0.02);
          float t1 = (-eb + esq) / ea;

          // 用不透明场景裁剪步进：免费得到由地面和角色产生的正确遮挡。
          float dzdt = (viewMatrix * vec4(rd, 0.0)).z;
          float packed = unpackRGBAToDepth(texture2D(uSceneDepth, gl_FragCoord.xy / uResolution));
          float sceneViewZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
          float tScene = dzdt < -1e-5 ? sceneViewZ / dzdt : 1e6;
          t1 = min(t1, tScene);
          if (t1 <= t0) discard;

          float steps = clamp(uSteps, 6.0, 72.0);
          float baseStep = (t1 - t0) / steps;
          // 对入点做抖动：固定的起点会把切片变成看得见的洋葱圈，逐像素偏移则把它们变成
          // 会被泛光吞掉的颗粒。
          float t = t0 + baseStep * hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));

          // 整条射线共用一个闪烁值——火焰是作为一个整体变亮变暗，而不是逐采样变化。
          // 两个频率：来自气体主体的缓慢起伏，以及来自燃烧本身的快速颤动。
          // 振幅刻意取得克制并做了钳制。它乘的是整条射线，所以幅度大到纸面上看着有戏剧性
          // 时，在画面上会表现为火球一帧一帧地熄灭。
          float flickN = vnoise(vec3(uTime * 5.3, uSeed, 0.0)) * 0.7
                       + vnoise(vec3(uTime * 13.1, uSeed * 2.0, 5.0)) * 0.3;
          float flick = clamp(1.0 + uFlicker * 0.6 * (flickN * 2.0 - 1.0), 0.4, 1.7);

          vec3 acc = vec3(0.0);
          float transmittance = 1.0;
          // 外壳必须足够宽，好让噪声把体积推满它的全部范围，这就让大多数射线穿过大量空处。
          // 用更粗的步幅滑过这些空处——一旦碰到任何东西就立刻退回细步幅——能把那份余量的
          // 开销换回来，又不会在真正重要的地方把采样变稀。
          float stride = 1.0;

          for (int i = 0; i < 72; i++) {
            if (t >= t1 || transmittance < 0.012) break;

            float heat, bath;
            float d = flameSample(ro + rd * t, heat, bath);
            float stepSize = baseStep * stride;

            if (d > 0.002) {
              stride = 1.0;
              stepSize = baseStep;
              // 柔化与步进所撞上的东西之间的接触。
              d *= clamp((tScene - t) / max(maxRadius * 0.6, 1e-3), 0.0, 1.0);

              float kelvin = mix(uTempEdge, uTempCore, heat);
              // 调色板混合让编辑器的四个颜色停靠点仍然有意义，又不让它们与物理打架：
              // 取 0 时火焰是纯粹的辐射体，取 1 时它是手工编排的渐变。
              vec3 artistic = gradient4(uColorCore, uColorMid, uColorEdge, uColorSmoke,
                                        pow(1.0 - heat, 0.85));
              vec3 tint = mix(blackbody(kelvin), artistic, clamp(uPalette, 0.0, 1.0));

              // Stefan-Boltzmann。就靠这一个指数，体积才拥有极大的内部动态范围：
              // 白热的核比它外侧两厘米处的红色气体亮四十倍。
              float power = pow(kelvin / max(uTempCore, 1.0), uEmissionCurve);
              vec3 emission = tint * power;

              // 单次散射：包裹在燃烧周围的烟熏气体本身不辐射，它反射。没有这一项，
              // 边缘和烟熏的下侧会塌成一片死黑，火焰也就失去了位于它与烟之间的那圈光晕。
              emission += mix(uColorEdge, uColorMid, bath) * uScatter * bath * bath * 0.06;

              acc += emission * uEmission * flick * d * transmittance * stepSize;

              // 烟尘消光：冷边缘把背景遮得很硬，即便热气体也保有足够的烟尘来遮挡自己的
              // 远侧，这才让火球内部留下可见的结构，而不是积成一个白色的圆盘。
              // 取平方，所以只有真正白热的气体才会变透明。让烟尘随温度线性淡出，也会把
              // 近侧只是温热的气体削薄，而正是那层气体在真实火球的明亮内部画出暗色丝缕。
              transmittance *= exp(-d * uSoot * mix(1.0, uCoreClarity, heat * heat) * stepSize);
            } else {
              stride = min(stride * 1.6, 2.2);
            }

            t += stepSize;
          }

          float alpha = clamp((1.0 - transmittance) * uOpacity, 0.0, 1.0);
          vec3 color = acc * uOpacity * uGlobalGlow * mix(0.65, 1.0, uShaderIntensity);
          if (alpha < 0.002 && max(color.r, max(color.g, color.b)) < 0.002) discard;

          gl_FragColor = vec4(color, alpha);
        }
      `,
        });
    }

    /**
     * 拉取编辑器里的实时数值（由 ability 每帧调用一次）。
     *
     * 这里刻意不碰 `uRadius`、`uStreamLength`、`uArcLength` 和 `uTailPad`：它们描述的是
     * ability 刚刚构建好的外壳，紧接着就由它写入。
     */
    sync() {
        const c = settings.meteor;
        const g = settings.global;
        const u = this.uniforms;

        u.uRadius.value = c.trailWidth;
        u.uHeadSize.value = c.trailHeadSize;
        u.uPlume.value = c.trailPlume;
        u.uWakeSpread.value = c.trailWakeSpread;
        u.uDetachment.value = c.trailDetachment;
        u.uSoftness.value = c.trailSoftness;
        u.uShred.value = c.trailShred;
        u.uBulge.value = c.trailBulge;
        u.uBulgeScale.value = c.trailBulgeScale;

        u.uFlow.value = c.trailSpeed * g.noiseSpeed;
        u.uBuoyancy.value = c.trailBuoyancy * g.noiseSpeed;
        u.uSwirl.value = c.trailCurl * g.turbulence;
        u.uSwirlSpeed.value = c.trailSpeed * 0.35 * g.noiseSpeed;
        u.uVortex.value = c.trailVortex * g.turbulence;
        u.uRingFreq.value = c.trailRingFrequency;
        u.uRingSpeed.value = c.trailRingSpeed * g.noiseSpeed;
        u.uNoiseFrequency.value = c.trailNoiseFrequency * g.noiseFrequency;
        u.uNoiseStrength.value = 0.28 * c.trailTurbulence * c.trailNoiseStrength * g.turbulence * g.noiseStrength;
        u.uWarp.value = c.trailWarp * g.turbulence;
        u.uTongue.value = c.trailTongue;
        u.uStreamStretch.value = c.trailStreamStretch;
        u.uWisp.value = c.trailWisps;
        u.uFlicker.value = c.trailFlicker;
        u.uLick.value = c.trailLick;
        u.uOctaves.value = c.trailOctaves;

        u.uTempCore.value = c.trailTempCore;
        u.uTempEdge.value = c.trailTempEdge;
        u.uEmissionCurve.value = c.trailEmissionCurve;
        u.uHeatFocus.value = c.trailHeatFocus;
        u.uHeatFalloff.value = c.trailHeatFalloff;
        u.uHeatFollow.value = c.trailHeatFollow;
        u.uTailHeat.value = c.trailTailHeat;
        u.uPalette.value = c.trailPalette;
        u.uScatter.value = c.trailScatter;
        u.uScatterFalloff.value = c.trailScatterFalloff;

        u.uDensity.value = c.trailDensity;
        u.uSoot.value = c.trailSoot;
        u.uCoreClarity.value = c.trailCoreClarity;
        u.uEmission.value = c.trailGlow * 2.4;
        u.uOpacity.value = c.trailOpacity * g.opacity;
        u.uSteps.value = c.trailSteps;
        u.uTailFade.value = c.trailTailFade;

        // 这套调色板与岩石的裂缝和引爆共享，所以拖动某个颜色时，整个 ability 仍保持在同一个
        // 温度区间。
        u.uColorCore.value.copy(getColor(c.colorHot));
        u.uColorMid.value.copy(getColor(c.colorFlameMid));
        u.uColorEdge.value.copy(getColor(c.colorFlameEdge));
        u.uColorSmoke.value.copy(getColor(c.colorFlameSmoke));
    }
}
