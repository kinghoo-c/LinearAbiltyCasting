/**
 * 极简对象池。
 *
 * 技能、灯光与贴花都回收复用而非重新分配，这样长时间游玩在预热之后能产生
 * （接近）零垃圾。
 */
export class ObjectPool {
    /**
     * @param {() => any} factory        池为空时创建一个新实例
     * @param {(item:any) => void} [reset] 条目被归还时调用
     * @param {number} [prewarm]         预先构建的实例数量
     */
    constructor(factory, reset = null, prewarm = 0) {
        this.factory = factory;
        this.reset = reset;
        this.free = [];
        this.activeCount = 0;
        for (let i = 0; i < prewarm; i++) this.free.push(factory());
    }

    acquire() {
        const item = this.free.pop() ?? this.factory();
        this.activeCount++;
        return item;
    }

    release(item) {
        if (!item) return;
        this.reset?.(item);
        this.free.push(item);
        this.activeCount = Math.max(0, this.activeCount - 1);
    }

    dispose(disposer) {
        if (disposer) this.free.forEach(disposer);
        this.free.length = 0;
        this.activeCount = 0;
    }
}
