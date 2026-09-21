import { ShaderMaterial, Color, Vector3, DoubleSide, NormalBlending } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const GLACIER_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aBirth;
  attribute float aGrow;
  attribute float aShatter;

  varying vec3  vLocal;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying vec3  vAxis;
  varying float vSeed;
  varying float vBirth;
  varying float vGrow;
  varying float vShatter;

  void main() {
    vLocal = position;
    vSeed = aSeed;
    vBirth = aBirth;
    vGrow = aGrow;
    vShatter = aShatter;

    vec3 objectNormal = normal;
    vec3 objectAxis = vec3(0.0, 1.0, 0.0);
    vec4 world;

    #ifdef USE_INSTANCING
      // 一片刃的缩放是（半径、高度、半径），这是各向异性的——实例矩阵会把
      // 每个法线都推向长轴。除以列长的平方，正是 three 自己用的逆转置。
      mat3 im = mat3(instanceMatrix);
      vec3 invScale = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      objectNormal = im * (objectNormal / invScale);
      objectAxis = im * (objectAxis / invScale);
      world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      world = modelMatrix * vec4(position, 1.0);
    #endif

    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * objectNormal);
    vAxis = normalize(mat3(modelMatrix) * objectAxis);
    vView = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * 不是让你去*看*的冰，而是让你*透过*去看的冰，从内部被点亮。
 *
 * Frost Lance 的水晶是采石场里的石头：一个打过补丁的标准材质，带着羽状霜
 * 与白霜的乳白，晶体越厚色调越深。如果这个技能沿用那套处理，它就会读作
 * 同一个法术演了两遍，所以 Glacial Crown 的刃片是从零着色，而且是从相反的
 * 那一端着手的。几乎没有漫反射。你看到的是：
 *
 *   - **一条色散边缘。** fresnel 项被求值*三次*，用三个略有差别的指数，
 *     三个结果各自驱动红、绿、蓝——于是每一处剪影都带着真正的色边，一侧
 *     唇边偏青、另一侧偏紫，就像真实棱镜把一道高光劈开那样。`dispersion`
 *     就是三者分开了多远。
 *   - **沿刃片向上输送的光。** 自发光聚集在轴与之*平行*的那些面上，而不是
 *     正对你的面，并朝尖端攀升（`tipBias`），同时有一道缓慢的条带向上行进
 *     （`bands`、`pulseSpeed`），最终收在白热的尖端。正是这一点让一片刃读作
 *     一根冻结的光纤，而不是一坨东西。
 *   - **纹层，不是霜。** 脊状噪声沿刃片自身的轴被狠狠拉伸，于是内部呈现的
 *     是顺着长度流动的流线，而不是 Lance 那种乳白的云絮。
 *   - **一次真实的反射。** 从刻面上取一次舞台 HDR 探针的 equirect 采样，
 *     再加一个紧致的太阳瓣，于是刻面真的能映出它们立身其中的那间屋子。
 *
 * 在此之上，是这个技能的两处签名——也正是它需要一个材质、而不是换个颜色的
 * 原因：
 *
 *   - **冻结锋面。** `aGrow` 是逐实例的高度，地面处为 0、尖端为 1，高于它的
 *     部分都会被一个带噪声的裁切丢弃，于是一片刃是*向上结晶*冒出地面的，
 *     而不是从一个洞里滑出来。行进中的唇边是发亮的（`frontGlow`）。
 *   - **崩碎。** `aShatter` 是一个与逐片元块 id 相比较的阈值——一半是刃片
 *     自身空间里的 voronoi 单元，一半是其平面法线的哈希——于是一片将死的刃
 *     会一块一块地掉下整块的板与楔，每一道断裂边缘在脱落时都会闪一下。
 *
 * 逐实例的输入以实例化 attribute 的形式到来（`aSeed`、`aBirth`、`aGrow`、
 * `aShatter`），这就是这个材质只会用在 InstancedMesh 上的原因。几何体是
 * 非索引的、带逐面法线，于是刻面自然是脆的，不需要 `flatShading` 标志去要。
 */
const GLACIER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uEnvMap;
  uniform vec3  uSunDir;

  uniform vec3  uColorGlass;
  uniform vec3  uColorEdge;
  uniform vec3  uColorPrismA;
  uniform vec3  uColorPrismB;
  uniform vec3  uColorCore;
  uniform vec3  uColorTip;

  uniform float uBody;
  uniform float uEdgePower;
  uniform float uEdgeGain;
  uniform float uDispersion;
  uniform float uPipe;
  uniform float uTipBias;
  uniform float uBands;
  uniform float uPulseSpeed;
  uniform float uTipStart;
  uniform float uTipGlow;
  uniform float uStria;
  uniform float uStriaScale;
  uniform float uEnvIntensity;
  uniform float uSpecular;
  uniform float uBirthGlow;

  uniform float uFrontRough;
  uniform float uFrontWidth;
  uniform float uFrontGlow;
  uniform float uShatterScale;
  uniform float uShatterEdge;
  uniform float uShatterGlow;

  uniform float uGlow;
  uniform float uOpacity;
  uniform float uGlobalGlow;

  varying vec3  vLocal;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying vec3  vAxis;
  varying float vSeed;
  varying float vBirth;
  varying float vGrow;
  varying float vShatter;

  ${noiseGLSL}

  #define TAU 6.28318530718

  vec2 equirectUv(vec3 dir) {
    return vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5,
                asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vView);
    // 双面：透过近侧那面看到的，有一半是刃片的远侧壁，它的法线必须翻转，
    // 否则着色会里外颠倒。
    if (dot(N, V) < 0.0) N = -N;

    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float h = clamp(vLocal.y, 0.0, 1.0);

    /* ---- 冻结锋面：它以上的东西都还不存在 ---- */
    // 在扣掉噪声之前先把粗糙度加回去，于是一片完全长成的刃（aGrow = 1）
    // 永远切不到自己。
    float ragged = snoise01(vLocal * 5.0 + vSeed * 7.0) * uFrontRough;
    float front  = vGrow * (1.0 + uFrontRough) - ragged;
    if (h > front) discard;
    float freezing = smoothstep(front - uFrontWidth, front, h) *
                     (1.0 - smoothstep(0.985, 1.0, vGrow));

    /* ---- 崩碎：板与楔一块一块地离开 ---- */
    // 两种结构取平均。voronoi 那一半把身体打散成无视几何的块；刻面那一半
    // 则整片整片地带走平面，而后者才是一块水晶真正会发生的事。
    float breaking = 0.0;
    if (vShatter > 0.001) {
      vec2 cell = voronoi2(vLocal.xz * uShatterScale + vLocal.y * 4.0 + vSeed * 13.0);
      float facet = hash13(floor(N * 6.0) + vSeed * 3.0);
      float chunk = 0.55 * cell.y + 0.45 * facet;
      if (chunk < vShatter) discard;
      breaking = smoothstep(vShatter + uShatterEdge, vShatter, chunk);
    }

    /* ---- 色散边缘 ---- */
    vec3 fres = pow(
      vec3(1.0 - ndv),
      vec3(uEdgePower * (1.0 - uDispersion * 0.4), uEdgePower, uEdgePower * (1.0 + uDispersion * 0.55))
    );
    // 每个刻面在色散中有自己的位置，于是一片刃上相邻的面不会都镶同一个颜色。
    vec3 prism = mix(uColorPrismA, uColorPrismB, hash13(floor(N * 7.0) + vSeed * 5.0));

    /* ---- 沿刃片输送到尖端的光 ---- */
    float along = 1.0 - abs(dot(N, vAxis)); // 长条面，不是端盖
    float pipe = along * pow(h, uTipBias);
    float band = 0.5 + 0.5 * sin((h * uBands - uTime * uPulseSpeed) * TAU + vSeed * 5.0);
    pipe *= mix(0.6, 1.0, band * band);
    float tip = smoothstep(uTipStart, 1.0, h);

    /* ---- 顺着其长度流动的流线 ---- */
    float stria = ridged(vec3(vLocal.xz * uStriaScale, vLocal.y * uStriaScale * 0.3 + vSeed * 9.0), 4);
    stria = smoothstep(0.7, 0.97, stria) * along;

    /* ---- 它所处的那间屋子 ---- */
    vec3 refl = reflect(-V, N);
    vec3 env = texture2D(uEnvMap, equirectUv(refl)).rgb * uEnvIntensity;
    float sun = pow(max(dot(refl, -uSunDir), 0.0), 90.0) * uSpecular;

    vec3 color = uColorGlass * uBody * (0.25 + 0.75 * ndv);
    color += prism * fres * uEdgeGain;
    color += uColorEdge * fres.g * fres.g * uEdgeGain * 0.5;
    color += uColorCore * pipe * uPipe;
    color += uColorEdge * stria * uStria;
    color += uColorTip * tip * uTipGlow;
    color += env * (0.35 + 0.65 * fres.g) + uColorEdge * sun;
    color += uColorEdge * freezing * uFrontGlow;
    color += uColorCore * breaking * uShatterGlow;
    color += uColorCore * vBirth * uBirthGlow;
    color *= uGlow;

    // 软上限。每一项都在掠射角处达到峰值，而它们会叠加；Reinhard 滚降对
    // ~1 以下的值基本不动，并渐近于 1/0.16 ≈ 6，于是滑杆在量程顶端仍然
    // 咬得住，又不会把刃片压平成一整块白色剪影。
    color /= 1.0 + color * 0.16;

    // 玻璃感：穿过身体处薄而通透，在剪影处、尖端以及任何正在冻结或崩碎的
    // 边缘处则结实。
    float alpha = uBody * 0.4 + fres.g * 1.25 + pipe * 0.45 + stria * 0.3 +
                  tip * 0.55 + freezing + breaking;
    alpha = clamp(alpha, 0.0, 1.0) * uOpacity;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * Glacial Crown 的刃片。整次施放中每一片碎晶共用一个材质；逐碎晶的状态
 * 由实例化 attribute 带入。
 */
export function createGlacierMaterial() {
    const material = new ShaderMaterial({
        transparent: true,
        // 保持开启：王冠是一堵你望进去的墙，而深度写入正是阻止它自我排序、
        // 并让雾气与雪贴着它淡出的东西。
        depthWrite: true,
        depthTest: true,
        blending: NormalBlending,
        side: DoubleSide,
        toneMapped: false,
        uniforms: {
            uTime: frame.uTime,
            uEnvMap: frame.uEnvMap,
            uGlobalGlow: frame.uGlobalGlow,
            uSunDir: { value: new Vector3(0, -1, 0) },

            uColorGlass: { value: new Color() },
            uColorEdge: { value: new Color() },
            uColorPrismA: { value: new Color() },
            uColorPrismB: { value: new Color() },
            uColorCore: { value: new Color() },
            uColorTip: { value: new Color() },

            uBody: { value: 0.55 },
            uEdgePower: { value: 2.2 },
            uEdgeGain: { value: 1.6 },
            uDispersion: { value: 0.6 },
            uPipe: { value: 1.5 },
            uTipBias: { value: 1.6 },
            uBands: { value: 1.4 },
            uPulseSpeed: { value: 0.6 },
            uTipStart: { value: 0.62 },
            uTipGlow: { value: 1.4 },
            uStria: { value: 0.7 },
            uStriaScale: { value: 6.0 },
            uEnvIntensity: { value: 0.6 },
            uSpecular: { value: 2.0 },
            uBirthGlow: { value: 2.2 },

            uFrontRough: { value: 0.35 },
            uFrontWidth: { value: 0.12 },
            uFrontGlow: { value: 2.6 },
            uShatterScale: { value: 7.0 },
            uShatterEdge: { value: 0.08 },
            uShatterGlow: { value: 3.0 },

            uGlow: { value: 1.0 },
            uOpacity: { value: 1.0 },
        },
        vertexShader: GLACIER_VERTEX,
        fragmentShader: GLACIER_FRAGMENT,
    });

    const u = material.uniforms;

    /** 从实时 settings 中取出调色板与每一项着色控制。 */
    material.userData.sync = () => {
        const c = settings.glacier;
        const g = settings.global;
        const env = settings.environment;

        u.uColorGlass.value.copy(getColor(c.colorGlass));
        u.uColorEdge.value.copy(getColor(c.colorEdge));
        u.uColorPrismA.value.copy(getColor(c.colorPrismA));
        u.uColorPrismB.value.copy(getColor(c.colorPrismB));
        u.uColorCore.value.copy(getColor(c.colorCore));
        u.uColorTip.value.copy(getColor(c.colorTip));

        u.uBody.value = c.body;
        u.uEdgePower.value = c.edgePower;
        u.uEdgeGain.value = c.edgeGain * g.fresnel;
        u.uDispersion.value = c.dispersion;
        u.uPipe.value = c.pipe * g.shaderIntensity;
        u.uTipBias.value = c.tipBias;
        u.uBands.value = c.bands;
        u.uPulseSpeed.value = c.pulseSpeed * g.noiseSpeed;
        u.uTipStart.value = c.tipStart;
        u.uTipGlow.value = c.tipGlow;
        u.uStria.value = c.stria * g.shaderIntensity;
        u.uStriaScale.value = c.striaScale * g.noiseFrequency;
        u.uEnvIntensity.value = c.envIntensity;
        u.uSpecular.value = c.specular;
        u.uBirthGlow.value = c.birthGlow;

        u.uFrontRough.value = c.frontRough * g.noiseStrength;
        u.uFrontWidth.value = c.frontWidth;
        u.uFrontGlow.value = c.frontGlow;
        u.uShatterScale.value = c.shatterScale * g.noiseFrequency;
        u.uShatterEdge.value = c.shatterEdge;
        u.uShatterGlow.value = c.shatterGlow;

        u.uGlow.value = c.glow * g.glow;
        u.uOpacity.value = c.opacity * g.opacity;

        // 舞台实际受照所依据的那颗太阳，于是这道反光和其他场景高光落在同一处。
        const cosE = Math.cos(env.sunElevation);
        u.uSunDir.value
            .set(-Math.cos(env.sunAzimuth) * cosE, -Math.sin(env.sunElevation), -Math.sin(env.sunAzimuth) * cosE)
            .normalize();
    };

    material.userData.sync();
    return material;
}
