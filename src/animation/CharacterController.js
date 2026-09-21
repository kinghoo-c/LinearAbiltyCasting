import {
    AnimationMixer,
    Box3,
    Group,
    LoopOnce,
    LoopRepeat,
    MathUtils,
    MeshStandardMaterial,
    SRGBColorSpace,
    Vector3,
} from 'three';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { disposeObject } from '../utils/dispose.js';

const CHARACTER_URL = './models/Idle.fbx';
/** 这份导出不带材质，所以皮肤以独立文件的形式随它一并提供。 */
const CHARACTER_TEXTURE_URL = './models/diffuse.png';
/** `CAST_ANIMATIONS` 里的每一项对应一个文件；只保留它们的剪辑。 */
const castUrl = (name) => `./models/${name}.fbx`;
/** Mixamo 以厘米为单位导出。 */
const FBX_SCALE = 0.01;
/** 各套骨骼不尽相同；归一到可信的人体身高，世界比例才立得住。 */
const TARGET_HEIGHT = 1.78;

/**
 * 加载带骨骼的 FBX，为场景做好归一化，并驱动它的动画。
 *
 * 角色永远不离开原地——它循环呼吸，转身面向你正在瞄准的方向，在你开火时
 * 甩出一个施放剪辑。这些剪辑是*同一套*骨架的若干份独立 Mixamo 导出，因此
 * 只保留它们的 `AnimationClip`：混合器按骨骼名绑定轨道，而对一套共享骨架
 * 来说，这就是让另一个文件里制作的剪辑能在这里播放所需的全部。
 *
 * 某个技能甩出哪个剪辑由 `settings[element].castAnim` 决定——这是逐技能的
 * 选择，可以实时编辑，所以 `playCast` 每次都要传入名称，而不是缓存一个。
 */
export class CharacterController {
    constructor(environment) {
        this.environment = environment;
        this.root = new Group();
        this.root.name = 'Character';

        // 位置与朝向住在 `root` 上；侧倾（行走模式下会向转弯方向倾斜）住在它
        // 下面的一个关节上，这样两者永远不会争夺同一个旋转。
        this.tilt = new Group();
        this.tilt.name = 'CharacterTilt';
        this.root.add(this.tilt);

        this.mixer = null;
        /** 循环的呼吸动作，在施放之下始终运行。 */
        this.idle = null;
        /** 名称 → 一次性施放动作。 */
        this.casts = new Map();
        /** 当前正在甩出的施放动作，待机时为 null。 */
        this._cast = null;
        this.height = 1.8;
        this.headPosition = new Vector3(0, 1.5, 0);
        /** 骨骼自身的朝向，位于模型空间——侧倾绕之旋转的那根轴。 */
        this.forwardAxis = new Vector3(0, 0, 1);

        /**
         * 骨骼自身朝向在模型空间中的偏航角。绑定姿势未必与坐标轴对齐，
         * 所以 `setFacing` 会减去它，从而无论 FBX 是怎么制作的，对调用方来说
         * "0 面向 +Z" 都成立。
         */
        this._forwardYaw = 0;
        /** 0..1 的突进包络，在 `castLunge()` 之后自行衰减。 */
        this._lunge = 0;
        this._rightAxis = new Vector3(1, 0, 0);
    }

    /**
     * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
     */
    async load(assets) {
        // 施放文件又是同一个角色，所以每个文件都要付一次解析成本，
        // 但运行时没有任何代价——除剪辑之外的一切都会在下面被丢弃。
        const [fbx, skin, ...castFiles] = await Promise.all([
            assets.loadFBX(CHARACTER_URL),
            assets.loadTexture(CHARACTER_TEXTURE_URL),
            ...CAST_ANIMATIONS.map((name) => assets.loadFBX(castUrl(name))),
        ]);
        // FBX 比它的贴图先完成解析；材质准备环节要检查这些贴图。
        await assets.settled();

        fbx.scale.setScalar(FBX_SCALE);
        fbx.updateMatrixWorld(true);

        const box = new Box3().setFromObject(fbx);
        const size = new Vector3();
        const center = new Vector3();
        box.getSize(size);

        // 先归一化骨骼的身高，再把它落到 y = 0 并居中。
        fbx.scale.setScalar(FBX_SCALE * (TARGET_HEIGHT / Math.max(0.001, size.y)));
        fbx.updateMatrixWorld(true);
        box.setFromObject(fbx);
        box.getSize(size);
        box.getCenter(center);
        this.height = size.y;
        fbx.position.x -= center.x;
        fbx.position.z -= center.z;
        fbx.position.y -= box.min.y;

        this._prepareMaterials(fbx, skin);
        this._measureFacing(fbx);

        this.tilt.add(fbx);
        this.model = fbx;
        this.headPosition.set(0, size.y * 0.86, 0);

        this.mixer = new AnimationMixer(fbx);
        this.mixer.addEventListener('finished', this._onCastFinished);

        // 呼吸动作本身就打包在角色文件里。
        const idleClip = (fbx.animations ?? [])[0];
        if (!idleClip) {
            console.warn('[CharacterController] no idle clip found in the FBX');
        } else {
            this.idle = this.mixer.clipAction(idleClip);
            this.idle.setLoop(LoopRepeat, Infinity);
            this.idle.play();
        }

        const bones = new Set();
        fbx.traverse((node) => bones.add(node.name));
        CAST_ANIMATIONS.forEach((name, index) => this._registerCast(name, castFiles[index], bones));

        return this;
    }

    /**
     * 保留一个施放文件的剪辑，并释放随之而来的那份重复骨骼。
     *
     * @param {string} name                 `settings[element].castAnim` 使用的 id
     * @param {import('three').Group} file  刚加载进来的 FBX
     * @param {Set<string>} bones           *本*骨骼中的每一个节点名
     */
    _registerCast(name, file, bones) {
        const clip = (file?.animations ?? [])[0];
        if (!clip) {
            console.warn(`[CharacterController] "${name}.fbx" carries no animation`);
            return;
        }

        // 针对这套骨骼的另一次导出制作的剪辑按骨骼名绑定，所以不匹配会表现为
        // 一条解析不到任何东西的轨道，而不是一个错误——在这里把话说出来，
        // 总好过让施放悄无声息地什么都不做。
        if (!clip.tracks.some((track) => bones.has(track.name.split('.')[0]))) {
            console.warn(`[CharacterController] "${name}.fbx" does not match this skeleton`);
            return;
        }

        clip.name = name;
        const action = this.mixer.clipAction(clip);
        action.setLoop(LoopOnce, 1);
        // 保持最后一帧，而不是弹回原位；真正结束这次施放的是
        // 淡回待机动作的那一下。
        action.clampWhenFinished = true;
        this.casts.set(name, action);

        disposeObject(file);
    }

    /**
     * 把导入的材质转换为 PBR，并把它们接入阴影系统。
     *
     * @param {import('three').Object3D} root
     * @param {import('three').Texture} skin 角色的颜色贴图
     */
    _prepareMaterials(root, skin) {
        const converted = new Map();

        // TextureLoader 假定数据是线性的；而这一张是按颜色制作的。
        skin.colorSpace = SRGBColorSpace;

        root.traverse((node) => {
            if (!node.isMesh && !node.isSkinnedMesh) return;

            node.castShadow = true;
            node.receiveShadow = true;
            node.frustumCulled = false;
            node.layers.set(LAYER.WORLD);
            node.layers.enable(LAYER.CONTACT); // 由接触阴影 pass 捕获

            const source = Array.isArray(node.material) ? node.material : [node.material];
            const result = source.map((material) => {
                if (!material) return material;
                if (converted.has(material)) return converted.get(material);

                // FBX 给我们的是 Phong/Lambert；转到 Standard，IBL 与 CSM 才能生效。
                // 这份导出自身不带贴图，所以随之一并加载的皮肤就是颜色贴图——但若
                // 某个文件*确实*内嵌了一张，它仍然优先，因为那张贴图是针对它自己的
                // UV 制作的。各家导出器对法线贴图落在哪个槽位说法不一，所以两个槽位
                // 都传进去，空的那个不产生任何开销。
                //
                // 色调会随贴图一起被丢弃：没有贴图的 FBX 默认是平坦的灰色，
                // 否则它会把皮肤的每个纹素都压暗。
                const standard = new MeshStandardMaterial({
                    name: material.name,
                    color: material.map ? (material.color ?? 0xffffff) : 0xffffff,
                    map: material.map ?? skin,
                    normalMap: material.normalMap ?? null,
                    bumpMap: material.normalMap ? null : (material.bumpMap ?? null),
                    roughness: 0.85,
                    metalness: 0,
                    transparent: material.transparent ?? false,
                    opacity: material.opacity ?? 1,
                    side: material.side,
                });

                // 值得为它花这些采样：角色是屏幕上相机唯一会靠近的东西，
                // 它的纹素在躯干上是以掠射角铺开的。
                for (const map of [standard.map, standard.normalMap, standard.bumpMap]) {
                    if (map) map.anisotropy = 4;
                }

                this.environment.registerShadowCaster(standard);
                material.dispose(); // 贴图与新材质共享，并不归它所有
                converted.set(material, standard);
                return standard;
            });

            node.material = Array.isArray(node.material) ? result : result[0];
        });
    }

    /**
     * 从绑定姿势推导出骨骼自身的朝向。
     *
     * 在一副未必与坐标轴对齐的绑定姿势上，脚跟 → 脚尖的向量是朝向最可靠的
     * 指示，而所有让身体转动的东西都读取它算出的偏航角。
     */
    _measureFacing(root) {
        root.updateMatrixWorld(true);

        let foot = null;
        let toe = null;
        root.traverse((node) => {
            if (!node.isBone) return;
            // 各家导出器对命名空间的说法不一："mixamorig:LeftFoot"、"mixamorigLeftFoot"。
            const short = node.name
                .split(':')
                .pop()
                .replace(/^mixamorig/i, '');
            if (short === 'LeftFoot' && !foot) foot = node;
            else if (short === 'LeftToeBase' && !toe) toe = node;
        });

        if (foot && toe) {
            const heel = foot.getWorldPosition(new Vector3());
            const tip = toe.getWorldPosition(new Vector3()).sub(heel).setY(0);
            if (tip.lengthSq() > 1e-6) this.forwardAxis.copy(tip).normalize();
        }

        this._forwardYaw = Math.atan2(this.forwardAxis.x, this.forwardAxis.z);
        this._rightAxis.set(0, 1, 0).cross(this.forwardAxis).normalize();
    }

    /* ------------------------------------------------------------------ */
    /* 施放剪辑                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 在待机动作之上甩出一次施放剪辑，只播一遍。
     *
     * @param {string} [name] `CAST_ANIMATIONS` 中的一个 id；会回退到第一个，
     *   这样某个技能即便配置的剪辑加载失败，身体也依然会动。
     */
    playCast(name) {
        const next = this.casts.get(name) ?? this.casts.get(CAST_ANIMATIONS[0]);
        if (!next || !this.idle) return;

        const previous = this._cast;
        this._cast = next;

        next.reset();
        next.setEffectiveTimeScale(1);
        next.play();

        // 从屏幕上实际正在播的东西淡出（首次施放是待机动作，重施放是那个还没
        // 播完的剪辑），这样身体在两次甩出之间永远不会有一帧掉回绑定姿势。
        // 重甩*同一个*剪辑只是让它重头开始：`reset()` 已经把它留在满权重上了。
        const from = previous ?? this.idle;
        if (from !== next) next.crossFadeFrom(from, settings.character.castBlendIn, false);
    }

    /** 施放剪辑正在播放时为 true。 */
    get isCasting() {
        return this._cast !== null;
    }

    _onCastFinished = (event) => {
        // 其它任何动作播完，都是重施放已经淡出的更早的剪辑。
        if (event.action !== this._cast) return;
        this._cast = null;

        // 淡入过程在权重归零时把待机动作禁用了；在请它再次进场之前
        // 先把它唤醒。
        this.idle.enabled = true;
        this.idle.setEffectiveTimeScale(1);
        this.idle.crossFadeFrom(event.action, settings.character.castBlendOut, false);
    };

    /* ------------------------------------------------------------------ */
    /* 站位——由行走模式驱动，其余情况下静止不动                            */
    /* ------------------------------------------------------------------ */

    /** 朝向，绕世界 +Y 的弧度。无论骨骼如何绑定，0 都面向 +Z。 */
    setFacing(yaw) {
        this.root.rotation.y = yaw - this._forwardYaw;
    }

    get facing() {
        return this.root.rotation.y + this._forwardYaw;
    }

    /**
     * 随时间转向 `yaw`，而不是瞬间转过去。
     * @param {number} rate 一秒之后仍然剩下的角度差所占比例
     */
    turnToward(yaw, rate, dt) {
        const current = this.facing;
        // 走最短的那一侧，这样跨过 -Z 接缝瞄准时身体不会打转。
        const delta = MathUtils.euclideanModulo(yaw - current + Math.PI, Math.PI * 2) - Math.PI;
        this.setFacing(current + delta * (1 - Math.pow(MathUtils.clamp(rate, 1e-6, 1), dt)));
    }

    /**
     * 把身体向前推一下，再让它自己稳下来。
     *
     * 它是在施放剪辑之上叠加的一笔重音，而不是替代它：绕身体自身的右轴俯仰，
     * 再沿它自身的朝向轴向后一推，两者都骑在同一个衰减包络上。施加在 `tilt`
     * 而不是 `root` 上，使它和朝向是组合关系而不是互相打架；当剪辑本身已经
     * 把这一切都表达清楚时，把 `castLean` 与 `castRecoil` 降到零即可关掉它。
     */
    castLunge() {
        this._lunge = 1;
    }

    _applyLunge(dt) {
        const c = settings.character;
        if (this._lunge > 0) {
            this._lunge = Math.max(0, this._lunge - c.castSettle * dt);
        }
        // 包络前端的一次短暂过冲，读起来像一记抽击，
        // 而不是慢慢地鞠一躬。
        const envelope = this._lunge * this._lunge * (1 + 0.35 * Math.sin(this._lunge * Math.PI));
        this.tilt.quaternion.setFromAxisAngle(this._rightAxis, envelope * c.castLean);
        this.tilt.position.copy(this.forwardAxis).multiplyScalar(-envelope * c.castRecoil);
    }

    /** 把角色放回地面、竖直站立，并朝向它原来的方向。 */
    resetPlacement() {
        this.root.position.y = 0;
        this._lunge = 0;
        this.tilt.quaternion.identity();
        this.tilt.position.set(0, 0, 0);
    }

    update(dt) {
        // 由*模拟*的 delta 驱动，并且每帧都重新施加，即使 dt = 0 也一样：
        // 在施放中途暂停会保持住这次突进，而 `castLean` 相对这个冻结的姿势
        // 仍然是一个实时生效的滑杆。
        this._applyLunge(dt);

        if (!this.mixer) return;

        this.mixer.timeScale = settings.global.animationSpeed;
        this.mixer.update(dt);
    }

    get position() {
        return this.root.position;
    }

    dispose() {
        this.mixer?.removeEventListener('finished', this._onCastFinished);
        this.mixer?.stopAllAction();
        this.mixer = null;
        this.idle = null;
        this.casts.clear();
        this._cast = null;
        disposeObject(this.root);
    }
}
