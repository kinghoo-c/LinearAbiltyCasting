import { LoadingManager, TextureLoader } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * 一张 1×1 的不透明白色 PNG。
 *
 * 制作工具会把本地绝对纹理路径烤进 FBX 文件（这个模型指向
 * `C:/Users/.../textures/...`）。这些请求在 Web 服务器上永远无法解析，
 * 所以在这里把它们重定向掉：材质保留一张中性贴图，
 * 而不是永远挂着一个待处理的纹理，控制台也能保持干净。
 */
export const PLACEHOLDER_TEXTURE_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** 匹配泄漏到资源引用里的盘符路径或 UNC 路径。 */
const ABSOLUTE_LOCAL_PATH = /(^|\/)[A-Za-z]:[\\/]|^\\\\/;

/**
 * 统一的资源加载，共用同一条进度流。
 *
 * 所有加载器共用一个 LoadingManager，这样启动画面能报告真实的
 * 聚合进度，而不用靠猜。
 */
export class AssetLoader {
    constructor() {
        this.manager = new LoadingManager();
        this.manager.setURLModifier((url) => (ABSOLUTE_LOCAL_PATH.test(url) ? PLACEHOLDER_TEXTURE_URL : url));

        this.fbx = new FBXLoader(this.manager);
        this.hdr = new HDRLoader(this.manager);
        this.texture = new TextureLoader(this.manager);

        this._onProgress = null;
        this._loaded = 0;
        this._total = 0;
        this._settleWaiters = [];

        this.manager.onStart = (url, loaded, total) => {
            this._loaded = loaded;
            this._total = total;
        };
        this.manager.onProgress = (url, loaded, total) => {
            this._loaded = loaded;
            this._total = total;
            this._onProgress?.(total ? loaded / total : 0, url);
        };
        this.manager.onLoad = () => {
            this._loaded = this._total;
            this._settleWaiters.splice(0).forEach((resolve) => resolve());
        };
        this.manager.onError = (url) => console.error(`[AssetLoader] failed: ${url}`);
    }

    onProgress(callback) {
        this._onProgress = callback;
    }

    /**
     * 等到所有已排队的请求都落定后 resolve。
     *
     * 加载器在*模型*解析完成的那一刻就 resolve 了；此时它的纹理还在
     * 途中，所以任何要检查 `texture.image` 的代码都必须先等这里，否则
     * 会读到一个只初始化了一半的纹理。
     */
    settled() {
        if (this._total === 0 || this._loaded >= this._total) return Promise.resolve();
        return new Promise((resolve) => this._settleWaiters.push(resolve));
    }

    /** @returns {Promise<THREE.Group>} */
    loadFBX(url) {
        return new Promise((resolve, reject) => {
            this.fbx.load(
                url,
                resolve,
                (event) => {
                    if (event.lengthComputable) this._onProgress?.(event.loaded / event.total, url);
                },
                reject
            );
        });
    }

    /** @returns {Promise<THREE.Texture>} */
    loadTexture(url) {
        return new Promise((resolve, reject) => {
            this.texture.load(url, resolve, undefined, reject);
        });
    }

    /** @returns {Promise<THREE.DataTexture>} */
    loadHDR(url) {
        return new Promise((resolve, reject) => {
            this.hdr.load(url, resolve, undefined, reject);
        });
    }
}
