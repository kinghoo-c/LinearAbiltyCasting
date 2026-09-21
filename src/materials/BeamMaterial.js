import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * 光束绘制所经过的六个 pass。
 *
 * 前三个是同一根管子在三个半径下的渲染——正是这个叠加构成了整个外观的
 * 诀窍所在，值得明确说明原因：
 *
 *   HALO  —— 最宽，只有轮廓光一项。光束在推进时所推开的那层氛围。
 *   SHELL —— 鞘层：按轮廓加权，因此读作*中空*，其剪影边缘是它身上
 *           最亮的部分。
 *   CORE  —— 窄，且权重方式相反：视线沿炮管方向、穿过管子的路径最
 *           长处最亮。正是这一点让中段读作一根实心的白色杆，而不是
 *           一根只有描亮轮廓的圆柱。
 *
 * 外侧按轮廓加权、内侧按轴向加权、双面相加：这就是一个廉价的体积积
 * 分。随后 COIL 和 RING 在它*之上*叠加结构，而 ORB 是坐在施法者掌心
 * 里的那团蓄能。
 */
export const BeamPass = Object.freeze({
    CORE: 0, // 白热化的杆芯
    SHELL: 1, // 包裹其外的鞘层
    HALO: 2, // 宽而外的辉光
    COIL: 3, // 绕柱螺旋的缎带
    RING: 4, // 沿射程疾冲的冲击环
    ORB: 5, // 施法者掌心中的蓄能体
});

const BEAM_UNIFORMS = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uFade;
  uniform float uWidthFade;
  uniform float uCharge;

  uniform float uRadius;
  uniform float uRadiusNear;
  uniform float uRadiusCurve;
  uniform float uRadiusScale;
  uniform float uFlare;
  uniform float uFlareWidth;
  uniform float uThrob;
  uniform float uThrobScale;
  uniform float uThrobSpeed;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;

  uniform float uRipple;
  uniform float uRippleBands;
  uniform float uRippleScale;
  uniform float uRippleSpeed;

  uniform float uStreak;
  uniform float uStreakSharp;
  uniform float uStreakScale;
  uniform float uStreakBands;
  uniform float uStreakGlow;
  uniform float uFlowSpeed;

  uniform float uCoreSharp;
  uniform float uCoreFill;
  uniform float uEdgePower;
  uniform float uShellRim;
  uniform float uShellFill;
  uniform float uHaloRim;
  uniform float uPassOpacity;

  uniform float uMouthGlow;
  uniform float uMouthLength;
  uniform float uTipGlow;
  uniform float uTipLength;

  uniform float uCoils;
  uniform float uCoilTurns;
  uniform float uCoilSpeed;
  uniform float uCoilRadius;
  uniform float uCoilFlare;
  uniform float uCoilWidth;
  uniform float uCoilWidthTip;
  uniform float uCoilSharp;
  uniform float uCoilPulse;
  uniform float uCoilPulseFreq;
  uniform float uCoilPulseSpeed;

  uniform float uRingCount;
  uniform float uRingSpeed;
  uniform float uRingInner;
  uniform float uRingOuter;
  uniform float uRingSwell;
  uniform float uRingFade;
  uniform float uRingSharp;

  uniform float uOrbTurbulence;
  uniform float uOrbScale;
  uniform float uOrbFlow;
  uniform float uOrbBands;
  uniform float uOrbRim;

  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;
  uniform vec3  uColorCoil;
  uniform vec3  uColorCoilEdge;
  uniform vec3  uColorRing;
`;

/**
 * 逐 pass 守卫的 varying。
 *
 * 两个着色阶段共用这段代码块，因此每个 pass 只声明它实际用到的插值
 * 变量。此处上限为五个，让整个家族在低配端也稳稳处于 varying 预算之内。
 */
const BEAM_VARYINGS = /* glsl */ `
  varying float vT;
  varying float vViewZ;

  #if BEAM_PASS <= 2
    varying float vA;
    varying float vFacing;
  #elif BEAM_PASS == 3
    varying float vSide;
  #elif BEAM_PASS == 4
    varying float vBand;
    varying float vPhase;
  #else
    varying vec3  vNormalW;
    varying vec3  vViewDir;
    varying float vDisp;
  #endif
`;

/**
 * 光束的形状，由位于柱体上的每个 pass 共用。
 *
 * `beamRadius` 和 `beamAxis` 就是全部几何：管身、螺旋缎带和冲击环都是
 * 贴着这两个函数来定位自身的，这也是为什么拖动 `radius` 或 `flare` 时
 * 它们彼此仍然咬合。不做任何缓存——逐顶点、逐帧求值。
 */
const BEAM_SHAPE = /* glsl */ `
  /** t 处柱体的半宽，单位米。 */
  float beamRadius(float t) {
    float u = clamp(t, 0.0, 1.0);
    float r = mix(uRadiusNear, uRadius, pow(u, max(uRadiusCurve, 0.01)));
    // 沿柱体向外传播的压强波。幅度很小——这是光束在呼吸，
    // 而不是一根香肠。
    r *= 1.0 + uThrob * sin((u * uThrobScale - uTime * uThrobSpeed) * TAU);
    // ……以及落到目标处张开的锥形。
    r *= 1.0 + uFlare * smoothstep(1.0 - max(uFlareWidth, 1e-3), 1.0, u);
    return max(r * uRadiusScale * uWidthFade, 1e-4);
  }

  /** 柱体的局部坐标架。n1/n2 张成其横截平面。 */
  void beamFrame(out vec3 dir, out vec3 n1, out vec3 n2) {
    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    dir = delta / span;
    // Gram-Schmidt：轴从手部斜向下倾，因此 uSide 只与它近似垂直。
    vec3 lateral = uSide - dir * dot(uSide, dir);
    n1 = length(lateral) > 1e-4 ? normalize(lateral) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    n2 = normalize(cross(dir, n1));
  }

  /**
   * t 处柱体轴线上的一点。
   *
   * 平滑的低频漂移，两端钉死。刻意保持*平滑*：闪电（bolt）的魅力在于
   * 它的噪声是分段线性的、保留着棱角，而这里要的是相反的效果——光束
   * 一旦打结就不再是光束而是闪电了。
   */
  vec3 beamAxis(float t, vec3 n1, vec3 n2) {
    vec3 p = mix(uOrigin, uTarget, t);
    float ends = sin(clamp(t, 0.0, 1.0) * PI);
    float dx = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, uSeed));
    float dy = snoise(vec3(t * uWanderScale + 31.7, uTime * uWanderSpeed, uSeed + 7.3));
    return p + (n1 * dx + n2 * dy) * uWander * ends;
  }
`;

const BEAM_VERTEX = /* glsl */ `
  ${BEAM_UNIFORMS}
  ${BEAM_VARYINGS}

  #if BEAM_PASS == 3
    attribute float aStrand;
  #endif
  #if BEAM_PASS == 4
    attribute float aRing;
  #endif

  ${noiseGLSL}
  ${BEAM_SHAPE}

  #if BEAM_PASS == 3
    /** 螺旋缎带上的一点。 */
    vec3 coilPoint(float t, float phase, vec3 n1, vec3 n2) {
      float angle = (t * uCoilTurns + uTime * uCoilSpeed + phase) * TAU;
      float r = beamRadius(t) * uCoilRadius * (1.0 + uCoilFlare * pow(clamp(t, 0.0, 1.0), 3.0));
      return beamAxis(t, n1, n2) + (n1 * cos(angle) + n2 * sin(angle)) * r;
    }
  #endif

  void main() {
    vec3 dir, n1, n2;

    #if BEAM_PASS != 5
      beamFrame(dir, n1, n2);
    #endif

    #if BEAM_PASS <= 2                                    /* 柱体 */
      float t = position.x;
      float a = position.y;
      float angle = a * TAU;
      vec3 nrm = n1 * cos(angle) + n2 * sin(angle);

      // 打散管壁，让它是一根气柱而不是一根机加工管子。噪声随着气流
      // 向下爬，而不是静止不动地贴在管上。
      float rip = snoise(vec3(
        cos(angle) * uRippleBands,
        sin(angle) * uRippleBands,
        t * uRippleScale - uTime * uRippleSpeed + uSeed
      ));
      float r = beamRadius(t) * (1.0 + uRipple * rip);

      vec3 here = beamAxis(t, n1, n2) + nrm * r;
      vT = t;
      vA = a;
      // 1 表示正对炮管方向，0 位于剪影处。管身的两种加权方式都是
      // 由这一个数构造出来的。
      vFacing = abs(dot(normalize(cameraPosition - here), nrm));

    #elif BEAM_PASS == 3                                  /* 螺旋缎带 */
      float t = position.x;
      vSide = position.y;
      vT = t;

      float phase = uCoils <= 1.0 ? 0.0 : aStrand / uCoils;
      phase += hash11(aStrand * 5.31 + uSeed) * 0.12;

      vec3 here = coilPoint(t, phase, n1, n2);

      // 用有限差分求切线，并在远端镜像，好让最后一个节点仍然有
      // 邻居可看。
      float step_ = 0.015;
      float ahead = t + step_;
      float flip = 1.0;
      if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
      vec3 tangent = (coilPoint(ahead, phase, n1, n2) - here) * flip;
      tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

      vec3 binormal = cross(tangent, normalize(cameraPosition - here));
      float bl = length(binormal);
      binormal = bl > 1e-4 ? binormal / bl : n1;

      float halfWidth = uCoilWidth * mix(1.0, uCoilWidthTip, clamp(t, 0.0, 1.0));
      // 在炮口处收成尖点，让缎带像是从蓄能球里长出来的。
      halfWidth *= smoothstep(0.0, 0.05, t) * uWidthFade * uFade;
      here += binormal * position.y * halfWidth;

    #elif BEAM_PASS == 4                                  /* 冲击环 */
      // 沿柱体均匀排布，由时钟推着向前滑动，因此这一串环是时间的
      // 纯函数——CPU 上没有队列。
      float phase = fract(aRing / max(uRingCount, 1.0) + uTime * uRingSpeed + uSeed * 0.37);
      float t = phase;
      float angle = position.y * TAU;
      float r = beamRadius(t) * mix(uRingInner, uRingOuter, position.x) * (1.0 + uRingSwell * phase);

      vec3 here = beamAxis(t, n1, n2) + (n1 * cos(angle) + n2 * sin(angle)) * r;
      vT = t;
      vBand = position.x;
      vPhase = phase;

    #else                                                 /* 蓄能球 */
      // 唯一一个走模型矩阵的 pass：技能本身负责放置和缩放蓄能球，
      // 所以它不需要自己的世界空间管线。
      vec3 np = normal * uOrbScale + vec3(uSeed * 3.1) - vec3(0.0, uTime * uOrbFlow, 0.0);
      float n = fbm4(np) * 0.6 + ridged(np * 1.4, 4) * 0.4;
      vDisp = n;

      vec4 world = modelMatrix * vec4(position + normal * n * uOrbTurbulence, 1.0);
      vec3 here = world.xyz;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vViewDir = cameraPosition - here;
      vT = 0.0;
    #endif

    vec4 mv = viewMatrix * vec4(here, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  ${BEAM_UNIFORMS}
  ${BEAM_VARYINGS}

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 color = vec3(0.0);
    float alpha = 0.0;

    #if BEAM_PASS == 5                                    /* 蓄能球 */
      float facing = abs(dot(normalize(vViewDir), normalize(vNormalW)));
      float rim = pow(1.0 - facing, max(uOrbRim, 0.05));
      float heat = clamp(vDisp * 0.5 + 0.5, 0.0, 1.0);
      // 爬过表面的细丝，硬阈值：这里用宽频带会把球体填满，
      // 它就失去"受约束的能量"的观感了。
      float fil = smoothstep(0.74, 0.98,
        ridged(vNormalW * uOrbBands + vec3(0.0, uTime * uOrbFlow * 2.0, 0.0) + uSeed, 4));

      color = mix(uColorOuter, uColorInner, heat);
      color = mix(color, uColorCore, clamp(fil + rim * 0.35, 0.0, 1.0));
      color += uColorCore * fil * 1.6;
      alpha = (0.2 + rim * 0.9 + fil * 0.75) * uCharge;

    #else
      // 前缘之前还没有光束。这根柱体是整体构建、在这里被裁切的，而不是
      // 被缩放的，所以锋面行进时它的*形状*永远不变——变的只是它存在多少。
      float tip = max(uTipLength, 1e-3);
      float drawn = smoothstep(uProgress, uProgress - tip, vT);
      if (drawn <= 0.002) discard;

      #if BEAM_PASS <= 2                                  /* 柱体 */
        float angle = vA * TAU;
        // 顺射程方向奔流的细丝，沿轴被狠狠拉伸：这是被推过炮管的气体，
        // 而不是一道在找地面落点的闪电。
        float flow = ridged(vec3(
          vT * uStreakScale - uTime * uFlowSpeed,
          cos(angle) * uStreakBands,
          sin(angle) * uStreakBands + uSeed
        ), 4);
        float streak = smoothstep(mix(0.42, 0.86, clamp(uStreakSharp, 0.0, 1.0)), 0.99, flow) * uStreak;

        float facing = clamp(vFacing, 0.0, 1.0);
        float axisward = pow(facing, max(uCoreSharp, 0.05));
        float rim = pow(1.0 - facing, max(uEdgePower, 0.05));

        #if BEAM_PASS == 0                                /* 杆芯 */
          color = mix(uColorInner, uColorCore, clamp(0.35 + streak, 0.0, 1.0));
          alpha = uCoreFill * mix(0.28, 1.0, axisward) + streak * 0.35;

        #elif BEAM_PASS == 1                              /* 鞘层 */
          color = mix(uColorOuter, uColorInner, clamp(rim * 0.55 + streak, 0.0, 1.0));
          color += uColorCore * streak * uStreakGlow;
          alpha = rim * uShellRim + uShellFill * mix(0.12, 1.0, axisward) + streak * 0.4;

        #else                                             /* 辉光 */
          float wide = pow(1.0 - facing, max(uHaloRim, 0.05));
          color = mix(uColorHalo, uColorOuter, wide);
          alpha = wide;
        #endif

        // 炮口，柱体仍然从蓄能球里被输送出来的地方。
        float mouth = smoothstep(uMouthLength, 0.0, vT);
        color += uColorCore * mouth * uMouthGlow;
        alpha += mouth * uMouthGlow * 0.2;

        // 行进途中的前缘——以及它落地之后，仍在往地面里烧的那个白热的
        // 末端。
        float lead = smoothstep(uProgress - tip * 2.0, uProgress, vT);
        color += uColorCore * lead * uTipGlow;
        alpha += lead * uTipGlow * 0.18;

      #elif BEAM_PASS == 3                                /* 螺旋缎带 */
        float v = clamp(abs(vSide), 0.0, 1.0);
        float profile = pow(1.0 - v, max(uCoilSharp, 0.05));
        // 一道沿缎带向外跑的电脉冲，正是它让这些螺旋不会读作缠在光束上的
        // 静止管路。
        float pulse = 0.5 + 0.5 * sin((vT * uCoilPulseFreq - uTime * uCoilPulseSpeed) * TAU);
        color = mix(uColorCoilEdge, uColorCoil, profile);
        color += uColorCore * pulse * profile * uCoilPulse;
        alpha = profile * mix(1.0 - clamp(uCoilPulse, 0.0, 0.9) * 0.5, 1.0, pulse);

      #else                                               /* 冲击环 */
        float band = 1.0 - abs(vBand * 2.0 - 1.0);
        float profile = pow(clamp(band, 0.0, 1.0), max(uRingSharp, 0.05));
        // 盘体朝射程远端跑的过程中逐渐变薄，因为它们背后的压力在下降。
        color = mix(uColorRing, uColorCore, profile);
        alpha = profile * mix(1.0, uRingFade, vPhase);
      #endif

      alpha *= drawn;
    #endif

    alpha *= uFade * uOpacity * uPassOpacity;
    if (alpha < 0.003) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * 光束的单个 pass。
 *
 * 每个 pass 共用同一份 uniform 块和同一个 `userData.sync()`，所以技能把同一个
 * 状态对象交给全部六个，编辑器也会一起驱动它们。不同的地方在于编译期的
 * `BEAM_PASS`，以及该 pass 自己持有的两个 uniform：`uRadiusScale`（它是三根
 * 管半径中的哪一个）和 `uPassOpacity`。
 *
 * @param {number} pass BeamPass.*
 */
export function createBeamMaterial(pass = BeamPass.CORE) {
    const material = new ShaderMaterial({
        defines: { BEAM_PASS: pass },
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
            uSeed: { value: 0 },
            uProgress: { value: 0 },
            uFade: { value: 1 },
            uWidthFade: { value: 1 },
            uCharge: { value: 0 },

            uRadius: { value: 0.62 },
            uRadiusNear: { value: 0.22 },
            uRadiusCurve: { value: 0.7 },
            uRadiusScale: { value: 1 },
            uFlare: { value: 0.9 },
            uFlareWidth: { value: 0.22 },
            uThrob: { value: 0.06 },
            uThrobScale: { value: 2.4 },
            uThrobSpeed: { value: 1.6 },
            uWander: { value: 0.06 },
            uWanderScale: { value: 0.9 },
            uWanderSpeed: { value: 0.7 },

            uRipple: { value: 0.12 },
            uRippleBands: { value: 1.6 },
            uRippleScale: { value: 3.2 },
            uRippleSpeed: { value: 2.4 },

            uStreak: { value: 0.9 },
            uStreakSharp: { value: 0.45 },
            uStreakScale: { value: 5.5 },
            uStreakBands: { value: 2.6 },
            uStreakGlow: { value: 1.1 },
            uFlowSpeed: { value: 7 },

            uCoreSharp: { value: 1.4 },
            uCoreFill: { value: 0.85 },
            uEdgePower: { value: 2.2 },
            uShellRim: { value: 0.9 },
            uShellFill: { value: 0.18 },
            uHaloRim: { value: 3.4 },
            uPassOpacity: { value: 1 },

            uMouthGlow: { value: 1.5 },
            uMouthLength: { value: 0.1 },
            uTipGlow: { value: 1.6 },
            uTipLength: { value: 0.06 },

            uCoils: { value: 4 },
            uCoilTurns: { value: 2.2 },
            uCoilSpeed: { value: 0.9 },
            uCoilRadius: { value: 1.35 },
            uCoilFlare: { value: 0.8 },
            uCoilWidth: { value: 0.1 },
            uCoilWidthTip: { value: 1.8 },
            uCoilSharp: { value: 2.2 },
            uCoilPulse: { value: 0.6 },
            uCoilPulseFreq: { value: 3 },
            uCoilPulseSpeed: { value: 1.6 },

            uRingCount: { value: 6 },
            uRingSpeed: { value: 1.3 },
            uRingInner: { value: 1.15 },
            uRingOuter: { value: 2.1 },
            uRingSwell: { value: 0.5 },
            uRingFade: { value: 0.15 },
            uRingSharp: { value: 1.6 },

            uOrbTurbulence: { value: 0.22 },
            uOrbScale: { value: 2.2 },
            uOrbFlow: { value: 0.8 },
            uOrbBands: { value: 5 },
            uOrbRim: { value: 1.8 },

            uOpacity: { value: 1 },
            uGlow: { value: 2.2 },
            uSoftFade: { value: 0.6 },
            uColorCore: { value: new Color(1, 1, 1) },
            uColorInner: { value: new Color(0.82, 0.96, 1) },
            uColorOuter: { value: new Color(0.29, 0.78, 1) },
            uColorHalo: { value: new Color(0.05, 0.2, 0.85) },
            uColorCoil: { value: new Color(1, 0.86, 0.5) },
            uColorCoilEdge: { value: new Color(1, 0.45, 0.12) },
            uColorRing: { value: new Color(0.6, 0.94, 1) },
        }),
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
    });

    /**
     * 把实时 settings 与当前施放状态推进 uniform。
     *
     * 每帧调用——包括沙盒暂停时的零长度帧，正是这一点让下面每一项控制都还是
     * 活滑杆。
     *
     * @param {object} state { origin, target, side, progress, fade, widthFade,
     *                         charge, seed, coils, rings }
     */
    material.userData.sync = (state) => {
        const c = settings.beam;
        const g = settings.global;
        const u = material.uniforms;

        u.uOrigin.value.copy(state.origin);
        u.uTarget.value.copy(state.target);
        u.uSide.value.copy(state.side);
        u.uSeed.value = state.seed;
        u.uProgress.value = state.progress;
        u.uFade.value = state.fade;
        u.uWidthFade.value = state.widthFade;
        u.uCharge.value = state.charge;

        u.uRadius.value = c.radius;
        u.uRadiusNear.value = c.radiusNear;
        u.uRadiusCurve.value = c.radiusCurve;
        u.uFlare.value = c.flare;
        u.uFlareWidth.value = c.flareWidth;
        u.uThrob.value = c.throb;
        u.uThrobScale.value = c.throbScale;
        u.uThrobSpeed.value = c.throbSpeed * g.animationSpeed;
        // 漂移是 `randomness` 和各项噪声倍率唯一有东西可咬的地方，所以它们在
        // 这里缩放，而不是到处都缩放。
        u.uWander.value = c.wander * g.randomness * g.noiseStrength;
        u.uWanderScale.value = c.wanderScale * g.noiseFrequency;
        u.uWanderSpeed.value = c.wanderSpeed * g.noiseSpeed;

        u.uRipple.value = c.ripple * g.noiseStrength;
        u.uRippleBands.value = c.rippleBands;
        u.uRippleScale.value = c.rippleScale * g.noiseFrequency;
        u.uRippleSpeed.value = c.rippleSpeed * g.noiseSpeed;

        u.uStreak.value = c.streak;
        u.uStreakSharp.value = c.streakSharp;
        u.uStreakScale.value = c.streakScale * g.noiseFrequency;
        u.uStreakBands.value = c.streakBands;
        u.uStreakGlow.value = c.streakGlow;
        u.uFlowSpeed.value = c.flowSpeed * g.noiseSpeed;

        u.uCoreSharp.value = c.coreSharp;
        u.uCoreFill.value = c.coreFill;
        u.uEdgePower.value = c.edgePower;
        u.uShellRim.value = c.shellRim;
        u.uShellFill.value = c.shellFill;
        u.uHaloRim.value = c.haloRim;

        u.uMouthGlow.value = c.mouthGlow;
        u.uMouthLength.value = c.mouthLength;
        u.uTipGlow.value = c.tipGlow;
        u.uTipLength.value = c.tipLength;

        u.uCoils.value = state.coils;
        u.uCoilTurns.value = c.coilTurns;
        u.uCoilSpeed.value = c.coilSpeed;
        u.uCoilRadius.value = c.coilRadius;
        u.uCoilFlare.value = c.coilFlare;
        u.uCoilWidth.value = c.coilWidth;
        u.uCoilWidthTip.value = c.coilWidthTip;
        u.uCoilSharp.value = c.coilSharp;
        u.uCoilPulse.value = c.coilPulse;
        u.uCoilPulseFreq.value = c.coilPulseFreq;
        u.uCoilPulseSpeed.value = c.coilPulseSpeed;

        u.uRingCount.value = state.rings;
        u.uRingSpeed.value = c.ringSpeed;
        u.uRingInner.value = c.ringInner;
        u.uRingOuter.value = c.ringOuter;
        u.uRingSwell.value = c.ringSwell;
        u.uRingFade.value = c.ringFade;
        u.uRingSharp.value = c.ringSharp;

        u.uOrbTurbulence.value = c.orbTurbulence * g.turbulence;
        u.uOrbScale.value = c.orbScale;
        u.uOrbFlow.value = c.orbFlow * g.noiseSpeed;
        u.uOrbBands.value = c.orbBands;
        u.uOrbRim.value = c.orbRim;

        // 这个 pass 是三根管半径中的哪一个，以及它被画得多重。
        switch (pass) {
            case BeamPass.CORE:
                u.uRadiusScale.value = c.coreWidth;
                u.uPassOpacity.value = 1;
                u.uGlow.value = c.glow;
                break;
            case BeamPass.SHELL:
                u.uRadiusScale.value = c.shellWidth;
                u.uPassOpacity.value = c.shellOpacity;
                u.uGlow.value = c.glow;
                break;
            case BeamPass.HALO:
                u.uRadiusScale.value = c.haloWidth;
                u.uPassOpacity.value = c.haloOpacity;
                u.uGlow.value = c.glow * 0.8;
                break;
            case BeamPass.COIL:
                u.uRadiusScale.value = 1;
                u.uPassOpacity.value = c.coilOpacity;
                u.uGlow.value = c.coilGlow;
                break;
            case BeamPass.RING:
                u.uRadiusScale.value = 1;
                u.uPassOpacity.value = c.ringOpacity;
                u.uGlow.value = c.ringGlow;
                break;
            default:
                u.uRadiusScale.value = 1;
                u.uPassOpacity.value = c.orbOpacity;
                u.uGlow.value = c.orbGlow;
                break;
        }

        u.uOpacity.value = c.opacity * g.opacity;
        u.uSoftFade.value = c.softFade;
        u.uColorCore.value.copy(getColor(c.colorCore));
        u.uColorInner.value.copy(getColor(c.colorInner));
        u.uColorOuter.value.copy(getColor(c.colorOuter));
        u.uColorHalo.value.copy(getColor(c.colorHalo));
        u.uColorCoil.value.copy(getColor(c.colorCoil));
        u.uColorCoilEdge.value.copy(getColor(c.colorCoilEdge));
        u.uColorRing.value.copy(getColor(c.colorRing));
    };

    return material;
}
