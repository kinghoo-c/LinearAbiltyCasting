import { Color } from 'three';

/**
 * 带缓存的十六进制字符串 → THREE.Color 转换。
 *
 * 编辑器把颜色存为 `#rrggbb` 字符串；着色器每帧都需要 Color。若每个 uniform
 * 每帧都分配一个 Color，会反复折腾 GC，因此这里为每个字符串记忆化一个实例，
 * 再由它改写 uniform 的取值。
 */
const cache = new Map();

export function getColor(hex) {
    let c = cache.get(hex);
    if (!c) {
        // three 的色彩管理已经把 `#rrggbb`（sRGB）转成线性工作空间——这里不要
        // 手动转换，否则会被转换两次，所有东西都会偏暗。
        c = new Color(hex);
        cache.set(hex, c);
    }
    return c;
}

/** 把设置里的颜色复制进某个 uniform 的 Color 值，且不产生额外分配。 */
export function copyColor(target, hex) {
    target.copy(getColor(hex));
    return target;
}

/** 由设置字符串生成一个全新的（非共享）Color——用于一次性的构造。 */
export function makeColor(hex) {
    return getColor(hex).clone();
}
