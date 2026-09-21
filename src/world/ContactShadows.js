import {
    Group,
    Mesh,
    PlaneGeometry,
    MeshBasicMaterial,
    MeshDepthMaterial,
    ShaderMaterial,
    OrthographicCamera,
    WebGLRenderTarget,
    Color,
} from 'three';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';

/**
 * 柔和的接触阴影。
 *
 * 太阳阴影由（级联）阴影贴图负责，但它分辨不出角色脚下那种紧贴的、
 * 类似环境光遮蔽（AO）的变暗。这里从下方把角色的深度渲染进一个小渲染
 * 目标，模糊两遍，再投影回地面——这就是标准的"接触阴影"技巧，每帧花费
 * 三个 256px 的渲染 pass。
 */
export class ContactShadows {
    /**
     * 【详解】搭建接触阴影的全套离屏装置，五部分：
     * 1. group 整体抬离地面 0.015 m：承接片与地板平行贴近，不留空隙会
     *    z-fighting（深度闪烁），抬高一点既看不出又避开冲突；
     * 2. 两张 256² 渲染目标（renderTarget / renderTargetBlur）：交替承担
     *    双向模糊，关 mipmap（RT 不需要）；
     * 3. 承接片 plane：2.6 m 见方的半透明面片，直接以 RT 纹理为 map，
     *    scale.y=-1 校正投影朝向，renderOrder=1 保证最后绘制，depthWrite
     *    关掉避免影响后续透明排序，toneMapped=false 让阴影浓度不受色调
     *    映射影响；
     * 4. shadowCamera：朝下（绕 x 转 90°）的正交相机，视高 0..height，
     *    只看 LAYER.CONTACT 层——全场景只有角色在该层，地板不在（否则
     *    地板会自己挡住自己，RT 里全是地板的深度）；
     * 5. blurPlane + 两个模糊材质 + depthMaterial：模糊用全屏四边形走
     *    shadowCamera 渲染（必须在该相机 layer 上且落在视锥内，否则静默
     *    画空、承接片变成纯黑方块）；depthMaterial 改写深度输出——画黑色、
     *    透明度由深度决定（越近越暗），darkness=0.8 控制整体浓度。
     */
    constructor(renderer, { size = 5.5, resolution = 256, height = 3.2, blur = 2.4 } = {}) {
        this.renderer = renderer;
        this.size = size;
        this.blurAmount = blur;

        this.group = new Group();
        this.group.position.y = 0.015;

        this.renderTarget = new WebGLRenderTarget(resolution, resolution);
        this.renderTarget.texture.generateMipmaps = false;
        this.renderTargetBlur = new WebGLRenderTarget(resolution, resolution);
        this.renderTargetBlur.texture.generateMipmaps = false;

        const planeGeometry = new PlaneGeometry(size, size).rotateX(Math.PI / 2);

        this.plane = new Mesh(
            planeGeometry,
            new MeshBasicMaterial({
                map: this.renderTarget.texture,
                transparent: true,
                opacity: settings.environment.contactShadow,
                depthWrite: false,
                toneMapped: false,
            })
        );
        // 翻转缩放，使投影纹理与场景朝向一致。
        this.plane.scale.y = -1;
        this.plane.renderOrder = 1;
        this.plane.layers.set(LAYER.WORLD);
        this.group.add(this.plane);

        this.shadowCamera = new OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
        this.shadowCamera.rotation.x = Math.PI / 2;
        // 只捕获显式标记为接触阴影投射者的对象（角色）——否则地板会
        // 自己遮挡自己。
        this.shadowCamera.layers.set(LAYER.CONTACT);
        this.group.add(this.shadowCamera);

        // 两个模糊 pass 用的全屏四边形。它单独渲染（不作为场景的一部
        // 分），但仍然通过 `shadowCamera` 渲染——所以它必须位于相机的 layer
        // 上，且处在相机 0..height 的视锥范围之内，否则模糊会静默地什么都
        // 画不出来，承接阴影的平面最终变成一块不透明的黑方块。把它挂在
        // group 上可以让它始终对中相机。
        this.blurPlane = new Mesh(planeGeometry);
        this.blurPlane.visible = false;
        this.blurPlane.position.y = height * 0.5;
        this.blurPlane.layers.set(LAYER.CONTACT);
        this.group.add(this.blurPlane);

        this.depthMaterial = new MeshDepthMaterial();
        this.depthMaterial.userData.darkness = { value: 0.8 };
        this.depthMaterial.onBeforeCompile = (shader) => {
            shader.uniforms.darkness = this.depthMaterial.userData.darkness;
            shader.fragmentShader = shader.fragmentShader
                .replace('void main() {', 'uniform float darkness;\nvoid main() {')
                .replace(
                    'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
                    'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );'
                );
        };
        this.depthMaterial.depthTest = false;
        this.depthMaterial.depthWrite = false;

        this.horizontalBlur = new ShaderMaterial(HorizontalBlurShader);
        this.verticalBlur = new ShaderMaterial(VerticalBlurShader);
        this.horizontalBlur.depthTest = false;
        this.verticalBlur.depthTest = false;

        this._clearColor = new Color();
    }

    /** 让阴影承接平面始终保持在角色脚下。
     * 【详解】group 内三件东西（承接片、相机、模糊面片）跟着一起平移——
     * 阴影因此永远以角色为中心。App.frame() 每帧以角色位置调用。 */
    setPosition(x, z) {
        this.group.position.x = x;
        this.group.position.z = z;
    }

    /**
     * 【详解】每帧在主渲染之前调用（App.frame()），分四步走标准的接触阴影
     * 流程：
     * 1. 早退：强度 contactShadow ≤ 0.001 时直接返回，省掉整个 RT 流程；
     * 2. 备份并改造渲染状态——场景背景置空、overrideMaterial 换成
     *    depthMaterial（整景只画"角色深度"）、隐藏承接片自身（它若在画面里
     *    会把自己的深度也画进去）、autoClear 打开；
     * 3. 绑定 RT、以*透明*黑清屏（承接片直接采样这张纹理，不透明清屏会在
     *    地上画出黑方块），用 shadowCamera（只看得见 LAYER.CONTACT 的角色）
     *    渲一帧深度；
     * 4. 恢复 overrideMaterial，做两遍模糊——粗 blurAmount + 细 0.35×，
     *    先柔化轮廓再收贴脚感——然后恢复清屏色、解绑 RT、恢复 autoClear
     *    与场景背景，重新显示承接片。全程不动主相机，成本恒定三个 256px pass。
     */
    render(scene) {
        const gl = this.renderer.gl;
        const strength = settings.environment.contactShadow;
        this.plane.material.opacity = strength;
        if (strength <= 0.001) return;

        const previousBackground = scene.background;
        const previousOverride = scene.overrideMaterial;
        const previousAutoClear = gl.autoClear;
        gl.getClearColor(this._clearColor);
        const previousAlpha = gl.getClearAlpha();

        scene.background = null;
        scene.overrideMaterial = this.depthMaterial;
        this.plane.visible = false;
        gl.autoClear = true;

        gl.setRenderTarget(this.renderTarget);
        // 清屏为*透明*黑：承接平面直接采样这张纹理，如果不透明清屏，
        // 就会在地面上画出一块黑色方块。下面的模糊 pass 出于同样的原因
        // 沿用同一个清屏值。
        gl.setClearColor(0x000000, 0);
        gl.clear();
        gl.render(scene, this.shadowCamera);

        scene.overrideMaterial = previousOverride;
        this._blur(this.blurAmount);
        this._blur(this.blurAmount * 0.35);
        gl.setClearColor(this._clearColor, previousAlpha);

        gl.setRenderTarget(null);
        gl.autoClear = previousAutoClear;
        scene.background = previousBackground;
        this.plane.visible = true;
    }

    /**
     * 【详解】一轮双向高斯模糊：水平 pass 读 renderTarget 写 renderTargetBlur，
     * 垂直 pass 再读回来写 renderTarget——两张 RT 乒乓交替。模糊半径
     * h/v = amount ÷ 256（256 是 RT 边长），所以 amount 以"像素"为单位。
     * blurPlane 平时隐藏，只在模糊期间临时显示，用完立刻藏回（它若留在
     * 场景里会被主相机看到）。render() 会调两遍本方法：blurAmount 与
     * 0.35×blurAmount，先粗后细——粗模糊柔化硬边，细模糊补柔和度，
     * 两遍叠加比单遍大半径更省且轮廓更自然。
     */
    _blur(amount) {
        const gl = this.renderer.gl;

        this.blurPlane.visible = true;

        this.blurPlane.material = this.horizontalBlur;
        this.horizontalBlur.uniforms.tDiffuse.value = this.renderTarget.texture;
        this.horizontalBlur.uniforms.h.value = (amount * 1) / 256;
        gl.setRenderTarget(this.renderTargetBlur);
        gl.render(this.blurPlane, this.shadowCamera);

        this.blurPlane.material = this.verticalBlur;
        this.verticalBlur.uniforms.tDiffuse.value = this.renderTargetBlur.texture;
        this.verticalBlur.uniforms.v.value = (amount * 1) / 256;
        gl.setRenderTarget(this.renderTarget);
        gl.render(this.blurPlane, this.shadowCamera);

        this.blurPlane.visible = false;
    }

    dispose() {
        this.renderTarget.dispose();
        this.renderTargetBlur.dispose();
        this.plane.geometry.dispose();
        this.plane.material.dispose();
        this.depthMaterial.dispose();
        this.horizontalBlur.dispose();
        this.verticalBlur.dispose();
    }
}
