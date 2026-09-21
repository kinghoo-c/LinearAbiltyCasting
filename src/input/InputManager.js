import { Vector2 } from 'three';
import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * 把指针 + 键盘输入规范化成一套很小的事件词汇。
 *
 * 事件：
 *   `pointer:move` (ndc)          — 每一次移动，无论是否备战
 *   `pointer:confirm` (ndc)       — 在视口上左键单击
 *   `action` (name, slot)         — 其余一切，都已按意图命名。
 *                                   `ability` 携带从 0 开始的技能槽下标，
 *                                   由 App 通过 `ELEMENTS` 映射。
 *
 * 起始于 DOM UI（编辑器、HUD）之上的指针事件会被忽略，
 * 这样拖动滑块永远不会施放技能。
 */
export class InputManager extends EventEmitter {
    constructor(domElement) {
        super();
        this.dom = domElement;
        this.pointer = new Vector2(); // 归一化设备坐标（NDC）
        this.keys = new Set();
        this.enabled = true;

        this._bind();
    }

    _bind() {
        this.dom.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointermove', this._onPointerMove);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        this.dom.addEventListener('contextmenu', this._onContextMenu);
    }

    _onContextMenu = (event) => event.preventDefault();

    _updatePointer(event) {
        this.pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    }

    _onPointerDown = (event) => {
        if (!this.enabled) return;
        if (event.target !== this.dom) return; // 起始点在 UI 上

        this._updatePointer(event);

        if (event.button === 0) {
            this.emit('pointer:confirm', this.pointer);
        } else if (event.button === 2) {
            // 右键同时负责环绕（拖拽由 OrbitControls 接管）；在同一次按下里
            // 取消已备战的施放，是玩家预期的惯例。
            this.emit('action', 'cancel');
        }
    };

    _onPointerMove = (event) => {
        this._updatePointer(event);
        this.emit('pointer:move', this.pointer);
    };

    _onKeyDown = (event) => {
        if (event.repeat) return;
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

        this.keys.add(event.code);

        switch (event.code) {
            // 技能槽。请与 `ELEMENT_META[...].key` 保持一致。
            case 'KeyQ':
            case 'Digit1':
                this.emit('action', 'ability', 0);
                break;
            case 'KeyE':
            case 'Digit2':
                this.emit('action', 'ability', 1);
                break;
            case 'KeyR':
            case 'Digit3':
                this.emit('action', 'ability', 2);
                break;
            case 'KeyF':
            case 'Digit4':
                this.emit('action', 'ability', 3);
                break;
            case 'KeyV':
            case 'Digit5':
                this.emit('action', 'ability', 4);
                break;
            case 'KeyX':
            case 'Digit6':
                this.emit('action', 'ability', 5);
                break;
            case 'Escape':
                this.emit('action', 'cancel');
                break;
            case 'KeyH':
                this.emit('action', 'toggleHelp');
                break;
            case 'KeyG':
                this.emit('action', 'toggleEditor');
                break;
            case 'KeyC':
                this.emit('action', 'clear');
                break;
            case 'KeyP':
                this.emit('action', 'togglePause');
                break;
            default:
                break;
        }
    };

    _onKeyUp = (event) => {
        this.keys.delete(event.code);
    };

    dispose() {
        this.dom.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointermove', this._onPointerMove);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        this.dom.removeEventListener('contextmenu', this._onContextMenu);
        this.clear();
    }
}
