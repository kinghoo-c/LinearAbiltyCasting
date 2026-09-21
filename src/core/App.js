import { Vector3, MathUtils } from 'three';

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

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { FissureSystem } from '../effects/GroundFissures.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';

import { settings, ELEMENTS } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

/**
 * 应用根节点：持有每一个子系统以及帧循环。
 *
 * 接线是刻意做成单向的——App 构建好各个系统，把一个装着共享服务的上下文
 * 对象交给技能管理器，接着就只做一件事：编排每帧的更新顺序。没有任何
 * 子系统会反向去碰 App。
 *
 * 交互就是一个循环：选择并备战一个技能（Q / E），用鼠标摆动地面箭头，
 * 点击开火。`AimController` 持有瞄准逻辑并发出一个 `cast` 事件；
 * App 把它转变成一个技能、一个角色朝向和一次冷却。
 */
export class App {
    constructor(canvas) {
        this.canvas = canvas;
        this.time = new Time();
        this.elapsed = 0;
        this.paused = false;
        this._raf = 0;

        /**
         * 距离每个技能可以再次备战还剩的秒数。按元素划分，因此
         * 用掉一个槽位绝不会把另一个锁死。
         */
        this.cooldowns = new Map(ELEMENTS.map((element) => [element, 0]));

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

        /* ---- 共享 VFX 服务 ---- */
        this.particles = new ParticleEngine(this.scene);
        this.lights = new LightPool(this.scene);
        this.decals = new DecalSystem(this.scene);
        this.fissures = new FissureSystem(this.scene);
        this.bursts = new BurstSystem(this.scene);
        this.shake = new CameraShake(this.rig);
        this.flash = new ScreenFlash();

        this.abilities = new AbilityManager({
            scene: this.scene,
            camera: this.camera,
            environment: this.environment,
            particles: this.particles,
            lights: this.lights,
            decals: this.decals,
            fissures: this.fissures,
            bursts: this.bursts,
            shake: this.shake,
            flash: this.flash,
        });

        /* ---- 角色 ---- */
        this.character = new CharacterController(this.environment);
        this.scene.add(this.character.root);

        /* ---- 输入与瞄准 ---- */
        this.input = new InputManager(canvas);
        this.aim = new AimController(this.camera);
        this.scene.add(this.aim.object3D);

        /* ---- 后处理 ---- */
        this.post = new PostProcessing(this.renderer, this.scene, this.camera);

        /* ---- 界面 ---- */
        this.loading = new LoadingScreen();
        this.hud = new HUD(document.getElementById('hud'));
        this.editor = new Editor({
            onClear: () => this.clearEffects(),
            onToast: (message) => this.hud.showToast(message),
        });

        this._bindEvents();
        this.selectAbility(ELEMENTS[0], { silent: true });

        this._focusPoint = new Vector3();
    }

    /** 当前在技能槽里的技能。 */
    get element() {
        return this.abilities.selected;
    }

    /* ------------------------------------------------------------------ */

    _bindEvents() {
        this.renderer.onResize((width, height, pixelRatio) => {
            this.rig.resize(width, height);
            this.post.setSize(width, height, pixelRatio);
            this.dust.setPixelRatio(pixelRatio);
        });

        this.input.on('pointer:move', (pointer) => this.aim.point(pointer));
        this.input.on('pointer:confirm', (pointer) => {
            this.aim.point(pointer);
            this.aim.confirm();
        });
        this.input.on('action', (action, slot) => this._handleAction(action, slot));

        this.aim.on('cast', (origin, direction, distance) => this._cast(origin, direction, distance));
        this.aim.on('reject', () => this.hud.showToast('Too close — aim further out'));

        this.hud.onAbility = (element) => this.armAbility(element);
    }

    _handleAction(action, slot) {
        switch (action) {
            case 'ability': {
                const element = ELEMENTS[slot] ?? this.element;
                // 再次按下*同一个*按键会取消已备战的施放，就像 MOBA 里那样；
                // 按下另一个按键则切换技能槽，而不会取消备战。
                if (this.aim.isArmed && element === this.element) this.aim.cancel();
                else this.armAbility(element);
                break;
            }
            case 'cancel':
                this.aim.cancel();
                break;
            case 'toggleHelp':
                this.hud.toggleHelp();
                break;
            case 'toggleEditor':
                this.editor.toggle();
                break;
            case 'clear':
                this.clearEffects();
                this.hud.showToast('Effects cleared');
                break;
            case 'togglePause':
                this.paused = !this.paused;
                this.hud.setPaused(this.paused);
                this.hud.showToast(this.paused ? 'Paused — the editor still applies' : 'Resumed');
                break;
            default:
                break;
        }
    }

    /**
     * 把一个技能放进技能槽。瞄准指示器和 HUD 都会跟着变，
     * 因为 `range` 与 `minRange` 属于技能，而不属于应用。
     */
    selectAbility(element, options = {}) {
        if (!ELEMENTS.includes(element)) return;
        this.abilities.select(element);
        this.aim.setElement(element);
        this.hud.setElement(element, options);
    }

    /** 选择一个技能并备战它，除非它仍在冷却当中。 */
    armAbility(element = this.element) {
        if ((this.cooldowns.get(element) ?? 0) > 0) {
            this.hud.showToast('Not ready');
            return;
        }
        // 先选择再备战，意味着箭头在它出现的那一帧就已经画到了
        // 新技能的射程上。
        if (element !== this.element) this.selectAbility(element);
        this.aim.arm();
    }

    _cast(origin, direction, distance) {
        const element = this.element;
        this.abilities.cast(origin, direction, distance, element);
        this.cooldowns.set(element, Math.max(0, settings[element].cooldown));

        // 对准这一击，并把身体也甩进去。具体播哪一段动画属于技能自己的事，
        // 所以每个法术都能用自己的手势来施放。
        this.character.setFacing(this.aim.facing);
        this.character.playCast(settings[element].castAnim);
        this.character.castLunge();
    }

    clearEffects() {
        this.aim.cancel();
        this.abilities.clear();
        this.particles.reset();
        this.decals.clear();
        this.fissures.clear();
        this.bursts.clear();
        this.lights.reset();
        this.shake.reset();
        this.flash.reset();
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
        // 提前把一切编译好，这样第一次施放永远不会卡一下。
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
        const dt = this.paused ? 0 : raw * settings.global.timeScale;
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

        this.environment.setFocus(this.character.position.x, this.character.position.z);
        this.environment.update();

        // 瞄准系统跑在*真实*时间上，这样在沙盒暂停时箭头仍会持续摆动和
        // 动画——暂停冻结的是特效，不是界面。
        this.aim.setOrigin(this.character.position);
        this.aim.update(raw);

        if (settings.character.turnToAim && this.aim.isArmed) {
            this.character.turnToward(this.aim.facing, settings.character.turnRate, raw);
        }
        this.character.update(dt);

        for (const [element, remaining] of this.cooldowns) {
            if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - raw));
        }

        this.ground.update(this.elapsed);
        this.dust.update(this.elapsed, this.character.position);

        this.abilities.update(dt);
        this.particles.flush();
        this.decals.update(dt);
        this.fissures.update(dt);
        this.bursts.update(dt);
        this.lights.update(dt);

        /* ---- 相机 ---- */
        const focus = this.abilities.focus;
        if (focus) this.rig.lookAt(focus.position, MathUtils.clamp(1 - focus.u * 0.4, 0, 1));
        this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
        this.shake.update(raw);
        this.flash.update(raw);
        this.rig.update(raw);

        this.contactShadows.setPosition(this.character.position.x, this.character.position.z);
        this.contactShadows.render(this.scene);

        /* ---- 渲染 ---- */
        // 每帧恰好更新一次级联阴影（见 Renderer）。
        gl.shadowMap.needsUpdate = true;
        this.post.sync(this.elapsed, this.flash);
        this.post.render();

        /* ---- 读数 ---- */
        for (const element of ELEMENTS) {
            this.hud.setCooldown(element, this.cooldowns.get(element) ?? 0, settings[element].cooldown);
        }
        this.hud.setArmed(this.aim.isArmed);
        this.hud.update(raw, () => ({
            particles: this.particles.countLive(this.elapsed),
            calls: gl.info.render.calls,
            spikes: this.abilities.active.reduce((total, ability) => total + ability.instanceCount, 0),
            abilities: this.abilities.active.length,
        }));
    }

    /* ------------------------------------------------------------------ */

    dispose() {
        this.stop();
        this.input.dispose();
        this.aim.dispose();
        this.abilities.dispose();
        this.particles.dispose();
        this.decals.dispose();
        this.fissures.dispose();
        this.bursts.dispose();
        this.lights.dispose();
        this.character.dispose();
        this.ground.dispose();
        this.dust.dispose();
        this.contactShadows.dispose();
        this.post.dispose();
        this.environment.dispose();
        this.editor.dispose();
        this.rig.dispose();
        this.renderer.dispose();
    }
}
