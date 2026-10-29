import GUI from 'lil-gui';
import { Color } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Ground } from '../world/Ground.js';
import { DustMotes } from '../world/DustMotes.js';
import { ContactShadows } from '../world/ContactShadows.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { CharacterController } from '../animation/CharacterController.js';

import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { LoadingScreen } from '../ui/HUD.js';

import { settings } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

/**
 * 后处理调色 pass 每帧读一次闪光状态；这个场景没有任何技能会触发闪光，
 * 所以恒定传零，省掉一个 ScreenFlash 实例。
 */
const NO_FLASH = { strength: 0, color: new Color(1, 1, 1) };

/**
 * 应用根节点（场景演示版）：只保留周围环境与中间角色的加载与展示。
 *
 * 与 `App` 相比，技能、瞄准、输入、HUD 与特效池一概不在——每帧只剩下把
 * settings 同步进环境与地板、驱动角色的待机动画、渲染三步。相机仍由
 * `CameraRig` 自己监听右键拖拽与滚轮，角色站在原地循环呼吸，等待在这套
 * 干净的舞台上长出新的内容。
 *
 * lil-gui 只保留 `Environment` 一节：那些控件全都直接绑定到
 * `config/settings.js`，而环境每帧都会重新读一遍这些字段，所以拖动滑块
 * 立刻生效，不需要 onChange，也不需要任何重建。
 */
export class AppGround {
    constructor(canvas) {
        this.canvas = canvas;
        this.time = new Time();
        this.elapsed = 0;
        this._raf = 0;

        /* ---- 核心 ---- */
        this.renderer = new Renderer(canvas);
        this.rig = new CameraRig(canvas);
        this.camera = this.rig.camera;

        this.environment = new Environment(this.renderer, this.camera);
        this.scene = this.environment.scene;

        /* ---- 世界 ---- */
        this.ground = new Ground(this.environment);
        this.dust = new DustMotes();
        this.contactShadows = new ContactShadows(this.renderer, { size: 2.6, height: 2.4, blur: 2.0 });

        this.scene.add(this.ground.mesh, this.dust.points, this.contactShadows.group);
        this.dust.setPixelRatio(this.renderer.gl.getPixelRatio());

        /* ---- 角色 ---- */
        this.character = new CharacterController(this.environment);
        this.scene.add(this.character.root);

        /* ---- 后处理 ---- */
        this.post = new PostProcessing(this.renderer, this.scene, this.camera);

        /* ---- 界面 ---- */
        this.loading = new LoadingScreen();
        this._buildGui();

        this._bindEvents();
    }

    /* ------------------------------------------------------------------ */

    /** 环境一节：键光、补光、IBL、阴影，全部直接写回 settings。 */
    _buildGui() {
        this.gui = new GUI({ title: '场景参数配置', width: 330 });
        this.gui.domElement.style.setProperty('--title-height', '30px');

        const folder = this.gui.addFolder('环境相关');
        const e = settings.environment;

        folder.add(e, 'sunIntensity', 0, 8, 0.01).name('sun intensity');
        folder.addColor(e, 'sunColor').name('sun colour');
        folder.add(e, 'sunAzimuth', 0, Math.PI * 2, 0.01).name('sun azimuth');
        folder.add(e, 'sunElevation', 0.05, 1.5, 0.01).name('sun elevation');
        folder.add(e, 'ambientIntensity', 0, 3, 0.01).name('ambient intensity');
        folder.addColor(e, 'ambientColor').name('ambient colour');
        folder.add(e, 'hemiIntensity', 0, 3, 0.01).name('hemisphere');
        folder.add(e, 'envIntensity', 0, 3, 0.01).name('env (IBL)');
        folder.add(e, 'shadowRadius', 0, 8, 0.05).name('shadow softness');
        folder.add(e, 'shadowBias', -0.01, 0.001, 0.0001).name('shadow bias');
        folder.add(e, 'contactShadow', 0, 1.5, 0.01).name('contact shadow');

        folder.add(e, 'fogEnabled').name('fog enabled');
        folder.addColor(e, 'fogColor').name('fog color');
        folder.add(e, 'fogNear', 1, 50, 0.1).name('fog near');
        folder.add(e, 'fogFar', 100, 1000, 1).name('fog far');

        folder.addColor(e, 'floorColor').name('floor color');
    }

    /* ------------------------------------------------------------------ */

    _bindEvents() {
        this.renderer.onResize((width, height, pixelRatio) => {
            this.rig.resize(width, height);
            this.post.setSize(width, height, pixelRatio);
            this.dust.setPixelRatio(pixelRatio);
        });
    }

    /* ------------------------------------------------------------------ */

    /** 加载资源，预热着色器缓存，然后启动循环。 */
    async load() {
        const assets = new AssetLoader();

        this.loading.setProgress(0.05, 'Loading environment…');
        const hdr = await assets.loadHDR(HDR_URL);
        await this.environment.loadEnvironment(hdr);
        frame.uEnvMap.value = this.environment.equirect;

        this.loading.setProgress(0.35, 'Loading floor…');
        await this.ground.loadTextures(assets);

        this.loading.setProgress(0.5, 'Loading character…');
        await this.character.load(assets);

        this.loading.setProgress(0.85, 'Compiling shaders…');
        // 提前把一切编译好，这样第一帧永远不会卡一下。
        await this.renderer.gl.compileAsync(this.scene, this.camera);

        this.loading.setProgress(1, 'Ready');
        this.loading.hide();

        this.start();
    }

    start() {
        this.time.reset();
        const loop = () => {
            this._raf = requestAnimationFrame(loop);
            this.frame();
        };
        this._raf = requestAnimationFrame(loop);
    }

    stop() {
        cancelAnimationFrame(this._raf);
    }

    /* ------------------------------------------------------------------ */

    /**
     * 一帧的全部工作，由 `start()` 里的 requestAnimationFrame 循环反复调用。
     *
     * 顺序不是随便排的：先推进时钟并喂共享 uniform → 把 settings 同步进各个系统
     *（环境 → 角色 → 地板与浮尘）→ 相机 → 接触阴影（它要临时改场景状态、渲染
     * 离屏目标，必须赶在主渲染之前完成）→ 后处理把画面画出来。
     *
     */
    frame() {
        // 取一次句柄：本帧还要用它清统计、标记阴影贴图。
        const gl = this.renderer.gl;

        // 手动清空绘制统计。Renderer 关掉了 three 的 info.autoReset（见 Renderer.js），
        // 否则每调用一次 gl.render() 都会清零，而这一帧里场景会被画好几遍：深度
        // 预通道、扭曲通道、接触阴影、composer 的各个 pass。在这里清一次，
        // gl.info.render.calls 读出来就是"这一帧所有 pass 加起来的 draw call 数"。
        // 去掉它：计数器只增不减，数字失去参考价值（这个精简版里没有 HUD 读它，
        // 所以只是控制台里的统计失真，画面完全不受影响）。
        gl.info.reset();

        // 距上一帧的真实秒数，已由 Time 钳到 1/20 s——切走标签页、卡一次编译
        // 之后回来，模拟不会被一个好几秒的步长炸掉。用 performance.now() 而非
        // Date.now()：单调时钟，改系统时间也不会跳。
        const raw = this.time.tick();
        // 模拟步长 = 真实秒数 × 全局时间缩放。raw 与 dt 刻意分开：相机、接触阴影
        // 这类呈现与交互吃 raw，动画与着色器相位吃 dt，于是"把时间调慢"只慢模拟，
        // 不会让相机变卡。去掉它：settings.global.timeScale 彻底失效（调到 0.2
        // 角色不会变慢，调到 0 也冻不住）。
        const dt = raw * settings.global.timeScale;
        // 累计模拟时间，本帧所有"随时间走"的东西都拿它当相位：地板的光池、
        // 浮尘的漂移与闪烁、后处理调色 pass 的时间。它累加的是 dt（缩放后），
        // 因此和可暂停、可减速的模拟共用同一根时间轴。
        // 去掉它：时钟停在 0，浮尘不漂不闪、一切随时间变化的动画静止。
        this.elapsed += dt;

        /* ---- 共享 uniform ---- */
        // 下面六行写的是 FrameUniforms 里那组"同一个盒子"：项目里所有自定义材质
        // 都通过 sharedUniforms() 拿到同一批对象，所以这里写一次就等于更新了全部
        // 材质，不需要遍历。注意在当前这个精简版里，读它们的材质（冰、雷、火、
        // 光束、粒子……）都随技能一起被删了，因此这六行目前不会改变画面上的任何
        // 东西；保留它们是为了给"以后再往场景里加自定义材质"留下共享时钟
        //（地板与浮尘各自的 uTime 是独立 uniform，不读这里）。
        frame.uTime.value = this.elapsed; // 去掉：以后加回特效时，它们的动画永远停在 t = 0
        frame.uDelta.value = dt; // 去掉：着色器里"按秒积分"的动效（拖尾衰减、余烬变暗）步长恒为 0
        // 编辑器里的两个全局乘数，材质把它们乘进各自的效果强度里，于是"把全场
        // 特效调弱"只需改一个值。去掉：这类全局缩放对未来的材质失效。
        frame.uShaderIntensity.value = settings.global.shaderIntensity;
        frame.uGlobalGlow.value = settings.global.glow;
        // 相机的近/远平面。软粒子要靠它把深度缓冲里的值还原成视空间距离，从而在
        // 贴近不透明表面时淡出，而不是被切一刀。目前相机用的是固定值
        //（0.1 / 400，CameraRig 构造时定下），每帧回写一次是为了让任何后续改动
        // 自动被材质读到。去掉：深度重建会退回 FrameUniforms 的默认值。
        frame.uCameraNear.value = this.camera.near;
        frame.uCameraFar.value = this.camera.far;

        /* ---- 模拟 ---- */
        // 把设置里的曝光写进渲染器。Renderer 只在构造时读过一次
        // settings.post.exposure，这里是它之后唯一的刷新途径。
        // 去掉：曝光调整（编辑器里的 exposure 滑杆）不会生效，色调映射永远停在启动那一档。
        this.renderer.syncSettings();

        // 灯光与阴影的跟随点始终对准角色，舞台因此永远围着它打光。太阳与轮廓光的
        // 位置、±26 m 的阴影正交相机中心都以这个点为基准，真正的摆放发生在下一行。
        // 角色现在恰好站在原点，所以这一行当前等价于把 (0,0,0) 再写一遍；等角色
        // 会走动（接上移动）时，去掉它灯与影子就会留在原地。
        this.environment.setFocus(this.character.position.x, this.character.position.z);
        // 把 settings.environment 整节同步进场景：重算太阳/轮廓光的方向与位置、
        // 更新共享的主光方向、灯光颜色与强度、环境光与半球光、IBL 强度、背景色与雾。
        // 去掉：Environment 面板里那 11 个控件全部失效——它们只写 settings，而唯一
        // 把 settings 读进灯光的地方就是这里，场景会永远停在初始的布光上。
        this.environment.update();

        // 推进角色动画（待机呼吸）与叠加的程序化姿态。吃 dt 而不是 raw，所以全局
        // 时间缩放会一起改变动画速度。
        // 去掉：AnimationMixer 不再推进，角色定格在动画第 0 帧，像一尊静止的雕像
        //（皮肤和材质都在，就是不动）。
        this.character.update(dt);

        // 同步地板：双色、贴图调色强度、斑块光泽、径向光池、粗糙度、法线强度，
        // 顺带按"每块砖多少米"重算平铺、按开关决定挂不挂石材贴图。
        // 去掉：地板永远保持构造时那一套值，Stage floor 相关改动、贴图开关与平铺
        // 尺寸都不会反映到画面上。
        this.ground.update(this.elapsed);
        // 同步浮尘：uTime 驱动顶点着色器里的上浮、卷曲与闪烁，uAmount 是浓度，并把
        // 整个点云平移到角色所在 xz（只改 modelMatrix，2600 个顶点不会重新上传）。
        // 去掉：浮尘变成一堆静止的点，浓度设置失效，点云也不再跟着角色走。
        this.dust.update(this.elapsed, this.character.position);

        /* ---- 相机 ---- */
        // 告诉环绕机位"绕着谁转"：OrbitControls 的 target 会在下一行朝它阻尼地追过去。
        // 角色此刻就在原点，所以这一行目前看不出差别；去掉它，角色一旦移动，
        // 相机会继续绕着世界原点转，把人转出画面。
        this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
        // 真正驱动相机：应用 FOV 与俯仰限制、把 target 阻尼到锚点、强制施加距离
        //（滚轮缩放与编辑器滑杆最终都落在这里），最后叠上抖动偏移。
        // 传 raw 而非 dt：把时间缩放调成 0 时模拟冻结，相机依然能顺畅地环绕。
        // 去掉：相机彻底不动——OrbitControls 算出的旋转要靠这里应用，右键拖拽与
        // 滚轮都会失灵，画面永远卡在初始机位。
        this.rig.update(raw);

        // 让接触阴影的承接面片（连同那张只看得见角色的正交相机）跟着角色走。
        // 去掉：那圈脚下的暗影留在世界原点，角色一旦移动就会与脚脱节。
        this.contactShadows.setPosition(this.character.position.x, this.character.position.z);
        // 渲染接触阴影：从下方把角色深度画进离屏目标、模糊两遍，结果留给承接面片
        // 去采样。必须在主渲染之前——它会临时改 scene.background / overrideMaterial
        // 并反复切换 renderTarget，跑完之后面片的纹理才是这一帧的。
        // 去掉：脚下那圈柔和的 AO 消失（面片采到的是空纹理），角色看起来微微浮在
        // 地板上。把 settings.environment.contactShadow 调成 0 时它会自己早退，
        // 所以关掉它不需要动代码。
        this.contactShadows.render(this.scene);

        /* ---- 渲染 ---- */
        // 每帧恰好更新一次阴影贴图（见 Renderer）。Renderer 关掉了
        // shadowMap.autoUpdate——否则这一帧里场景被画好几遍，4096² 的阴影贴图就要
        // 跟着重建好几遍——代价是必须每帧显式打这个标记 three 才会重画，而且它在
        // 渲染完后会把标记清回 false，所以不能只在启动时打一次。
        // 去掉：影子冻结在第一帧的姿势与光照上——角色的待机呼吸不会反映到影子上，
        // 转动 key azimuth 让太阳挪了位置，影子也不跟着动。
        gl.shadowMap.needsUpdate = true;
        // 把 settings.post 推给各个 pass（bloom 强度/半径/阈值、色差、暗角、对比、
        // 饱和、色温、lift/gain、颗粒、屏幕扭曲）并推进调色 pass 的时间；
        // 第二个参数是闪光状态，这里恒定传零——没有技能会触发闪光。
        // 去掉：后处理只认构造时那一套参数，且调色 pass 的时间停在 0，
        // 颗粒与色差不再随时间变化。
        this.post.sync(this.elapsed, NO_FLASH);
        // 出图：深度预通道 → 扭曲通道 → composer（场景 → 扭曲叠加 → bloom →
        // 色调映射 → 调色）。这是整个应用唯一的画面来源。
        // 去掉：什么都不画，canvas 停在上一帧（或一片黑）。
        this.post.render();
    }

    /* ------------------------------------------------------------------ */

    dispose() {
        this.stop();
        this.character.dispose();
        this.ground.dispose();
        this.dust.dispose();
        this.contactShadows.dispose();
        this.post.dispose();
        this.environment.dispose();
        this.gui.destroy();
        this.rig.dispose();
        this.renderer.dispose();
    }
}
