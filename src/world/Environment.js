import {
    Scene,
    Fog,
    Vector3,
    Object3D,
    AmbientLight,
    HemisphereLight,
    DirectionalLight,
    EquirectangularReflectionMapping,
    PMREMGenerator,
} from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { frame } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

const _sunDir = new Vector3();

/** 阴影区域的一半宽度（单位：米），以战斗（角色）位置为中心。 */
const SHADOW_EXTENT = 26;

/**
 * 场景、大气与光照。
 *
 * 视觉目标是一个暗色电影舞台，而非户外旷野：一盏暖色主光（key）、
 * 一道来自背后的冷色轮廓光（rim）、几乎没有补光，再加一道颜色与纯色背景
 * 一致的雾，让地板在远处"溶入"虚空。HDR 探针仍会加载，但只作为（压暗的）
 * 图像光照（IBL）和水面 / 风着色器的反射源——绝不作为可见天空。
 *
 * 太阳阴影使用一盏方向光，其正交阴影相机每帧重新对中角色，并紧贴
 * 战斗区域。4096² 贴图覆盖 52 米的盒子，约每纹素（texel）1.3 厘米——比
 * three 的级联（cascade）拆分在这里能达到的清晰度更高，且没有那样的
 * 开销与复杂度。
 *
 * （早期版本用过 CSM 插件。它会*全局*替换 three 的
 * `lights_fragment_begin` 着色器代码块，这意味着场景中所有材质都会
 * 静默丢失全部方向光，除非逐个向 CSM 注册——对于这么小的战斗区域，
 * 这个"坑"不值得踩。）
 */
export class Environment {
    /**
     * @param {import('../core/Renderer.js').Renderer} renderer 渲染器（Renderer 包装类）
     * @param {THREE.PerspectiveCamera} camera 透视相机
     * 【详解】构建舞台环境，依次完成六件事：
     * 1. 创建全局唯一的 Scene，设置纯色暗背景与线性雾（雾色与背景同色，
     *    使远处地板"溶入"背景，永远看不到平面边缘）；
     * 2. 创建 AmbientLight 与 HemisphereLight 两盏弱补光，保证暗部不死黑；
     * 3. 创建太阳主光：开启阴影，4096² 阴影贴图，±26 m 正交阴影相机
     *    （约 1.3 cm/texel），并调用 updateProjectionMatrix 使新相机范围生效；
     * 4. 创建 rim 冷轮廓光（不投影），其 target 指向 rimTarget；
     * 5. 把所有灯和 target 对象一起挂进 Scene——方向光的 target 必须在同一
     *    场景图里，它的矩阵才会被更新，灯才会真正瞄准；
     * 6. 初始化 focus（灯与阴影的跟随点）、_envMap/_pmrem（HDR 资源占位）、
     *    _rimDir（复用的临时方向向量，避免每帧新建产生 GC）。
     */
    constructor(renderer, camera) {
        this.renderer = renderer;
        this.camera = camera;

        this.scene = new Scene();
        // 纯色暗背景；保存在自有的 Color 实例里，以便编辑器驱动它。
        this._bgColor = getColor(settings.environment.backgroundColor).clone();
        this.scene.background = this._bgColor;
        // 保存在自有的 Fog 实例里，以便编辑器驱动它的颜色与范围；
        // 也可以把它从 scene 上直接摘除，从而彻底关闭雾。
        this._fog = new Fog(
            getColor(settings.environment.fogColor).clone(),
            settings.environment.fogNear,
            settings.environment.fogFar
        );
        this.scene.fog = settings.environment.fogEnabled ? this._fog : null;

        this.ambient = new AmbientLight(
            getColor(settings.environment.ambientColor).clone(),
            settings.environment.ambientIntensity
        );
        this.hemi = new HemisphereLight(
            getColor(settings.environment.hemiSkyColor).clone(),
            getColor(settings.environment.hemiGroundColor).clone(),
            settings.environment.hemiIntensity
        );

        this.sun = new DirectionalLight(
            getColor(settings.environment.sunColor).clone(),
            settings.environment.sunIntensity
        );
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.set(4096, 4096);
        this.sun.shadow.bias = settings.environment.shadowBias;
        this.sun.shadow.normalBias = 0.035;
        this.sun.shadow.radius = settings.environment.shadowRadius;

        const shadowCamera = this.sun.shadow.camera;
        shadowCamera.left = -SHADOW_EXTENT;
        shadowCamera.right = SHADOW_EXTENT;
        shadowCamera.top = SHADOW_EXTENT;
        shadowCamera.bottom = -SHADOW_EXTENT;
        shadowCamera.near = 0.5;
        shadowCamera.far = 140;
        shadowCamera.updateProjectionMatrix();

        /** 灯光瞄准这个对象；两者一起移动，以跟随战斗位置。 */
        this.sunTarget = new Object3D();

        /**
         * 从舞台后方打来的冷色分离光。不产生阴影：它存在的唯一目的，
         * 是在角色和特效周围勾出一圈亮边，让它们不会融进暗色背景之中。
         */
        this.rim = new DirectionalLight(
            getColor(settings.environment.rimColor).clone(),
            settings.environment.rimIntensity
        );
        this.rimTarget = new Object3D();
        this.rim.target = this.rimTarget;

        this.scene.add(this.ambient, this.hemi, this.sun, this.sunTarget, this.rim, this.rimTarget);
        this.sun.target = this.sunTarget;

        this.focus = new Vector3();
        this._envMap = null;
        this._pmrem = null;
        this._rimDir = new Vector3();
    }

    /**
     * 加载 HDR 探针。它为场景提供光照（IBL），但刻意*不*用作背景——
     * 舞台保持其纯色暗背景。
     * 【详解】流程：PMREMGenerator 先预编译等距柱状着色器 → 把 HDR 贴图标记为
     * 等距柱状映射 → 生成预滤波的 mip 立方体贴图 → 挂到 scene.environment
     * 并用 envIntensity(0.32) 压暗，贴合"暗色舞台"的基调。原始 HDR 同时存到
     * this.equirect，供自定义水面/风着色器做廉价的假反射（它们用不了 PMREM
     * 立方体）。用完立即销毁 PMREM 生成器（它只占 GPU 内存，留着无用）。
     * 由 App.load() 在启动时调用一次，此后 IBL 常驻。
     */
    async loadEnvironment(hdrTexture) {
        this._pmrem = new PMREMGenerator(this.renderer.gl);
        this._pmrem.compileEquirectangularShader();

        hdrTexture.mapping = EquirectangularReflectionMapping;
        const target = this._pmrem.fromEquirectangular(hdrTexture);

        this._envMap = target.texture;
        this.scene.environment = this._envMap;
        this.scene.environmentIntensity = settings.environment.envIntensity;

        // 保留为等距柱状（equirect）贴图源，供自定义水面 / 风着色器内部
        // 做廉价的假反射（它们无法直接使用 PMREM 立方体贴图）。
        this.equirect = hdrTexture;

        this._pmrem.dispose();
        this._pmrem = null;
    }

    /**
     * 让材质加入场景的阴影设置。
     *
     * 现在已经什么都不用做了——标准材质默认就能接收太阳光——但仍
     * 保留这个钩子，以便阴影实现今后再次变更时，调用方无需关心。
     * 【详解】历史遗留接口：早期的阴影实现（CSM）要求每个材质显式注册
     * 才能接收方向光；如今用 three 原生阴影，标准材质默认收光，所以这里
     * 原样返回。保留它是为了让各技能的材质注册处不用跟着阴影实现一起改。
     */
    registerShadowCaster(material) {
        return material;
    }

    /** 注册材质，并向其注入自定义着色器代码。
     * 【详解】在保留材质原有 onBeforeCompile（若有）的前提下，再叠加一层
     * patch 回调——patchOnBeforeCompile 会把新旧回调串成调用链，避免互相
     * 覆盖。Ground 用它往内置 MeshStandardMaterial 里注入自定义 uniform
     * 与 GLSL，得到"标准光照 + 自定义外观"的混合材质。 */
    registerShadowCasterWithPatch(material, patch) {
        patchOnBeforeCompile(material, patch);
        return material;
    }

    /** 让阴影视锥体始终对中战斗位置。
     * 【详解】只记录 xz 平面的跟随点（y 恒为 0）。真正的灯位与 target 摆放
     * 在 update() 里以 focus 为基准完成。App.frame() 每帧用角色位置调用它。 */
    setFocus(x, z) {
        this.focus.set(x, 0, z);
    }

    /** 光的传播方向（从灯指向场景）。
     * 【详解】由方位角 azimuth（绕 y 轴，弧度）与仰角 elevation（离地高度角，
     * 弧度）求光的行进方向：水平分量取 cos/sin(azimuth)，垂直分量取
     * sin(elevation)，整体取负后归一化。结果写入传入的 out 向量复用，避免
     * 每帧分配新对象。注意返回值是"光行进方向"，灯的实际位置要在焦点基础
     * 上减去 70×该向量（见 update()）。 */
    _computeLightDirection(out, azimuth, elevation) {
        const cosE = Math.cos(elevation);
        out.set(-Math.cos(azimuth) * cosE, -Math.sin(elevation), -Math.sin(azimuth) * cosE);
        return out.normalize();
    }

    /**
     * 【详解】每帧由 App.frame() 调用，把 settings（编辑器可实时改）同步到
     * 场景，分五组：
     * 1. 灯位：重算太阳方向，sunTarget 对准 focus，太阳本体停在焦点逆方向
     *    70 m 处——52 m 阴影盒因此永远罩住战斗区；rim 同理（40 m）；
     * 2. 共享 uniform：把主光方向取反（指向光源）写入 frame.uLightDir，
     *    供那些自行伪造法线的自定义着色器与场景光照保持一致；
     * 3. 灯光参数：太阳/rim 的颜色、强度，太阳的阴影半径与 bias；
     * 4. 补光与 IBL：ambient/hemi 的强度与颜色、环境贴图整体强度、背景色；
     * 5. 雾：开关通过 scene.fog 挂/摘实现（翻转 FOG 宏，代价一次重编译，
     *    仅编辑器切换时触发），颜色与 near/far 直接改自有的 _fog 实例。
     */
    update() {
        const env = settings.environment;

        this._computeLightDirection(_sunDir, env.sunAzimuth, env.sunElevation);

        // 把灯停在焦点沿光线反方向（"向日"一侧）70 米处，使阴影视锥体
        // 永远罩住战斗区域。
        this.sunTarget.position.copy(this.focus);
        this.sun.position.copy(this.focus).addScaledVector(_sunDir, -70);

        // 把主光方向交给那些自行伪造法线的自定义着色器。
        frame.uLightDir.value.copy(_sunDir).negate();

        this.sun.intensity = env.sunIntensity;
        this.sun.color.copy(getColor(env.sunColor));
        this.sun.shadow.radius = env.shadowRadius;
        this.sun.shadow.bias = env.shadowBias;

        this._computeLightDirection(this._rimDir, env.rimAzimuth, env.rimElevation);
        this.rimTarget.position.copy(this.focus);
        this.rim.position.copy(this.focus).addScaledVector(this._rimDir, -40);
        this.rim.intensity = env.rimIntensity;
        this.rim.color.copy(getColor(env.rimColor));

        this.ambient.intensity = env.ambientIntensity;
        this.ambient.color.copy(getColor(env.ambientColor));
        this.hemi.intensity = env.hemiIntensity;
        this.hemi.color.copy(getColor(env.hemiSkyColor));
        this.hemi.groundColor.copy(getColor(env.hemiGroundColor));

        this.scene.environmentIntensity = env.envIntensity;

        this._bgColor.copy(getColor(env.backgroundColor));

        // 挂上 / 摘除雾会翻转着色器里的 FOG 宏定义，因此切换的代价是
        // 一次重编译——对编辑器开关来说无所谓，而一直保持开启则毫无开销。
        this.scene.fog = env.fogEnabled ? this._fog : null;
        this._fog.color.copy(getColor(env.fogColor));
        this._fog.near = env.fogNear;
        this._fog.far = env.fogFar;
    }

    dispose() {
        this._envMap?.dispose();
        this.equirect?.dispose();
        this.sun.shadow.dispose();
    }
}
