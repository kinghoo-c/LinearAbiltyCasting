import { Mesh, PlaneGeometry, ShaderMaterial, AdditiveBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const AIM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 整个指示器就是一个以米为单位求值的符号距离场。
 *
 * `vUv` 经过了重映射，使 `p.y` 成为沿瞄准线距施放者的距离、`p.x` 成为横向
 * 偏移，两者都以世界空间的米为单位。因此 `settings.aim` 里的每一项控制都是
 * 真实度量而不是 UV 比例——这正是无论施放距离是 3 m 还是 15 m，杆身宽度与
 * 箭头头部都能保持相同物理尺寸的原因。
 */
const AIM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadLength;   // quad 覆盖的长度，米
  uniform float uQuadWidth;    // quad 覆盖的宽度，米
  uniform float uQuadBack;     // quad 从施放者身后多远开始
  uniform float uLength;       // 施放距离本身，米
  uniform float uStart;        // 施放者与尾端之间的间隙
  uniform float uShaftWidth;
  uniform float uHeadLength;
  uniform float uHeadWidth;
  uniform float uRound;
  uniform float uEdge;
  uniform float uEdgeGlow;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uStripes;
  uniform float uStripeSharp;
  uniform float uStripeDepth;
  uniform float uScrollSpeed;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uCrystals;
  uniform float uCrystalScale;
  uniform float uBaseRing;
  uniform float uBaseRingWidth;
  uniform float uTipGlyph;
  uniform float uTipGlyphSize;
  uniform float uTipSpin;
  uniform float uRangeArc;
  uniform float uReveal;       // 技能进入备战后 0..1 的扫出进度
  uniform float uInvalid;      // 目标落在最小射程内时为 1
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  /* iq 精确的三角形 SDF——之所以需要它，是因为箭头头部是一块又宽又扁的
     楔形，廉价的半平面求交会在此留下肉眼可见的拐角瑕疵。 */
  float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
    vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;

    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);

    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                     vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
  }

  void main() {
    /* ---- uv → 米，从施放者位置起算 ---- */
    vec2 p = vec2((vUv.x - 0.5) * uQuadWidth,
                  (1.0 - vUv.y) * uQuadLength - uQuadBack);

    float length_ = max(uLength, uStart + 0.05);
    float headLen = min(uHeadLength, length_ - uStart);
    float headBase = length_ - headLen;

    /* ---- 轮廓 ---- */
    float shaft = sdBox(p - vec2(0.0, (uStart + headBase) * 0.5),
                        vec2(uShaftWidth, max(0.001, (headBase - uStart) * 0.5)));
    float head = sdTriangle(p,
                            vec2(-uHeadWidth, headBase),
                            vec2( uHeadWidth, headBase),
                            vec2( 0.0,        length_));
    float d = min(shaft, head) - uRound;

    float aa = fwidth(d) + uSoftness;
    float body = 1.0 - smoothstep(-aa, aa, d);
    float outline = 1.0 - smoothstep(uEdge, uEdge + aa, abs(d));

    /* ---- 内部填充 ---- */
    // 越靠近边缘越亮：平铺的填充读起来像贴花，而按边缘加权的填充
    // 读起来像落在地面上的一团光。
    float depth = clamp(-d / max(uShaftWidth, 0.05), 0.0, 1.0);
    float interior = pow(1.0 - depth, uFillFalloff);

    // 朝尖端推进的雪佛龙纹。把相位按 |x| 倾斜，就把平整的条纹
    // 变成了全都指向施放方向的箭头。
    float phase = (p.y - abs(p.x) * 0.55 - uTime * uScrollSpeed) * uStripes;
    float band = 0.5 + 0.5 * cos(phase * TAU);
    band = pow(band, mix(1.0, 9.0, uStripeSharp));

    float frost = fbm3(vec3(p * uNoiseScale, uTime * uNoiseSpeed)) * 0.5 + 0.5;
    vec2 cell = voronoi2(p * uCrystalScale + 13.7);
    float plates = smoothstep(0.32, 0.0, cell.x);

    float wash = interior;
    wash *= mix(1.0, band, uStripeDepth);
    wash *= mix(1.0, frost, uNoise);
    wash += plates * uCrystals * 0.35 * interior;
    wash *= 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);

    /* ---- 装饰件 ---- */
    float radius = length(p);
    float ring = smoothstep(uBaseRingWidth, 0.0, abs(radius - uBaseRing));

    // 最大射程处的一段封口圆弧，按箭头头部的宽度裁剪，让它读起来像
    // 射程标记，而不是一个完整的圆。
    float arc = smoothstep(0.05, 0.0, abs(radius - length_)) *
                smoothstep(uHeadWidth * 2.2, uHeadWidth * 1.1, abs(p.x)) * uRangeArc;

    // 钉在命中点上的一朵六瓣霜花纹章。
    vec2 q = p - vec2(0.0, length_);
    float qr = length(q);
    float qa = atan(q.y, q.x) + uTime * uTipSpin * TAU;
    float spokes = smoothstep(0.86, 1.0, abs(cos(qa * 3.0))) *
                   smoothstep(uTipGlyphSize, 0.0, qr);
    float glyphRing = smoothstep(0.045, 0.0, abs(qr - uTipGlyphSize * 0.5));
    float glyph = max(spokes, glyphRing) * uTipGlyph;

    /* ---- 技能进入备战时的扫出 ---- */
    float front = uReveal * (length_ + uTipGlyphSize);
    float sweep = smoothstep(front + 0.25, front - 0.15, p.y);
    float sweepEdge = smoothstep(0.35, 0.0, abs(p.y - front)) * step(uReveal, 0.999);

    /* ---- 组装 ---- */
    float fill = body * wash * uFill;
    float lines = outline * uEdgeGlow + ring + arc + glyph;

    float alpha = clamp(fill + lines + sweepEdge * 0.6, 0.0, 1.0) * sweep * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + uColorCore * (lines + sweepEdge);
    color = mix(color, uColorInvalid * (fill + lines + sweepEdge), uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * 技能进入备战时绘制的地面箭头。
 *
 * 一个 quad、一个着色器，不用任何贴图。quad 每帧都依据实时的 `settings.aim`
 * 配置与当前瞄准重新定尺寸、重新定朝向，所以在编辑器里拖动任意滑杆，
 * 光标下的箭头都会立刻改变形状。
 */
export class AimIndicator {
    constructor() {
        // 单位空间：x ∈ [-0.5, 0.5]，z ∈ [0, 1]，朝上。局部 +Z 就是瞄准方向，
        // 所以给箭头定朝向只需要一次偏航。
        this.geometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);

        this.material = new ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: AdditiveBlending,
            side: DoubleSide,
            toneMapped: false,
            uniforms: sharedUniforms({
                uQuadLength: { value: 10 },
                uQuadWidth: { value: 6 },
                uQuadBack: { value: 1 },
                uLength: { value: 8 },
                uStart: { value: 0.9 },
                uShaftWidth: { value: 0.42 },
                uHeadLength: { value: 2.6 },
                uHeadWidth: { value: 1.35 },
                uRound: { value: 0.12 },
                uEdge: { value: 0.09 },
                uEdgeGlow: { value: 2.6 },
                uSoftness: { value: 0.06 },
                uFill: { value: 0.3 },
                uFillFalloff: { value: 1.1 },
                uStripes: { value: 0.55 },
                uStripeSharp: { value: 0.62 },
                uStripeDepth: { value: 0.55 },
                uScrollSpeed: { value: 2.4 },
                uPulse: { value: 0.28 },
                uPulseSpeed: { value: 2.2 },
                uNoise: { value: 0.45 },
                uNoiseScale: { value: 1.6 },
                uNoiseSpeed: { value: 0.35 },
                uCrystals: { value: 0.55 },
                uCrystalScale: { value: 2.4 },
                uBaseRing: { value: 0.62 },
                uBaseRingWidth: { value: 0.06 },
                uTipGlyph: { value: 0.9 },
                uTipGlyphSize: { value: 1.15 },
                uTipSpin: { value: 0.45 },
                uRangeArc: { value: 0.55 },
                uReveal: { value: 0 },
                uInvalid: { value: 0 },
                uOpacity: { value: 1 },
                uColorCore: { value: new Color(0.92, 0.98, 1) },
                uColorEdge: { value: new Color(0.24, 0.7, 1) },
                uColorInvalid: { value: new Color(1, 0.41, 0.36) },
            }),
            vertexShader: AIM_VERTEX,
            fragmentShader: AIM_FRAGMENT,
        });

        this.mesh = new Mesh(this.geometry, this.material);
        this.mesh.name = 'AimIndicator';
        this.mesh.layers.set(LAYER.VFX);
        this.mesh.renderOrder = 5; // 在特效之下，在地板之上
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
    }

    get object3D() {
        return this.mesh;
    }

    /**
     * 摆放并重新塑形这支箭头。
     *
     * @param {THREE.Vector3} origin  施放者的双脚
     * @param {number} yaw            瞄准线的朝向，绕 +Y 的弧度
     * @param {number} distance       施放距离，米
     * @param {number} reveal         0..1 的扫出进度
     * @param {boolean} valid         false 会把箭头染成 `colorInvalid`
     */
    update(origin, yaw, distance, reveal, valid) {
        const a = settings.aim;
        const u = this.material.uniforms;

        // quad 必须容得下着色器画出来的最宽的东西，外加落在施放者*身后*的
        // 光环，以及落在尖端*之外*的那朵纹章。
        const back = Math.max(a.baseRing, 0.2) + 0.4;
        const forward = distance + Math.max(a.tipGlyphSize, 0.3) + 0.5;
        const halfWidth = Math.max(a.headWidth, a.shaftWidth, a.baseRing, a.tipGlyphSize) + a.edge + a.round + 0.5;

        const quadLength = back + forward;
        const quadWidth = halfWidth * 2;

        u.uQuadLength.value = quadLength;
        u.uQuadWidth.value = quadWidth;
        u.uQuadBack.value = back;
        u.uLength.value = distance;
        u.uStart.value = a.startOffset;
        u.uShaftWidth.value = a.shaftWidth;
        u.uHeadLength.value = a.headLength;
        u.uHeadWidth.value = a.headWidth;
        u.uRound.value = a.round;
        u.uEdge.value = a.edge;
        u.uEdgeGlow.value = a.edgeGlow;
        u.uSoftness.value = a.softness;
        u.uFill.value = a.fill;
        u.uFillFalloff.value = a.fillFalloff;
        u.uStripes.value = a.stripes;
        u.uStripeSharp.value = a.stripeSharp;
        u.uStripeDepth.value = a.stripeDepth;
        u.uScrollSpeed.value = a.scrollSpeed;
        u.uPulse.value = a.pulse;
        u.uPulseSpeed.value = a.pulseSpeed;
        u.uNoise.value = a.noise;
        u.uNoiseScale.value = a.noiseScale;
        u.uNoiseSpeed.value = a.noiseSpeed;
        u.uCrystals.value = a.crystals;
        u.uCrystalScale.value = a.crystalScale;
        u.uBaseRing.value = a.baseRing;
        u.uBaseRingWidth.value = a.baseRingWidth;
        u.uTipGlyph.value = a.tipGlyph;
        u.uTipGlyphSize.value = a.tipGlyphSize;
        u.uTipSpin.value = a.tipSpin;
        u.uRangeArc.value = a.rangeArc;
        u.uReveal.value = reveal;
        u.uInvalid.value = valid ? 0 : 1;
        u.uOpacity.value = a.opacity * settings.global.opacity;
        u.uColorCore.value.copy(getColor(a.colorCore));
        u.uColorEdge.value.copy(getColor(a.colorEdge));
        u.uColorInvalid.value.copy(getColor(a.colorInvalid));

        // 把 quad 往后挪，使基底光环不被它自己的近端边缘裁掉。
        this.mesh.position.set(origin.x - Math.sin(yaw) * back, a.height, origin.z - Math.cos(yaw) * back);
        this.mesh.rotation.set(0, yaw, 0);
        this.mesh.scale.set(quadWidth, 1, quadLength);
    }

    setVisible(visible) {
        this.mesh.visible = visible;
    }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
    }
}
