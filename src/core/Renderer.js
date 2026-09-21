import { WebGLRenderer, PCFSoftShadowMap, ACESFilmicToneMapping, SRGBColorSpace } from 'three';
import { settings } from '../config/settings.js';

/**
 * 对 WebGLRenderer 的薄封装，负责画布尺寸、像素比预算，
 * 以及应用其余部分从不触碰的那些渲染质量开关。
 */
export class Renderer {
    constructor(canvas) {
        this.gl = new WebGLRenderer({
            canvas,
            antialias: true,
            powerPreference: 'high-performance',
            stencil: false,
            alpha: false,
        });

        this.gl.setPixelRatio(this.targetPixelRatio());
        this.gl.setSize(window.innerWidth, window.innerHeight, false);

        this.gl.shadowMap.enabled = true;
        this.gl.shadowMap.type = PCFSoftShadowMap;
        // 一帧里场景会被渲染好几次（深度预通道、扭曲、接触阴影、主通道）。
        // 自动更新会为每一次都重建级联阴影贴图，所以改由应用每帧
        // 只标记一次更新。
        this.gl.shadowMap.autoUpdate = false;

        // 色调映射由后处理管线的 OutputPass 执行，它会从渲染器上
        // 读取下面这两个属性。
        this.gl.toneMapping = ACESFilmicToneMapping;
        this.gl.toneMappingExposure = settings.post.exposure;
        this.gl.outputColorSpace = SRGBColorSpace;

        this.gl.info.autoReset = false;

        this._onResize = null;
    }

    /** 限制像素比：4K 加上大量透明，填充率上并不划算。 */
    targetPixelRatio() {
        return Math.min(window.devicePixelRatio || 1, 1.75);
    }

    get domElement() {
        return this.gl.domElement;
    }

    get size() {
        return this.gl.getSize({ width: 0, height: 0 });
    }

    onResize(callback) {
        this._onResize = callback;
        window.addEventListener('resize', this.handleResize, { passive: true });
    }

    handleResize = () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.gl.setPixelRatio(this.targetPixelRatio());
        this.gl.setSize(w, h, false);
        this._onResize?.(w, h, this.gl.getPixelRatio());
    };

    /** 每帧渲染前调用一次，好让编辑器可以驱动曝光。 */
    syncSettings() {
        this.gl.toneMappingExposure = settings.post.exposure;
    }

    dispose() {
        window.removeEventListener('resize', this.handleResize);
        this.gl.dispose();
    }
}
