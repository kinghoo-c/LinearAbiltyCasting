/**
 * 共享的着色辅助函数：柔和粒子、菲涅尔、溶解、渐变。
 *
 * 本 chunk 自行引入 three 的 `<packing>` chunk（softFade 需要它），因此
 * 只能注入到原始 ShaderMaterial——绝不能注入已包含 `<packing>` 的内置
 * 材质，否则深度辅助函数会被定义两次。
 */
export const commonGLSL = /* glsl */ `
#ifndef COMMON_LIB_INCLUDED
#define COMMON_LIB_INCLUDED

#include <packing>

/**
 * 基于深度的柔和粒子衰减。
 * sceneDepth 是不透明场景的打包 RGBA 深度预渲染。
 * 片元与几何体相交处返回 0，远在几何体前方时返回 1。
 */
float softFade(sampler2D sceneDepth, vec2 screenUV, float fragViewZ, float near, float far, float fadeDist) {
  float packed = unpackRGBAToDepth(texture2D(sceneDepth, screenUV));
  float sceneViewZ = perspectiveDepthToViewZ(packed, near, far);
  return clamp((fragViewZ - sceneViewZ) / max(fadeDist, 1e-4), 0.0, 1.0);
}

/** 标准类 Schlick 轮廓光（rim）项。 */
float fresnelTerm(vec3 viewDir, vec3 normal, float power, float scale) {
  return clamp(scale * pow(1.0 - abs(dot(normalize(viewDir), normalize(normal))), power), 0.0, 4.0);
}

/** 带自发光烧灼边缘的阈值溶解。返回 vec2(alphaMask, edge)。 */
vec2 dissolveMask(float noiseValue, float threshold, float edgeWidth) {
  float mask = step(threshold, noiseValue);
  float edge = smoothstep(threshold, threshold + edgeWidth, noiseValue) - mask;
  return vec2(mask, clamp(edge, 0.0, 1.0));
}

/** 由 t（0..1）采样的 4 段渐变色（核心 → 中部 → 边缘 → 拖尾）。 */
vec3 gradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
  return mix(b, c3, smoothstep(0.64, 1.0, t));
}

/** 当前片元的屏幕空间 UV（需要裁剪空间位置）。 */
vec2 screenUVFromClip(vec4 clipPos) {
  return (clipPos.xy / clipPos.w) * 0.5 + 0.5;
}

/** 抗锯齿 step，在有条件时使用屏幕空间导数。 */
float aastep(float threshold, float value) {
  float afwidth = fwidth(value) * 0.7;
  return smoothstep(threshold - afwidth, threshold + afwidth, value);
}

#endif
`;
