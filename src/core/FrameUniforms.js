import { Vector2, Vector3 } from 'three';

/**
 * 按同一性（identity）被*每一个*自定义材质共享的 uniform 对象。
 *
 * 因为 three.js 把 uniform 存成 `{ value }` 盒子，把同一个盒子交给
 * 许多材质，就意味着每帧写一次即可更新它们全部。这让几十个 VFX 材质的
 * 每帧 CPU 开销降到区区几次赋值，而不必做一次遍历。
 */
export const frame = {
    uTime: { value: 0 },
    uDelta: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    /** 不透明场景的打包 RGBA 深度——用于驱动软粒子。 */
    uSceneDepth: { value: null },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 400 },
    /** 等距柱状（equirectangular）HDR，供自定义着色器做廉价反射用。 */
    uEnvMap: { value: null },
    /**
     * 世界空间中*指向*太阳的方向，从环境镜像而来。
     * 那些伪造法线的自定义着色器——地面积雪、碎石——需要用到与受光网格
     * 相同的主光方向，否则伪造出来的效果看起来就像一张贴纸。
     */
    uLightDir: { value: new Vector3(0.45, 0.78, 0.44).normalize() },
    /** 从 settings 镜像而来的全局乘数，方便着色器读取。 */
    uShaderIntensity: { value: 1 },
    uGlobalGlow: { value: 1 },
};

/** 便捷函数：每个 VFX 材质都想要的那套 uniform 块。 */
export function sharedUniforms(extra = {}) {
    return {
        uTime: frame.uTime,
        uResolution: frame.uResolution,
        uSceneDepth: frame.uSceneDepth,
        uCameraNear: frame.uCameraNear,
        uCameraFar: frame.uCameraFar,
        uLightDir: frame.uLightDir,
        uShaderIntensity: frame.uShaderIntensity,
        uGlobalGlow: frame.uGlobalGlow,
        ...extra,
    };
}
