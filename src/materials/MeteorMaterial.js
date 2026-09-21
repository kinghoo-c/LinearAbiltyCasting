import { MeshStandardMaterial, Color, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * 燃烧的岩石——陨石以及它碎裂出的岩块。
 *
 * 基于 MeshStandardMaterial 而不是裸的 ShaderMaterial 构建，原因与冰相同：
 * 岩石是*实体*，它必须投射并接收舞台真实的阴影，也要接收 HDR 探针。风格化
 * 是叠加在它之上的：
 *
 *   - **熔岩缝**——标志性特征。裂缝是 fbm 场的过零点：
 *     `1 - smoothstep(0, width, abs(fbm))` 会在噪声变号之处画出一张薄薄的、
 *     分叉的片状结构，而真实的断裂正是这个样子——蜿蜒且生叉，从来不是一道
 *     划痕。第二个更精细的倍频负责补上从主缝上分出去的小枝。
 *   - **场在局部空间中采样**，因此裂缝是焊在岩石上的，会随它一起翻滚。若在
 *     世界空间采样（冰的断裂是那样做的，且是刻意为之，好让整片场看起来像是
 *     从同一块石料上开采出来的），缝隙就会在一块旋转的陨石表面游移，一眼
 *     就显得假。
 *   - **煤烟**——每条缝的两侧都有一圈烧焦的岩石，正是这一点让辉光不至于
 *     看起来像是画上去的。
 *   - **充能**——陨石逼近目标时，`uCharge` 从 0 跑到 1。它会把缝隙加宽提亮，
 *     于是岩石在坠落途中肉眼可见地越来越烫，而这场爆炸是你早就看见要来的
 *     事。
 *   - **前导面受热**——朝向行进方向的那些面片承受压缩热而变白；背侧则维持
 *     黑暗。
 *   - **逐岩块冷却**——`aHeat` 逐实例从 1 被驱动到 0，于是从撞击中抛出的
 *     碎块在落地过程中逐渐变暗。
 *
 * 逐实例的输入以实例化 attribute（`aSeed`、`aHeat`）的形式传入，因此这个
 * 材质只会用在 InstancedMesh 上。
 */
export function createMeteorMaterial(environment) {
    const material = new MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.94,
        metalness: 0.0,
        // 面片化，与水晶一样：正是这一点让一块低模岩石读起来像岩石，
        // 而不是一个贴着纹理的光滑球体。
        flatShading: true,
    });

    const uniforms = {
        uTime: frame.uTime,
        uColorRock: { value: new Color() },
        uColorChar: { value: new Color() },
        uColorCrack: { value: new Color() },
        uColorHot: { value: new Color() },
        uCrackScale: { value: 2.4 },
        uCrackWidth: { value: 0.1 },
        uCrackBranches: { value: 0.65 },
        uCrackGlow: { value: 3.2 },
        uFlow: { value: 0.7 },
        uFlowSpeed: { value: 0.9 },
        uRockScale: { value: 3.4 },
        uFacetTint: { value: 0.35 },
        uCavity: { value: 0.45 },
        uSoot: { value: 0.8 },
        uRimHeat: { value: 1.1 },
        uLead: { value: 1.6 },
        uLeadSharp: { value: 2.6 },
        /** 陨石朝向的单位向量，世界空间——驱动前导面的受热。 */
        uHeading: { value: new Vector3(0, 0, 1) },
        uCharge: { value: 0 },
        uGlow: { value: 1 },
    };

    environment.registerShadowCasterWithPatch(material, (shader) => {
        Object.assign(shader.uniforms, uniforms);

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
         attribute float aSeed;
         attribute float aHeat;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;`
            )
            // `objectNormal` 由 <beginnormal_vertex> 声明，它在这个 chunk 之前
            // 运行；three 只会把它带入*视图*空间，而前导面那一项需要的是世界
            // 空间。
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
         vRockLocal = transformed;
         vRockSeed = aSeed;
         vRockHeat = aHeat;
         #ifdef USE_INSTANCING
           vRockNormalW = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(objectNormal, 0.0)).xyz);
         #else
           vRockNormalW = normalize(mat3(modelMatrix) * objectNormal);
         #endif`
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
         uniform float uTime;
         uniform vec3  uColorRock;
         uniform vec3  uColorChar;
         uniform vec3  uColorCrack;
         uniform vec3  uColorHot;
         uniform float uCrackScale;
         uniform float uCrackWidth;
         uniform float uCrackBranches;
         uniform float uCrackGlow;
         uniform float uFlow;
         uniform float uFlowSpeed;
         uniform float uRockScale;
         uniform float uFacetTint;
         uniform float uCavity;
         uniform float uSoot;
         uniform float uRimHeat;
         uniform float uLead;
         uniform float uLeadSharp;
         uniform vec3  uHeading;
         uniform float uCharge;
         uniform float uGlow;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;
         ${noiseGLSL}`
            )
            // 在法线解析完成之后再注入：使用 `flatShading` 时没有 `vNormal`
            // varying，因此依赖视线的项必须去读 <normal_fragment_begin> 由屏幕
            // 空间导数导出的面法线。
            .replace(
                '#include <emissivemap_fragment>',
                `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, 2.2);

           /*
            * 这条缝，是当作横截面而不是当作一条线来处理的。
            *
            * "distance" 是这个片元到裂缝场最近一个过零点的距离，而从它身上
            * 切出的三条带，正是让裂缝读起来像*石头裂开*、而不是像一条画在
            * 表面上的亮虫子的原因：
            *
            *   fissure —— 张开的缝隙。这里没有岩石，因此反照率被抹掉，只有
            *             下方的岩浆露出来。
            *   lip     —— 宽得多的烧焦带，位于它两侧。裂缝首先是一道阴影，
            *             其次才是一道光；没有它，辉光就只是浮在表面之上。
            *   core    —— 缝隙的中段，唯一热到能跑成白色的部分。
            *
            * 全程使用局部空间，因此整个网络都焊在岩石上，随它一起翻滚。
            */
           vec3  p  = vRockLocal * uCrackScale + vRockSeed * 19.0;
           float f1 = fbm3(p);
           float f2 = fbm3(p * 2.7 + 11.3);

           // 陨石升温时，充能会把缝隙撬开。
           float width = max(0.004, uCrackWidth * (1.0 + uCharge * 0.8));
           float distance = min(abs(f1), abs(f2) / max(uCrackBranches, 0.05));

           float fissure = 1.0 - smoothstep(width * 0.35, width, distance);
           float lip     = 1.0 - smoothstep(width, width * 2.0, distance);
           float core    = 1.0 - smoothstep(0.0, width * 0.45, distance);

           // 岩浆不是静止的：亮度会沿缝隙内部爬行。
           float pulse = snoise(vRockLocal * 4.0 + vec3(0.0, uTime * uFlowSpeed, 0.0) + vRockSeed * 7.0);
           float flow  = mix(1.0, 0.45 + 0.75 * (pulse * 0.5 + 0.5), uFlow);

           /* --- 岩石本身 --- */
           float mottle = fbm3(vRockLocal * uRockScale + vRockSeed * 31.0) * 0.5 + 0.5;
           vec3  rock   = mix(uColorRock, uColorChar, smoothstep(0.3, 0.85, mottle));

           // 逐面片的数值打散。*物体*空间中的几何法线在一个三角形内是常量，
           // 因此对它做哈希就能让每个平面有自己的色调——正是这一点把切割过的
           // 石头与一个用噪声涂出来的球区分开，而代价只是两次求导。
           vec3  faceN = normalize(cross(dFdx(vRockLocal), dFdy(vRockLocal)));
           float facet = hash13(faceN * 37.0 + vRockSeed + 0.5);
           rock *= 1.0 + (facet - 0.5) * uFacetTint;

           // 廉价的曲率遮蔽：坑洼与切面比凸起更靠近中心，
           // 因此半径可以兼作凹陷项。
           float cavity = smoothstep(0.55, 1.0, length(vRockLocal));
           rock *= mix(1.0 - uCavity, 1.0, cavity);

           // 每条缝周围都烧焦，进入缝内则完全消失。
           rock = mix(rock, uColorChar, lip * uSoot);
           rock *= 1.0 - fissure * 0.92;

           // 跨面片的强光照对比，好让剪影读起来是一束平面，
           // 而不是一整团光滑的体块。
           rock *= mix(0.55, 1.15, ndv);
           diffuseColor.rgb *= rock;

           /* --- 在燃烧的部分 --- */
           // 缝隙是唯一发光的东西，而且只有它的中段会跑成白色。
           // 其余的一切都是岩石。
           float heat = fissure * flow * vRockHeat;
           vec3  glow = mix(uColorCrack, uColorHot, core * core) * heat * uCrackGlow;

           // 剪影周围的一层热带，以及前导面片上的压缩热。两者都相对充能取了
           // 平方：发射时这还是一块裂缝发亮的冷岩石，只有在下坠途中，整块
           // 石头才开始燃烧。
           float charge2 = uCharge * uCharge;
           glow += uColorCrack * rim * uRimHeat * vRockHeat * charge2;

           float lead = pow(clamp(dot(normalize(vRockNormalW), uHeading), 0.0, 1.0), uLeadSharp);
           glow += uColorHot * lead * uLead * vRockHeat * charge2;

           glow *= uGlow;

           // 与冰使用同一个软上限：这些项彼此独立且会叠加，没有它，
           // 一条穿过轮廓的缝会累加到 10 以上，泛光 pass 就会把整块岩石
           // 抹成一团白色。
           glow /= 1.0 + glow * 0.22;

           totalEmissiveRadiance += glow;
         }`
            );
    });

    material.userData.uniforms = uniforms;

    /**
     * 从实时设置中拉取调色板与每一项着色控制。
     * @param {number} charge 0..1——陨石冲势进行到了多远
     * @param {THREE.Vector3} heading 行进方向的单位向量，世界空间
     */
    material.userData.sync = (charge = 0, heading = null) => {
        const c = settings.meteor;
        const g = settings.global;

        uniforms.uColorRock.value.copy(getColor(c.colorRock));
        uniforms.uColorChar.value.copy(getColor(c.colorChar));
        uniforms.uColorCrack.value.copy(getColor(c.colorCrack));
        uniforms.uColorHot.value.copy(getColor(c.colorHot));

        uniforms.uCrackScale.value = c.crackScale * g.noiseFrequency;
        uniforms.uCrackWidth.value = c.crackWidth;
        uniforms.uCrackBranches.value = c.crackBranches;
        uniforms.uCrackGlow.value = c.crackGlow * g.shaderIntensity;
        uniforms.uFlow.value = c.crackFlow;
        uniforms.uFlowSpeed.value = c.crackFlowSpeed * g.noiseSpeed;
        uniforms.uRockScale.value = c.rockScale * g.noiseFrequency;
        uniforms.uFacetTint.value = c.facetTint * g.randomness;
        uniforms.uCavity.value = c.cavity;
        uniforms.uSoot.value = c.soot;
        uniforms.uRimHeat.value = c.rimHeat * g.fresnel;
        uniforms.uLead.value = c.leadGlow;
        uniforms.uLeadSharp.value = c.leadSharp;
        uniforms.uCharge.value = charge;
        uniforms.uGlow.value = c.glow * g.glow;

        if (heading) uniforms.uHeading.value.copy(heading);
        material.envMapIntensity = c.envIntensity;
    };

    material.userData.sync();
    return material;
}
