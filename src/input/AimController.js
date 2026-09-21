import { Group, Raycaster, Plane, Vector2, Vector3, MathUtils } from 'three';
import { settings, ELEMENTS, CastShape, castShapeOf } from '../config/settings.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { AimIndicator } from '../effects/AimIndicator.js';
import { ZoneIndicator } from '../effects/ZoneIndicator.js';

const GROUND_PLANE = new Plane(new Vector3(0, 1, 0), 0);

/**
 * 瞄准系统，采用玩家从 MOBA 里已经熟悉的两种形状。
 *
 * **线型施放（line cast）** 会备战一支绕施法者摆动、并沿自身长度发射的箭头；
 * **远程施放（far cast）** 会备战一个跟随光标、并在点击处落下的圆圈。某个技能
 * 用哪一种，在 `ELEMENT_META[...].cast` 里声明，控制器会在选中时切换指示器——
 * 备战、钳制、校验与发射的其余一切逻辑都是共用的，因为从瞄准这一侧来看，
 * 唯一的差别只是画出来的东西不同。
 *
 * 控制器持有瞄准状态和两个指示器；关于这次施放会做什么，它一概不做决定。
 * 它只发出一个事件 `cast`，带上原点、单位方向和距离——这正好就是技能的
 * `spawn` 所接收的签名。远程施放从这条线的远端读出它的目标点，
 * 因此技能的契约从来不需要改动。
 *
 * 指针是每帧重新投影的，而不是只在移动时投影，所以在施放已备战的情况下
 * 环绕相机，指示器会在静止不动的光标下摆动。
 *
 * 发出的事件：`cast` (origin, direction, distance)、`arm`、`cancel`、`reject`。
 */
export class AimController extends EventEmitter {
    constructor(camera) {
        super();
        this.camera = camera;
        this.raycaster = new Raycaster();
        this.raycaster.far = 500;

        this.indicator = new AimIndicator();
        this.zone = new ZoneIndicator();

        this.group = new Group();
        this.group.name = 'AimIndicators';
        this.group.add(this.indicator.object3D, this.zone.object3D);

        /**
         * 箭头正在为哪个技能测量。`range` 与 `minRange` 是按元素划分的，
         * 所以箭头的射程会随玩家选中的技能槽而变化。
         */
        this.element = ELEMENTS[0];

        this.armed = false;
        /** 指示器展开的 0..1 进度。由真实时间驱动，永远不做缩放。 */
        this.reveal = 0;

        /** 施放的来源处——施法者的脚下。 */
        this.origin = new Vector3();
        /** 地平面上的单位向量。 */
        this.direction = new Vector3(0, 0, 1);
        this.distance = 0;
        this.yaw = 0;
        /** 当指针比技能的 `minRange` 更近时为 false。 */
        this.valid = true;

        this._pointer = new Vector2();
        this._hasPointer = false;
        this._hit = new Vector3();
        this._flat = new Vector3();
    }

    get object3D() {
        return this.group;
    }

    /** 正在瞄准的那个技能的实时 settings 配置块。 */
    get config() {
        return settings[this.element] ?? settings[ELEMENTS[0]];
    }

    /** 技能槽里的技能是靠箭头还是靠圆圈瞄准。 */
    get shape() {
        return castShapeOf(this.element);
    }

    /** 远程施放的覆盖范围，单位米。线型施放为 0。 */
    get zoneRadius() {
        return Math.max(0.05, this.config.zoneRadius ?? 1);
    }

    /** 让指示器指向另一个技能的射程。 */
    setElement(element) {
        if (!settings[element]) return;
        this.element = element;
    }

    get isArmed() {
        return this.armed;
    }

    /** 施法者应朝向的方位，绕 +Y 轴的弧度。 */
    get facing() {
        return this.yaw;
    }

    /* ------------------------------------------------------------------ */

    /** 箭头的起点。每帧都用角色的位置调用一次。 */
    setOrigin(position) {
        this.origin.set(position.x, 0, position.z);
    }

    arm() {
        if (this.armed) return;
        this.armed = true;
        this.emit('arm');
    }

    cancel() {
        if (!this.armed) return;
        this.armed = false;
        this.emit('cancel');
    }

    toggle() {
        if (this.armed) this.cancel();
        else this.arm();
    }

    /** 指针最新的 NDC 位置。即使未备战也会保留。 */
    point(pointer) {
        this._pointer.copy(pointer);
        this._hasPointer = true;
    }

    /**
     * 若这次瞄准合法，就开火。
     * @returns {boolean} 是否发出了施放
     */
    confirm() {
        if (!this.armed) return false;
        if (!this.valid) {
            this.emit('reject');
            return false;
        }
        this.armed = false;
        this.emit('cast', this.origin, this.direction, this.distance);
        return true;
    }

    /* ------------------------------------------------------------------ */

    /** 把指针投影到地面上，并据此解算出瞄准结果。 */
    _resolve() {
        const c = this.config;

        if (this._hasPointer) {
            this.raycaster.setFromCamera(this._pointer, this.camera);
            if (this.raycaster.ray.intersectPlane(GROUND_PLANE, this._hit)) {
                this._flat.copy(this._hit).sub(this.origin);
                this._flat.y = 0;
                // 在施法者背后、以及正好压在施法者身上，是两种退化的情形；
                // 此时保留上一个有效方位，而不是猛地跳到正北。
                if (this._flat.lengthSq() > 1e-6) {
                    const raw = this._flat.length();
                    this.direction.copy(this._flat).multiplyScalar(1 / raw);
                    this.yaw = Math.atan2(this.direction.x, this.direction.z);
                    this.valid = raw >= c.minRange;
                    this.distance = MathUtils.clamp(raw, Math.max(0.2, c.minRange), Math.max(0.4, c.range));
                    return;
                }
            }
        }

        this.valid = false;
        this.distance = MathUtils.clamp(this.distance, Math.max(0.2, c.minRange), Math.max(0.4, c.range));
    }

    /**
     * @param {number} dt 真实秒数——刻意*不是*缩放后的模拟 delta，
     *   这样在沙盒暂停时指示器仍会继续动画。
     */
    update(dt) {
        this._resolve();

        const zoned = this.shape === CastShape.ZONE;
        const revealTime = Math.max(0.01, zoned ? settings.zone.reveal : settings.aim.reveal);
        const target = this.armed ? 1 : 0;
        const step = dt / revealTime;
        this.reveal = MathUtils.clamp(this.reveal + MathUtils.clamp(target - this.reveal, -step, step), 0, 1);

        const visible = this.reveal > 0.001;
        // 屏幕上永远只会出现两者之一，而且在展开过程中切换技能槽
        // 会直接隐藏另一个，而不是留它在原地淡出。
        this.indicator.setVisible(visible && !zoned);
        this.zone.setVisible(visible && zoned);

        if (!visible) return;
        if (zoned) {
            this.zone.update(
                this.origin,
                this.yaw,
                this.distance,
                this.zoneRadius,
                this.config.range,
                this.reveal,
                this.valid
            );
        } else {
            this.indicator.update(this.origin, this.yaw, this.distance, this.reveal, this.valid);
        }
    }

    dispose() {
        this.indicator.dispose();
        this.zone.dispose();
        this.clear();
    }
}
