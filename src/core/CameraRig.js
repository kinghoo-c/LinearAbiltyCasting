import { PerspectiveCamera, Vector3, MathUtils, MOUSE, TOUCH } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { settings } from '../config/settings.js';
import { clamp, damp } from '../utils/math.js';
import { LAYER } from './Layers.js';

const _dir = new Vector3();
const _desiredTarget = new Vector3();

/**
 * 第三人称环绕机位。
 *
 * - 左键保留给绘制用，所以环绕绑定在右键拖拽上。
 * - 距离总是回归到 `settings.camera.distance`，因此无论环绕目标漂到哪里，
 *   取景都保持一致。滚轮缩放写的就是同一个设置，这意味着在机位跟随
 *   某个技能时缩放依然有效，而编辑器滑块始终是唯一的真相来源。
 * - 机位会缓缓把它的注视点漂向正在施放的那个技能。
 */
export class CameraRig {
    constructor(domElement) {
        this.camera = new PerspectiveCamera(settings.camera.fov, window.innerWidth / window.innerHeight, 0.1, 400);
        this.camera.position.set(-6.5, 6.0, 9.5);
        this.camera.layers.enable(LAYER.VFX);

        this.controls = new OrbitControls(this.camera, domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.075;
        this.controls.enablePan = false;
        this.controls.enableZoom = true; // 改由滚轮驱动 `settings.camera.distance`
        this.controls.minPolarAngle = settings.camera.minPolar;
        this.controls.maxPolarAngle = settings.camera.maxPolar;
        this.controls.rotateSpeed = 0.65;

        // 把左键让给路径绘制。
        this.controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: MOUSE.ROTATE };
        this.controls.touches = { ONE: null, TWO: TOUCH.DOLLY_ROTATE };

        this.anchor = new Vector3(0, 0, 0); // 角色
        this.focus = new Vector3(0, 0, 0); // 关注点（技能头部）
        this.focusWeight = 0;
        this.shakeOffset = new Vector3();
        this.shakeRoll = 0;

        this.controls.target.set(0, settings.camera.targetHeight, 0);
        this.controls.update();

        // 实际距离，朝 `settings.camera.distance` 缓动，好让拨一下滚轮是
        // 滑过去，而不是啪地跳过去。
        this.distance = settings.camera.distance;

        this.domElement = domElement;
        this._onWheel = this._onWheel.bind(this);
        domElement.addEventListener('wheel', this._onWheel, { passive: false });
    }

    /** 滚轮缩放。采用乘法，因此在任何距离上每一格的感受都一致。 */
    _onWheel(event) {
        event.preventDefault();

        const cam = settings.camera;
        // Firefox 报的是行（deltaMode 1）和页（deltaMode 2），而不是像素。
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
        const delta = (event.deltaY * scale) / 100;

        cam.distance = clamp(cam.distance * Math.exp(delta * 0.12 * cam.zoomSpeed), cam.minDistance, cam.maxDistance);
    }

    /** 机位应该环绕的那个点（角色位置）。 */
    setAnchor(x, y, z) {
        this.anchor.set(x, y, z);
    }

    /** 把注视点朝某个技能轻推。`weight` 取 0..1，会自行衰减。 */
    lookAt(point, weight = 1) {
        this.focus.copy(point);
        this.focusWeight = Math.max(this.focusWeight, weight);
    }

    update(dt) {
        const cam = settings.camera;

        if (this.camera.fov !== cam.fov) {
            this.camera.fov = cam.fov;
            this.camera.updateProjectionMatrix();
        }
        this.controls.minPolarAngle = cam.minPolar;
        this.controls.maxPolarAngle = cam.maxPolar;

        // 在角色与任何活跃技能之间混合环绕目标。
        const blend = MathUtils.clamp(this.focusWeight * cam.autoFrame, 0, 0.85);
        _desiredTarget.copy(this.anchor);
        _desiredTarget.y += cam.targetHeight;
        _desiredTarget.lerp(this.focus, blend);

        this.controls.target.set(
            damp(this.controls.target.x, _desiredTarget.x, cam.damping, dt),
            damp(this.controls.target.y, _desiredTarget.y, cam.damping, dt),
            damp(this.controls.target.z, _desiredTarget.z, cam.damping, dt)
        );

        this.focusWeight = damp(this.focusWeight, 0, 0.08, dt);

        this.controls.update();

        // 强制施加环绕距离（缩放与编辑器滑块最终都落在这里）。
        this.distance = damp(this.distance, cam.distance, cam.zoomDamping, dt);
        _dir.copy(this.camera.position).sub(this.controls.target);
        const len = _dir.length() || 1;
        _dir.multiplyScalar(1 / len);
        this.camera.position.copy(this.controls.target).addScaledVector(_dir, this.distance);

        // 相机抖动是叠加式的，在控制器稳定之后再施加。
        if (this.shakeOffset.lengthSq() > 0) {
            this.camera.position.add(this.shakeOffset);
            this.camera.rotateZ(this.shakeRoll);
        }
    }

    resize(width, height) {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    dispose() {
        this.domElement.removeEventListener('wheel', this._onWheel);
        this.controls.dispose();
    }
}
