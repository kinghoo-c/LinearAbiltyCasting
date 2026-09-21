/**
 * 渲染层。
 *
 * WORLD       — 不透明环境 + 角色。写入深度预通道，接收阴影，
 *               也是软粒子淡出所依据的对象。
 * VFX         — 每一个透明技能网格与粒子系统。
 * DISTORTION  — 对主通道不可见的代理，负责写入屏幕空间 UV 偏移，
 *               用于热浪扭曲 / 水面折射。
 * CONTACT     — 只加在角色身上的附加层标志，让接触阴影
 *               通道捕获它，而不至于同时捕获草地或 VFX。
 */
export const LAYER = Object.freeze({
    WORLD: 0,
    VFX: 1,
    DISTORTION: 2,
    CONTACT: 3,
});

/** 把一个对象及其全部子对象放到同一个层上。 */
export function setLayerRecursive(object, layer) {
    object.traverse((node) => node.layers.set(layer));
    return object;
}
