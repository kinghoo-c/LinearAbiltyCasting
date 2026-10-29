import { Mesh, PlaneGeometry, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Vector2 } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

/** 地板平面的边长（单位：米）——贴图的平铺重复次数由它推算。 */
const PLANE_SIZE = 800;

/**
 * 装饰地板的石材贴图：ambientCG Rock030（CC0 协议），粗糙的自然岩石
 * 平铺纹理。颜色（color）图按 sRGB 制作；其余贴图为线性数据。
 */
const TEXTURE_URLS = {
    map: './textures/cathedral/color.jpg',
    normalMap: './textures/cathedral/normal.jpg',
    roughnessMap: './textures/cathedral/roughness.jpg',
    aoMap: './textures/cathedral/ao.jpg',
};

/**
 * 舞台地板。
 *
 * 刻意保持绝对平面（y = 0）：画路径的射线检测、每个技能、地面喷发，
 * 全都假设表面是平面；纯平面让这些交互是精确的。
 *
 * 基底是平铺的石板（见 `TEXTURE_URLS`），并向冷色舞台调色板调色，
 * 让它读起来像城堡岩石，而不是日光下的庭院。在采样得到的反照率（albedo）
 * 之上，着色器保留了让地板"坐进"这个场景的两样东西：一是朝 `floorTint`
 * 的保持亮度（luminance-preserving）的色调调整，二是径向光池——它让舞台
 * 中心清晰可读，并在远未到达平面边缘之前就把地板沉入背景。当贴图被
 * 关闭（或尚未加载）时，同一个着色器会回退到最初的程序化石纹，因此
 * 一切都不依赖贴图下载成功。
 */
export class Ground {
    /**
     * 【详解】构建舞台地板，五个步骤：
     * 1. 基底材质 MeshStandardMaterial：白色（反照率交给着色器算）、
     *    roughness 0.88、metalness 0、开 dithering 防暗部色带；
     *    normalScale 双分量设置好（当前无贴图，暂不生效，切贴图后立即可用）；
     * 2. 定义六个自定义 uniform：地板双色、贴图调色强度、sheen 光泽、
     *    径向光池强度、时间；
     * 3. 通过 environment.registerShadowCasterWithPatch 注入着色器——
     *    顶点阶段新增 varying vGroundWorld（世界坐标，让片元噪声按"米"采样，
     *    与 UV 无关）；片元阶段在 map_fragment 后做贴图调色/程序化石纹+光池，
     *    在 roughnessmap_fragment 后做 fbm 斑块抛光（sheen）；
     * 4. 建 400×400 m 平面，转到 y=0，只收阴影不投影；关闭矩阵自动更新
     *    （静态物体，updateMatrix 一次后省掉每帧矩阵计算）；
     * 5. this.group 直接指向 mesh——与技能特效系统的 group 约定保持一致，
     *    调用方可以统一用 group 挂场景。
     */
    constructor(environment) {
        this.environment = environment;

        this.material = new MeshStandardMaterial({
            color: 0xffffff,
            roughness: settings.environment.floorRoughness,
            metalness: 0.0,
            dithering: true,
        });
        this.material.normalScale = new Vector2(
            settings.environment.floorNormalScale,
            settings.environment.floorNormalScale
        );

        /** 四张石材贴图，由 `loadTextures` 填充；在此之前为 null。 */
        this.textures = null;
        this._textured = false;

        this.uniforms = {
            uFloorColor: { value: getColor(settings.environment.floorColor).clone() },
            uFloorTint: { value: getColor(settings.environment.floorTint).clone() },
            uTexTint: { value: settings.environment.floorTexTint },
            uSheen: { value: settings.environment.floorSheen },
            uPool: { value: settings.environment.floorPool },
            uTime: { value: 0 },
        };

        /**
         * 【详解】把地板的自定义着色器挂进这个内置材质。
         *
         * 为什么是这个入口：名字里的 "shadow caster" 是阴影系统换代留下的——
         * 项目早期用 CSM（级联阴影）时，每个材质都必须显式注册，否则会静默
         * 丢掉全部方向光；如今阴影换成 three 原生的方向光贴图，标准材质默认
         * 就能接收太阳光，注册那一半已经空转（`registerShadowCaster` 就是同一个
         * 接口的纯空实现，见 Environment）。这里真正剩下的只有"改写着色器"，
         * 所以它等价于 patchOnBeforeCompile(material, patch)。
         *
         * 为什么不直接写 `material.onBeforeCompile = ...`：patchOnBeforeCompile
         * 会先跑材质上已有的回调、再跑本补丁，是**串接**而不是覆盖，于是在同一
         * 个内置材质上共存的多种改写（IceMaterial、MeteorMaterial、地板）谁也
         * 不会把谁顶掉；日后阴影实现再变一次，调用方也不必跟着改。
         *
         * 何时执行：three 在材质每次编译着色器时调用它（对地板来说就是 App.load()
         * 里那次 compileAsync 预热），传入组装好的 shader 对象。下面做两件事——
         * 一是把本类的六个 uniform **按引用**挂进 shader.uniforms，所以 update()
         * 每帧只改 `.value` 即可生效，永不触发重编译；二是把 GLSL 插进标准 chunk
         * 的锚点：顶点阶段带出世界坐标 varying `vGroundWorld`，片元阶段在
         * map_fragment 与 roughnessmap_fragment 之后接上石纹 / 调色 / 径向光池 /
         * 斑块光泽。
         *
         * 注意：翻转 USE_MAP 宏（`settings.environment.floorTexture` 开关）会重新编译，这段补丁
         * 于是会再执行一次——里面只是幂等的字符串替换与 uniform 挂载，重复执行
         * 没有副作用。锚点是 three 内部的 chunk 名，升级 three 时要留意它们是否
         * 还在（utils/shaderPatch.js 的 replaceChunk 会为这种情况告警，这里用的
         * 是原生 replace，失效是静默的）。
         */
        environment.registerShadowCasterWithPatch(this.material, (shader) => {
            shader.uniforms.uFloorColor = this.uniforms.uFloorColor;
            shader.uniforms.uFloorTint = this.uniforms.uFloorTint;
            shader.uniforms.uTexTint = this.uniforms.uTexTint;
            shader.uniforms.uSheen = this.uniforms.uSheen;
            shader.uniforms.uPool = this.uniforms.uPool;
            shader.uniforms.uTime = this.uniforms.uTime;

            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\nvarying vec3 vGroundWorld;`)
                .replace(
                    '#include <begin_vertex>',
                    `#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
                );

            shader.fragmentShader = shader.fragmentShader
                .replace(
                    '#include <common>',
                    `#include <common>
           varying vec3 vGroundWorld;
           uniform vec3 uFloorColor;
           uniform vec3 uFloorTint;
           uniform float uTexTint;
           uniform float uSheen;
           uniform float uPool;
           uniform float uTime;
           ${noiseGLSL}`
                )
                .replace(
                    '#include <map_fragment>',
                    `#include <map_fragment>
           {
             vec3 wp = vGroundWorld;

             #ifdef USE_MAP
               // 石头的反照率已经在 diffuseColor 里了。把它向冷色舞台
               // 色调调色，同时不把亮度压暗：把 tint 归一化到单位亮度，只
               // 偏移色相，明度则交给下面的光池来处理。
               vec3 tint = uFloorTint;
               float tl = max(1e-4, dot(tint, vec3(0.299, 0.587, 0.114)));
               vec3 graded = diffuseColor.rgb * (tint / tl);
               diffuseColor.rgb = mix(diffuseColor.rgb, graded, clamp(uTexTint, 0.0, 1.0));
             #else
               // 无贴图：最初的程序化暗色石材。宽阔而平滑的变化，其
               // 中漂着一层更暖的色调——频率再高一点就会读作砂砾，破坏
               // 干净的观感。
               float macro = fbm3(wp * 0.018);
               float tintMask = smoothstep(-0.5, 0.6, macro);
               vec3 base = mix(uFloorColor, uFloorTint, tintMask * 0.5);
               base *= 1.0 + fbm3(wp * 0.09 + 11.0) * 0.05;
               base *= 1.0 + (snoise01(wp * 0.7) - 0.5) * 0.06;
               diffuseColor.rgb *= base;
             #endif

             // 径向光池：舞台中心保持清晰可读，地板在远未到达平面
             // 边缘之前就已沉入背景。两条路径（有贴图 / 无贴图）共用这
             // 段代码，因为它正是把地板"焊接"进场景的东西。
             float dist = length(wp.xz);
             float pool = mix(1.0, smoothstep(40.0, 5.0, dist), clamp(uPool, 0.0, 1.0));
             diffuseColor.rgb *= mix(0.18, 1.0, pool);
           }`
                )
                .replace(
                    '#include <roughnessmap_fragment>',
                    `#include <roughnessmap_fragment>
           {
             // 打散光泽（sheen）：大块更光滑的石面能接住主光和元素
             // 辉光的高光，其余部分保持哑光。若存在粗糙度贴图，这段逻辑
             // 叠加在贴图之上。
             float polish = smoothstep(0.3, 0.85, fbm3(vGroundWorld * 0.06 + 3.0) * 0.5 + 0.5);
             roughnessFactor *= mix(1.0, 0.45, polish * clamp(uSheen, 0.0, 1.0));
           }`
                );
        });

        this.mesh = new Mesh(new PlaneGeometry(PLANE_SIZE, PLANE_SIZE, 1, 1), this.material);
        this.mesh.rotation.x = -Math.PI / 2;
        this.mesh.receiveShadow = true;
        this.mesh.castShadow = false;
        this.mesh.name = 'Ground';
        this.mesh.layers.set(LAYER.WORLD);
        this.mesh.matrixAutoUpdate = false;
        this.mesh.updateMatrix();

        this.group = this.mesh;
    }

    /**
     * 加载石材贴图并挂载。在启动期间调用，使贴图在着色器编译之前就
     * 位——避免首次施放时的重编译——但如果这一步被跳过或失败，地面也能
     * 正常渲染（程序化回退）。
     * 【详解】由 App.load() 在启动时调用一次。四张贴图并发加载（Promise.all）
     * 后统一做三件事：设 RepeatWrapping（允许平铺）、各向异性过滤取硬件上限
     * （斜视角度不糊）、颜色图标记 sRGB（TextureLoader 默认按线性读，其余
     * 三张保持线性）。随后应用平铺，并按设置决定挂不挂贴图（默认不挂 →
     * 走程序化石纹路径）。
     *
     * @param {import('../loaders/AssetLoader.js').AssetLoader} assets 资源加载器
     */
    async loadTextures(assets) {
        const entries = await Promise.all(
            Object.entries(TEXTURE_URLS).map(async ([slot, url]) => [slot, await assets.loadTexture(url)])
        );

        const maxAniso = this.environment.renderer?.gl.capabilities.getMaxAnisotropy?.() ?? 1;
        const textures = {};
        for (const [slot, texture] of entries) {
            texture.wrapS = RepeatWrapping;
            texture.wrapT = RepeatWrapping;
            texture.anisotropy = maxAniso;
            // TextureLoader 默认按线性数据处理；只有颜色图是按 sRGB 制作的。
            if (slot === 'map') texture.colorSpace = SRGBColorSpace;
            textures[slot] = texture;
        }

        this.textures = textures;
        this._applyTiling();
        this._setTextured(settings.environment.floorTexture);
    }

    /**
     * 让所有贴图使用同一个平铺参数，由"每块瓦多少米"推算。只改动
     * repeat——它会进入贴图的 UV 矩阵（每帧渲染时自动更新），因此不会重新
     * 上传图像数据，每帧调用也是安全的。
     * 【详解】repeat = 平面边长(400) ÷ 每块瓦米数(12)，四张图共用同一 repeat，
     * 保证颜色/法线/粗糙度/AO 完全对齐。结果缓存在 _repeat，没变就早退；
     * 改 repeat 只更新 UV 矩阵（矩阵每帧自动上传），不触碰图像数据，
     * 所以 update() 每帧调用它也没有开销。
     */
    _applyTiling() {
        if (!this.textures) return;
        const repeat = PLANE_SIZE / Math.max(0.1, settings.environment.floorTextureScale);
        if (repeat === this._repeat) return;
        this._repeat = repeat;
        for (const texture of Object.values(this.textures)) texture.repeat.set(repeat, repeat);
    }

    /** 挂上或摘除石材贴图。切换这个开关会触发一次重编译（USE_MAP 宏）。
     * 【详解】给材质的四个贴图槽（map/normalMap/roughnessMap/aoMap）同时挂图
     * 或置 null，然后 needsUpdate=true 触发一次重编译——USE_MAP 宏翻转，着色器
     * 在"贴图路径"与"程序化石纹路径"之间切换。_textured 记录当前状态，状态
     * 没变就早退，避免重复重编译（重编译会造成一次明显卡顿）。 */
    _setTextured(on) {
        if (!this.textures || on === this._textured) return;
        for (const slot of Object.keys(TEXTURE_URLS)) {
            this.material[slot] = on ? this.textures[slot] : null;
        }
        this.material.needsUpdate = true;
        this._textured = on;
    }

    /**
     * 【详解】每帧由 App.frame() 调用，把 settings 同步到地面（编辑器实时
     * 可调）：时间写进 uTime（当前着色器未用到，属于预留）；地板双色、贴图
     * 调色强度、sheen、光池四个 uniform；材质粗糙度与 normalScale。贴图存在
     * 时再同步平铺与开关。所有写入都只是 uniform 上传或属性赋值，不触发
     * 重编译。参数 elapsed 是累计秒数（暂停时不走表）。
     */
    update(elapsed) {
        const env = settings.environment;
        this.uniforms.uTime.value = elapsed;
        this.uniforms.uFloorColor.value.copy(getColor(env.floorColor));
        this.uniforms.uFloorTint.value.copy(getColor(env.floorTint));
        this.uniforms.uTexTint.value = env.floorTexTint;
        this.uniforms.uSheen.value = env.floorSheen;
        this.uniforms.uPool.value = env.floorPool;
        this.material.roughness = env.floorRoughness;
        this.material.normalScale.set(env.floorNormalScale, env.floorNormalScale);

        if (this.textures) {
            this._applyTiling();
            this._setTextured(env.floorTexture);
        }
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
        if (this.textures) {
            for (const texture of Object.values(this.textures)) texture.dispose();
        }
    }
}
