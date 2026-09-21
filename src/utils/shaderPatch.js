/**
 * 组合 `onBeforeCompile` 回调。
 *
 * 有多个系统都想改写同一个内置材质（CSM 注入它的级联查找，我们注入程序化
 * 颜色）。直接赋值 `onBeforeCompile` 会把先运行的那个悄悄覆盖掉，因此所有
 * 改写都统一走这里。
 */
export function patchOnBeforeCompile(material, fn) {
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
        if (previous) previous.call(this, shader, renderer);
        fn.call(this, shader, renderer);
    };
    return material;
}

/**
 * 替换着色器字符串中的某个记号；若该记号在 three.js 升级后消失，开发模式下
 * 应当抛错——这里静默失效会非常难调试。
 */
export function replaceChunk(source, token, replacement) {
    if (!source.includes(token)) {
        console.warn(`[shaderPatch] token not found: ${token}`);
        return source;
    }
    return source.replace(token, replacement);
}

/** 在着色器阶段的头部插入声明。 */
export function prependChunk(source, code) {
    return `${code}\n${source}`;
}
