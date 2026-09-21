import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * 程序化着色的冰。
 *
 * 它建在 MeshStandardMaterial 之上，而不是一个裸 ShaderMaterial 上，这样
 * 水晶就能投射并接收舞台真实的阴影、并拾取 HDR 探针——风格化是在这之上
 * 叠加进去的：
 *
 *   - **厚度着色** —— 正对看去的刻面在水晶中的路径最长，因此朝 `colorDeep`
 *     变深；掠射的边缘则保持浅淡。正是这一项让这片冰读作一块你能*看进去*
 *     的固体，而不是蓝色塑料。
 *   - **内部裂纹** —— 在*世界*空间采样的脊状噪声，于是无论一根尖刺只有脚踝
 *     高还是三米高，裂纹平面都保持固定的物理尺寸，相邻的水晶也像是从同一
 *     块石料上采下来的。
 *   - **羽状霜与白霜** —— 在*局部*空间（沿水晶向上 0..1）采样的 fbm，于是
 *     乳白的脉络与从基部往上爬的霜都顺着每根尖刺自身的轴，无论它怎么缩放
 *     或倾斜。
 *   - **闪点** —— 一个硬阈值的高频场，在世界空间中滚动，偏向掠射角，而那里
 *     正是真实的冰闪光之处。
 *   - **诞生闪光** —— 一个逐实例的值，技能在 `birthFade` 内把它从 1 驱到 0，
 *     于是一块水晶在它迸出的那一刻从内部被点亮。
 *
 * 逐实例的输入以实例化 attribute 的形式到来（`aSeed`、`aBirth`），这就是这个
 * 材质只会用在 InstancedMesh 上的原因。
 */
export function createIceMaterial(environment) {
    const material = new MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.16,
        metalness: 0.0,
        flatShading: true,
        transparent: true,
        // 冰是半透明的，所以透过近侧壁看到的，有一部分是一块水晶的远侧壁。
        // 剔除它会让内部空掉，凡是身体薄的地方，尖刺就都读作空心壳。
        side: DoubleSide,
        // 保持开启：水晶近乎不透明，而写入深度正是阻止这片冰自我排序、
        // 并让雾气贴着它淡出的东西。
        depthWrite: true,
    });

    const uniforms = {
        uTime: frame.uTime,
        uColorDeep: { value: new Color() },
        uColorIce: { value: new Color() },
        uColorRim: { value: new Color() },
        uColorCore: { value: new Color() },
        uDensity: { value: 1.15 },
        uFresnel: { value: 2.3 },
        uFresnelPower: { value: 2.4 },
        uTranslucency: { value: 1.5 },
        uFacetSharp: { value: 0.68 },
        uFracture: { value: 0.62 },
        uFractureScale: { value: 6.5 },
        uVeins: { value: 0.45 },
        uVeinScale: { value: 3.2 },
        uSparkle: { value: 1.6 },
        uSparkleScale: { value: 34 },
        uSparkleSpeed: { value: 0.7 },
        uFrostLine: { value: 0.5 },
        uGlow: { value: 1.35 },
        uEdgeGlow: { value: 2.0 },
        uBirthGlow: { value: 3.2 },
    };

    environment.registerShadowCasterWithPatch(material, (shader) => {
        Object.assign(shader.uniforms, uniforms);

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;`
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
         vIceLocal = transformed;
         vIceSeed = aSeed;
         vIceBirth = aBirth;
         #ifdef USE_INSTANCING
           vIceWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vIceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
         uniform float uTime;
         uniform vec3  uColorDeep;
         uniform vec3  uColorIce;
         uniform vec3  uColorRim;
         uniform vec3  uColorCore;
         uniform float uDensity;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uTranslucency;
         uniform float uFacetSharp;
         uniform float uFracture;
         uniform float uFractureScale;
         uniform float uVeins;
         uniform float uVeinScale;
         uniform float uSparkle;
         uniform float uSparkleScale;
         uniform float uSparkleSpeed;
         uniform float uFrostLine;
         uniform float uGlow;
         uniform float uEdgeGlow;
         uniform float uBirthGlow;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;
         ${noiseGLSL}`
            )
            // 在法线确定之后再注入：用了 `flatShading` 就没有 `vNormal` varying，
            // 所以这里每一个依赖视角的项都必须读取 <normal_fragment_begin>
            // 由导数推出的面法线。
            .replace(
                '#include <emissivemap_fragment>',
                `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           // 正对某个刻面时，你是沿着水晶的长轴看下去；掠射角下你只是
           // 擦过它的边缘。
           float thickness = clamp(ndv * uDensity, 0.0, 1.0);
           float fres = pow(1.0 - ndv, uFresnelPower) * uFresnel;

           // 世界空间：裂纹平面保持固定的物理尺度，于是一块小碎片和一根高
           // 尖刺看起来像是从同一座冰川上切下来的。
           vec3  fp     = vIceWorld * uFractureScale + vIceSeed * 37.0;
           float cracks = smoothstep(0.55, 0.98, ridged(fp, 4));

           // 局部空间：脉络顺着每块水晶自身的轴。
           float veins = fbm3(vIceLocal * uVeinScale * 4.0 + vIceSeed * 11.0) * 0.5 + 0.5;
           veins = smoothstep(0.45, 0.92, veins);

           vec3 body = mix(uColorIce, uColorDeep, thickness);
           body = mix(body, uColorRim, veins * uVeins * 0.55);
           body = mix(body, uColorRim, cracks * uFracture * 0.4);

           // 霜在水晶离开地面的地方聚集。
           float rime = smoothstep(0.55, 0.0, vIceLocal.y) *
                        (0.5 + 0.5 * fbm3(vIceLocal * 9.0 + vIceSeed * 5.0));
           body = mix(body, uColorRim, clamp(rime, 0.0, 1.0) * uFrostLine);

           // 抬起正对相机的刻面，让剪影读作一捆平面，
           // 而不是一整团平滑的体块。
           body *= mix(1.0, 0.55 + 0.9 * ndv, uFacetSharp);

           // 针尖般的反光，偏向冰会抓到光的掠射角。
           float sp = snoise(vIceWorld * uSparkleScale +
                             vec3(0.0, uTime * uSparkleSpeed, 0.0) + vIceSeed * 23.0);
           sp = pow(clamp(sp, 0.0, 1.0), 14.0) * smoothstep(0.0, 0.7, fres + 0.3);

           diffuseColor.rgb *= body;

           // 轮廓*辉光*搭乘的是归一化的 0..1 fresnel，而不是 fres。fres 带着
           // uFresnel（默认 2.3），因为它还要驱动不透明度；把那份增益再折进
           // 自发光里，会在其他任何一项落地之前就把剪影乘到 4 倍白以上。
           float rimAmount = pow(1.0 - ndv, uFresnelPower);

           vec3 glow = uColorRim * rimAmount * uEdgeGlow;
           glow += uColorCore * (cracks * uFracture * 0.8 + veins * uVeins * 0.35) * uTranslucency;
           glow += uColorRim * sp * uSparkle * 1.5;
           glow += uColorCore * vIceBirth * uBirthGlow;
           glow *= uGlow;

           // 软上限。上面这些项彼此独立，又都在掠射角处达到峰值，所以它们会
           // 叠加：没有这一层，剪影上的一个刻面会累加到远超 10，水晶就读作
           // 一团糊着 bloom 通道的白色块。Reinhard 滚降对 ~1 以下的值基本
           // 不动，并渐近于 1/0.22 ≈ 4.5，于是滑杆在量程顶端仍然咬得住，
           // 又不会过曝。
           glow /= 1.0 + glow * 0.22;

           totalEmissiveRadiance += glow;

           // 边缘处薄，穿过身体以及沿裂纹处更密实。
           diffuseColor.a = clamp(diffuseColor.a * (0.62 + 0.5 * fres) + cracks * 0.12, 0.0, 1.0);
         }`
            );
    });

    material.userData.uniforms = uniforms;

    /** 从实时 settings 中取出调色板与每一项着色控制。 */
    material.userData.sync = () => {
        const c = settings.ice;
        const g = settings.global;

        uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
        uniforms.uColorIce.value.copy(getColor(c.colorIce));
        uniforms.uColorRim.value.copy(getColor(c.colorRim));
        uniforms.uColorCore.value.copy(getColor(c.colorCore));

        uniforms.uDensity.value = c.depthTint;
        uniforms.uFresnel.value = c.fresnel * g.fresnel;
        uniforms.uFresnelPower.value = c.fresnelPower;
        uniforms.uTranslucency.value = c.translucency;
        uniforms.uFacetSharp.value = c.facetSharp;
        uniforms.uFracture.value = c.fracture * g.shaderIntensity;
        uniforms.uFractureScale.value = c.fractureScale * g.noiseFrequency;
        uniforms.uVeins.value = c.veins * g.shaderIntensity;
        uniforms.uVeinScale.value = c.veinScale * g.noiseFrequency;
        uniforms.uSparkle.value = c.glint * g.shaderIntensity;
        uniforms.uSparkleScale.value = c.glintScale;
        uniforms.uSparkleSpeed.value = c.glintSpeed * g.noiseSpeed;
        uniforms.uFrostLine.value = c.frostLine;
        uniforms.uGlow.value = c.glow * g.glow;
        uniforms.uEdgeGlow.value = c.edgeGlow;
        uniforms.uBirthGlow.value = c.birthGlow;

        material.opacity = c.opacity * g.opacity;
        material.envMapIntensity = c.envIntensity;
    };

    material.userData.sync();
    return material;
}
