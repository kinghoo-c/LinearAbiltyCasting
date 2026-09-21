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
        this.gui = new GUI({ title: 'Scene Editor', width: 330 });
        this.gui.domElement.style.setProperty('--title-height', '30px');

        const folder = this.gui.addFolder('Environment');
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

    frame() {
        const gl = this.renderer.gl;
        gl.info.reset();

        const raw = this.time.tick();
        const dt = raw * settings.global.timeScale;
        this.elapsed += dt;

        /* ---- 共享 uniform ---- */
        frame.uTime.value = this.elapsed;
        frame.uDelta.value = dt;
        frame.uShaderIntensity.value = settings.global.shaderIntensity;
        frame.uGlobalGlow.value = settings.global.glow;
        frame.uCameraNear.value = this.camera.near;
        frame.uCameraFar.value = this.camera.far;

        /* ---- 模拟 ---- */
        this.renderer.syncSettings();

        // 灯光与阴影的跟随点始终对准角色，舞台因此永远围着它打光。
        this.environment.setFocus(this.character.position.x, this.character.position.z);
        this.environment.update();

        this.character.update(dt);

        this.ground.update(this.elapsed);
        this.dust.update(this.elapsed, this.character.position);

        /* ---- 相机 ---- */
        this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
        this.rig.update(raw);

        this.contactShadows.setPosition(this.character.position.x, this.character.position.z);
        this.contactShadows.render(this.scene);

        /* ---- 渲染 ---- */
        // 每帧恰好更新一次阴影贴图（见 Renderer）。
        gl.shadowMap.needsUpdate = true;
        this.post.sync(this.elapsed, NO_FLASH);
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
