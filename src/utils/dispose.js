/**
 * 资源释放辅助函数。
 *
 * Three.js 不会回收 GPU 资源；我们创建的任何东西都必须显式释放。本项目每个
 * 系统都暴露 `dispose()`，并统一走这些辅助函数，以便拆卸过程保持一致。
 */

export function disposeMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) return material.forEach(disposeMaterial);
    for (const key of Object.keys(material)) {
        const value = material[key];
        if (value && value.isTexture) value.dispose();
    }
    if (material.uniforms) {
        for (const name of Object.keys(material.uniforms)) {
            const v = material.uniforms[name]?.value;
            if (v && v.isTexture && v.userData?.ownedByMaterial) v.dispose();
        }
    }
    material.dispose();
}

/** 递归释放 `root` 之下的几何体、材质与贴图。 */
export function disposeObject(root) {
    if (!root) return;
    root.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) disposeMaterial(node.material);
    });
    root.parent?.remove(root);
}

/** 移除组里的每一个子对象，并将其释放。 */
export function clearGroup(group) {
    for (let i = group.children.length - 1; i >= 0; i--) {
        const child = group.children[i];
        group.remove(child);
        disposeObject(child);
    }
}
