/**
 * 帧计时器。
 *
 * 用三行代码替代 THREE.Clock（在近几个版本中已废弃），
 * 同时接管 delta 的钳制：一个后台标签页或一次漫长的着色器编译，
 * 永远不能把好几秒的时间步长塞给模拟。
 */
export class Time {
    constructor(maxDelta = 1 / 20) {
        this.maxDelta = maxDelta;
        this.elapsed = 0;
        this.delta = 0;
        this._last = performance.now() / 1000;
    }

    /** @returns {number} 距上一次 tick 的秒数，已做钳制 */
    tick() {
        const now = performance.now() / 1000;
        this.delta = Math.min(now - this._last, this.maxDelta);
        this._last = now;
        this.elapsed += this.delta;
        return this.delta;
    }

    /** 长时间暂停（资源加载、切换标签页）之后调用，以避免时间跳变。 */
    reset() {
        this._last = performance.now() / 1000;
        this.delta = 0;
    }
}
