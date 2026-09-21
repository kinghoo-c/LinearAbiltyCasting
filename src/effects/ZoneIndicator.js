import { Group, Mesh, PlaneGeometry, ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing } from '../utils/math.js';

const ZONE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 足迹：一个在 **米** 空间里求值的符号距离圆环。
 *
 * `vUv` 被重新映射，使 `p` 成为相对目标点的世界米偏移，其中 `p.y` 沿瞄准
 * 方向延伸——这个四边形带着施放者的偏航角，所以长的那根准星臂指向正前方
 * （downrange）。因此 `settings.zone` 里的每一项控制都是一个真实测量值：
 * 无论足迹宽 2 m 还是 8 m，边界都保持 0.34 m 厚，这正是要把它画出来的全部
 * 意义。
 *
 * 色带（band）由 `uBias` 相对名义半径拆分，而不是以它为中心，因为玩家在
 * 判断的那个数字是 *效果的边缘究竟在哪*——把色带向内生长，能让它的外唇
 * 保持诚实。
 */
const ZONE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;     // 四边形覆盖的米数，边到边
  uniform float uRadius;       // 足迹半径，米（已完成吸附处理）
  uniform float uBoundary;     // 色带的厚度
  uniform float uBias;         // 这份厚度中有多少位于 uRadius 之外
  uniform float uBoundaryGlow;
  uniform float uLiner;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uRings;
  uniform float uRingWidth;
  uniform float uRingSpeed;
  uniform float uCrawl;
  uniform float uCrawlScale;
  uniform float uCrawlSpeed;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uTicks;
  uniform float uTickLength;
  uniform float uTickWidth;
  uniform float uTickSpin;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uCrosshair;
  uniform float uCrosshairLength;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uReveal;       // 0..1 弹出（snap-out）
  uniform float uInvalid;      // 目标位于最小射程之内（即无效）时为 1
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → 米，从目标点起量；+y 为正前方 ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * uBias;
    float inner = max(0.01, uRadius - uBoundary * (1.0 - uBias));

    float aa = fwidth(d) + uSoftness;
    if (d > outer + aa * 3.0) discard;

    /* ---- 那条 *就是* 足迹本身的色带 ---- */
    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    // 内唇上的一道硬边线：单靠色带远看偏软，而内唇正是玩家实际用来比量的
    // 那条线。
    float liner = 1.0 - smoothstep(uLiner, uLiner + aa, abs(d - inner));

    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    /* ---- 它内部的涂染 ---- */
    // 权重压在边缘：一个均匀的圆盘读起来像贴在地板上的贴花，而边缘加权的
    // 圆盘读起来像一个立在边界内部的体积。
    float wash = pow(radial, uFillFalloff);
    float n = fbm3(vec3(p * uNoiseScale, uTime * 0.2)) * 0.5 + 0.5;
    wash *= mix(1.0, n, uNoise);

    // 向外行进的等高线圆环——这种观感说的是"这是一片有尺寸的场"，而不是一摊水。
    float ringPhase = radial * uRings - uTime * uRingSpeed;
    float ring = smoothstep(1.0 - uRingWidth, 1.0, 0.5 + 0.5 * cos(ringPhase * TAU));

    // 在内部爬行的丝状纹路，在 *平面* 里采样并做域扭曲。若在 atan() 上采样，
    // 沿某个方位角的每个半径都会拿到同一个值，画出笔直的辐条——那是烟花，
    // 不是场。
    float warp = fbm3(vec3(p * 0.4, uTime * 0.15 + 3.1)) * 0.6;
    float fil = ridged(vec3(p * uCrawlScale + warp, uTime * uCrawlSpeed), 4);
    float veins = smoothstep(0.68, 0.95, fil);

    wash += ring * 0.4;
    wash += veins * uCrawl * (0.3 + 0.7 * radial);

    /* ---- 附加装饰 ---- */
    float ang = atan(p.y, p.x) / TAU + 0.5;

    // 沿边界一圈圈排布的刻度。这是刻意的径向标记，所以这里是唯一一个
    // 角度函数确实合适的场合。
    float tickPhase = fract(ang * uTicks + uTime * uTickSpin * uTicks);
    float tick = 1.0 - smoothstep(uTickWidth, uTickWidth + 0.06, tickPhase);
    tick *= smoothstep(inner - uTickLength, inner, d) * smoothstep(outer, inner, d);

    // 一道缓慢的扫描光，是拖尾而非对称的，这样才读起来像在旋转。
    // 第二项给环绕衔接处做羽化：没有它的话，尾部会以满亮度撞上头部，
    // 这道扫描就会读成一个硬边的楔形。
    float sweepPhase = fract(ang - uTime * uSweepSpeed);
    float sweep = pow(1.0 - sweepPhase, 6.0) * smoothstep(0.0, 0.05, sweepPhase) * uSweep * interior;

    float core = smoothstep(uCoreSize, 0.0, d) * uCore;
    float coreRing = (1.0 - smoothstep(0.02, 0.045, abs(d - uCoreSize * 0.8))) * uCore * 0.8;

    // 从核心伸出四条臂，正前方那条更长：四边形已经偏航对准瞄准方向，
    // 所以那条臂就是朝向。
    float armLength = uCrosshairLength * mix(1.0, 1.8, step(0.0, p.y) * step(abs(p.x), abs(p.y)));
    float arms = max(1.0 - smoothstep(0.02, 0.05, abs(p.x)), 1.0 - smoothstep(0.02, 0.05, abs(p.y)));
    arms *= smoothstep(armLength, armLength * 0.25, d) * smoothstep(uCoreSize * 0.5, uCoreSize, d);
    arms *= uCrosshair;

    /* ---- 组装 ---- */
    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float fill = interior * wash * uFill * breathe;
    float lines = (liner * 1.3 + tick + core + coreRing + arms + sweep) * breathe;
    float edge = band * uBoundaryGlow * breathe;

    float alpha = clamp(fill + lines + edge, 0.0, 1.0) * uOpacity * uReveal;
    if (alpha < 0.004) discard;

    // 色带画在两种颜色中间的那个颜色上，而不是用其余装饰所采用的白色核心。
    // 在辉光状态下它需要读成屏幕上最厚的东西，否则就会被裁成一片平的，而这个
    // 技能也就丢掉了唯一一个提示——说明这个圆圈属于哪一次施放。
    vec3 color = uColorEdge * fill + uColorCore * lines + mix(uColorEdge, uColorCore, 0.5) * edge;
    color = mix(color, uColorInvalid * (fill + lines + edge), uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * 触及范围圆环，画在闪电条带（bolt ribbon strip）折成的一个圆上。
 *
 * 一个装得下 20 m 射程的四边形会有 40 m 宽，为了一条细线而着色满屏会被丢弃的
 * 片元；而一条条带只花费圆环本身，别的什么都不花。`(t, side)` 以"绕到多远了"
 * 和"落在哪一侧唇缘"的形式输入，输出为一个世界坐标——与本项目其他所有参数化
 * 网格的约定一致。
 */
const REACH_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uSpin;

  varying float vAngle;
  varying float vSide;

  void main() {
    float t = position.x;
    float side = position.y;
    vAngle = t;
    vSide = side;

    float a = (t + uTime * uSpin) * TAU;
    vec3 dir = vec3(sin(a), 0.0, cos(a));
    vec3 world = uCentre + dir * (uRadius + side * uWidth);

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const REACH_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uDashes;
  uniform float uDashGap;
  uniform float uSpin;
  uniform float uLead;        // 光标所在的方位角，表示为 0..1 的比例
  uniform float uLeadStrength;
  uniform float uIntensity;
  uniform float uReveal;
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying float vAngle;
  varying float vSide;

  void main() {
    float profile = 1.0 - clamp(abs(vSide), 0.0, 1.0);
    profile = pow(profile, 1.6);

    // 虚线图案焊死在条带自身的参数上，而旋转条带的是顶点着色器——所以虚线
    // 随着圆环一起爬动，而不是在圆环从它们下面转过时静止在世界里。
    float dash = 1.0;
    if (uDashes > 0.5) {
      float phase = fract(vAngle * uDashes);
      dash = 1.0 - smoothstep(1.0 - uDashGap, 1.0 - uDashGap + 0.12, phase);
    }

    // 引导标记钉在一个 *世界* 方位角上，所以它必须抵消顶点着色器施加的那次
    // 旋转。取绕行最短的一侧，0..0.5。
    float world = fract(vAngle + uTime * uSpin);
    float delta = abs(fract(world - uLead + 0.5) - 0.5);
    float lead = smoothstep(0.12, 0.0, delta) * uLeadStrength;

    float alpha = profile * (dash * uIntensity + lead) * uReveal * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorEdge, uColorCore, clamp(lead + profile * 0.4, 0.0, 1.0));
    color = mix(color, uColorInvalid, uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * 在 **远程施放** 处于备战状态时绘制的地面圆圈。
 *
 * 两个参数化网格，没有贴图：光标处的足迹，以及施放者脚下的触及范围圆环。
 * 两者每帧都根据实时的 `settings.zone` 配置块重建，所以拖动任何一个滑杆都会
 * 立刻改变光标下方的圆圈形状——而拖动技能自己的 `zoneRadius` 会改变这个指示器
 * 所做出的承诺的大小。
 *
 * 足迹会弹出到半径之外，并在施放进入备战状态时回落到半径上。这种过冲就是
 * 这个指示器的全部性格：一个线性生长的圆圈读起来像 UI 元素，而一个猛地弹出去
 * 的圆圈读起来像施放者做了个动作。
 */
export class ZoneIndicator {
    constructor() {
        this.group = new Group();
        this.group.name = 'ZoneIndicator';
        this.group.matrixAutoUpdate = false;

        /* ---- 足迹 ---- */
        // 地面平面里的单位正方形，居中：局部 +Z 就是瞄准朝向，所以摆放它
        // 只需要一个偏航角和一个缩放。
        this.discGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
        this.discMaterial = new ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: AdditiveBlending,
            side: DoubleSide,
            toneMapped: false,
            uniforms: sharedUniforms({
                uQuadSize: { value: 12 },
                uRadius: { value: 4.4 },
                uBoundary: { value: 0.34 },
                uBias: { value: 0.35 },
                uBoundaryGlow: { value: 2.4 },
                uLiner: { value: 0.05 },
                uSoftness: { value: 0.05 },
                uFill: { value: 0.18 },
                uFillFalloff: { value: 1.5 },
                uRings: { value: 2 },
                uRingWidth: { value: 0.05 },
                uRingSpeed: { value: 0.35 },
                uCrawl: { value: 0.6 },
                uCrawlScale: { value: 1.3 },
                uCrawlSpeed: { value: 0.45 },
                uNoise: { value: 0.4 },
                uNoiseScale: { value: 1.2 },
                uTicks: { value: 24 },
                uTickLength: { value: 0.42 },
                uTickWidth: { value: 0.2 },
                uTickSpin: { value: 0.06 },
                uSweep: { value: 0.55 },
                uSweepSpeed: { value: 0.4 },
                uCore: { value: 0.85 },
                uCoreSize: { value: 0.4 },
                uCrosshair: { value: 0.5 },
                uCrosshairLength: { value: 1.1 },
                uPulse: { value: 0.22 },
                uPulseSpeed: { value: 2 },
                uReveal: { value: 0 },
                uInvalid: { value: 0 },
                uOpacity: { value: 1 },
                uColorCore: { value: new Color(0.92, 0.97, 1) },
                uColorEdge: { value: new Color(0.49, 0.42, 1) },
                uColorInvalid: { value: new Color(1, 0.41, 0.36) },
            }),
            vertexShader: ZONE_VERTEX,
            fragmentShader: ZONE_FRAGMENT,
        });

        this.disc = new Mesh(this.discGeometry, this.discMaterial);
        this.disc.name = 'ZoneFootprint';
        this.disc.layers.set(LAYER.VFX);
        this.disc.renderOrder = 5; // 在 VFX 之下，在地板之上
        this.disc.frustumCulled = false;

        /* ---- 触及范围圆环 ---- */
        this.reachGeometry = createBoltRibbonGeometry(settings.zone.reachSegments + 1, 1);
        this.reachMaterial = new ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: AdditiveBlending,
            side: DoubleSide,
            toneMapped: false,
            uniforms: sharedUniforms({
                uCentre: { value: new Vector3() },
                uRadius: { value: 20 },
                uWidth: { value: 0.05 },
                uSpin: { value: 0.03 },
                uDashes: { value: 64 },
                uDashGap: { value: 0.42 },
                uLead: { value: 0 },
                uLeadStrength: { value: 0.9 },
                uIntensity: { value: 0.7 },
                uReveal: { value: 0 },
                uInvalid: { value: 0 },
                uOpacity: { value: 1 },
                uColorCore: { value: new Color(0.92, 0.97, 1) },
                uColorEdge: { value: new Color(0.49, 0.42, 1) },
                uColorInvalid: { value: new Color(1, 0.41, 0.36) },
            }),
            vertexShader: REACH_VERTEX,
            fragmentShader: REACH_FRAGMENT,
        });

        this.reach = new Mesh(this.reachGeometry, this.reachMaterial);
        this.reach.name = 'ZoneReachRing';
        this.reach.layers.set(LAYER.VFX);
        this.reach.renderOrder = 5;
        this.reach.frustumCulled = false;

        this.group.add(this.disc, this.reach);
        this.group.visible = false;
    }

    get object3D() {
        return this.group;
    }

    /**
     * 摆放并重新塑造这个圆圈。
     *
     * @param {THREE.Vector3} origin  施放者的脚下
     * @param {number} yaw            瞄准的朝向，绕 +Y 的弧度
     * @param {number} distance       目标点在多远处，米
     * @param {number} radius         技能的足迹，米
     * @param {number} range          技能的最大触及范围，米
     * @param {number} reveal         0..1 弹出
     * @param {boolean} valid         为 false 时把圆圈染成 `colorInvalid`
     */
    update(origin, yaw, distance, radius, range, reveal, valid) {
        const z = settings.zone;
        const opacity = z.opacity * settings.global.opacity;
        const invalid = valid ? 0 : 1;

        /* ---- 弹出 ---- */
        // 两条曲线相乘：一条最终稳定在 1 的生长曲线，加一个出现得较晚、并且恰好
        // 在 1 处归零的凸起，于是圆圈在向外弹出时冲过自己的半径，再拉回到半径
        // 上。线性生长读起来像 UI 元素。
        const t = saturate(reveal);
        const bump = Math.sin(Math.PI * Math.pow(t, 1.7));
        const snapped = radius * Easing.outCubic(t) * (1 + (z.snap - 1) * bump);

        /* ---- 足迹 ---- */
        const quadSize = (radius * Math.max(1, z.snap) + z.boundary + 0.6) * 2;
        const u = this.discMaterial.uniforms;

        u.uQuadSize.value = quadSize;
        u.uRadius.value = Math.max(0.05, snapped);
        u.uBoundary.value = z.boundary;
        u.uBias.value = z.boundaryBias;
        u.uBoundaryGlow.value = z.boundaryGlow;
        u.uLiner.value = z.liner;
        u.uSoftness.value = z.softness;
        u.uFill.value = z.fill;
        u.uFillFalloff.value = z.fillFalloff;
        u.uRings.value = z.rings;
        u.uRingWidth.value = z.ringWidth;
        u.uRingSpeed.value = z.ringSpeed;
        u.uCrawl.value = z.crawl;
        u.uCrawlScale.value = z.crawlScale;
        u.uCrawlSpeed.value = z.crawlSpeed;
        u.uNoise.value = z.noise;
        u.uNoiseScale.value = z.noiseScale;
        u.uTicks.value = Math.max(0, Math.round(z.ticks));
        u.uTickLength.value = z.tickLength;
        u.uTickWidth.value = z.tickWidth;
        u.uTickSpin.value = z.tickSpin;
        u.uSweep.value = z.sweep;
        u.uSweepSpeed.value = z.sweepSpeed;
        u.uCore.value = z.core;
        u.uCoreSize.value = z.coreSize;
        u.uCrosshair.value = z.crosshair;
        u.uCrosshairLength.value = z.crosshairLength;
        u.uPulse.value = z.pulse;
        u.uPulseSpeed.value = z.pulseSpeed;
        u.uReveal.value = t;
        u.uInvalid.value = invalid;
        u.uOpacity.value = opacity;
        u.uColorCore.value.copy(getColor(z.colorCore));
        u.uColorEdge.value.copy(getColor(z.colorEdge));
        u.uColorInvalid.value.copy(getColor(z.colorInvalid));

        this.disc.position.set(origin.x + Math.sin(yaw) * distance, z.height, origin.z + Math.cos(yaw) * distance);
        this.disc.rotation.set(0, yaw, 0);
        this.disc.scale.set(quadSize, 1, quadSize);

        /* ---- 触及范围圆环 ---- */
        const r = this.reachMaterial.uniforms;
        r.uCentre.value.set(origin.x, z.height, origin.z);
        r.uRadius.value = Math.max(0.2, range);
        r.uWidth.value = z.reachWidth;
        r.uSpin.value = z.reachSpin;
        r.uDashes.value = Math.max(0, Math.round(z.reachDashes));
        r.uDashGap.value = z.reachDashGap;
        // 条带的 `t` 从 +Z 起沿逆时针延伸，这正是顶点着色器铺排它的方式——
        // 因此光标的方位角就是它的偏航角除以一整圈。
        r.uLead.value = (((yaw / (Math.PI * 2)) % 1) + 1) % 1;
        r.uLeadStrength.value = z.reachLead;
        r.uIntensity.value = z.reach;
        r.uReveal.value = t;
        r.uInvalid.value = invalid;
        r.uOpacity.value = opacity;
        r.uColorCore.value.copy(getColor(z.colorCore));
        r.uColorEdge.value.copy(getColor(z.colorEdge));
        r.uColorInvalid.value.copy(getColor(z.colorInvalid));

        this.reach.visible = z.reach > 0.001;
    }

    setVisible(visible) {
        this.group.visible = visible;
    }

    dispose() {
        this.discGeometry.dispose();
        this.discMaterial.dispose();
        this.reachGeometry.dispose();
        this.reachMaterial.dispose();
    }
}
