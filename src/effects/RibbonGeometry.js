import { BufferGeometry, BufferAttribute, Vector3, Sphere, DynamicDrawUsage } from 'three';

const _tangent = new Vector3();
const _side = new Vector3();
const _view = new Vector3();
const _up = new Vector3(0, 1, 0);
const _p = new Vector3();
const _normal = new Vector3();

export const RibbonMode = Object.freeze({
    /** 飘带平躺在地面内——用于施放预览。 */
    FLAT: 'flat',
    /** 飘带始终朝向相机——用于火焰流。 */
    BILLBOARD: 'billboard',
    /** 飘带保持每次更新传入的固定法线——用于水流的扭转。 */
    ORIENTED: 'oriented',
    /**
     * 竖直幕布：下边缘落在折线上，上边缘在其上方 `width` 处。用于火焰流与
     * 风的飘带——这些效果需要真正的高度，而不是一条面向相机的窄带。
     */
    UPRIGHT: 'upright',
});

/**
 * 可复用、预分配的三角带飘带。
 *
 * 项目里每一类拖尾式效果（施放预览、火焰流、水带、风的螺旋）都是沿折线铺开
 * 的飘带，所以它们共用这一个构建器。缓冲区在构造时一次性分配；`build()` 只
 * 重写它需要的顶点并移动绘制范围——没有逐帧分配，也没有几何体的反复重建。
 *
 * 产出的顶点 attribute：
 *  - position  世界空间（几何体以单位矩阵参与运算）
 *  - uv        x = 沿飘带方向（0..1），y = 横向（0..1）
 *  - aDist     沿飘带的弧长比例（0..1）
 *  - aSide     -1 / +1，表示顶点位于哪一条边上
 *  - aRandom   每个顶点稳定的噪声种子
 *
 * 使用 `{ frame: true }` 时还会写入两个 attribute：
 *  - aCenter   该顶点所偏移自的那个折线点
 *  - aTangent  该处的折线切线
 * 它们让片元着色器重建曲线的局部坐标系，这正是体积火焰光线步进所需要的：
 * 飘带对它来说只是代理外壳，真正的火焰存在于 `aCenter` / `aTangent` 周围。
 */
export class RibbonGeometry {
    constructor(maxSegments = 128, { frame = false } = {}) {
        this.maxSegments = maxSegments;
        this.hasFrame = frame;
        const vertexCount = (maxSegments + 1) * 2;

        this.geometry = new BufferGeometry();
        this.positions = new Float32Array(vertexCount * 3);
        this.normals = new Float32Array(vertexCount * 3);
        this.uvs = new Float32Array(vertexCount * 2);
        this.dists = new Float32Array(vertexCount);
        this.sides = new Float32Array(vertexCount);
        this.randoms = new Float32Array(vertexCount);
        this.centers = frame ? new Float32Array(vertexCount * 3) : null;
        this.tangents = frame ? new Float32Array(vertexCount * 3) : null;

        for (let i = 0; i < vertexCount; i++) {
            this.sides[i] = i % 2 === 0 ? -1 : 1;
            this.randoms[i] = Math.random();
        }

        const indices = new Uint16Array(maxSegments * 6);
        for (let s = 0; s < maxSegments; s++) {
            const a = s * 2;
            indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], s * 6);
        }

        this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
        this.geometry.setAttribute('aNormal', new BufferAttribute(this.normals, 3).setUsage(DynamicDrawUsage));
        this.geometry.setAttribute('uv', new BufferAttribute(this.uvs, 2).setUsage(DynamicDrawUsage));
        this.geometry.setAttribute('aDist', new BufferAttribute(this.dists, 1).setUsage(DynamicDrawUsage));
        this.geometry.setAttribute('aSide', new BufferAttribute(this.sides, 1));
        this.geometry.setAttribute('aRandom', new BufferAttribute(this.randoms, 1));
        if (frame) {
            this.geometry.setAttribute('aCenter', new BufferAttribute(this.centers, 3).setUsage(DynamicDrawUsage));
            this.geometry.setAttribute('aTangent', new BufferAttribute(this.tangents, 3).setUsage(DynamicDrawUsage));
        }
        this.geometry.setIndex(new BufferAttribute(indices, 1));
        this.geometry.setDrawRange(0, 0);
        this.geometry.boundingSphere = new Sphere(new Vector3(), 1000);

        this.segmentCount = 0;
    }

    /**
     * 由一条折线重建飘带。
     *
     * @param {Vector3[]} points       世界空间中的折线（>= 2 个点）
     * @param {object}    options
     * @param {number}    options.width 世界单位下的基础半宽
     * @param {string}    [options.mode] RibbonMode 之一
     * @param {Vector3}   [options.cameraPosition] BILLBOARD 模式必需
     * @param {Vector3}   [options.normal] ORIENTED 模式使用的固定法线
     * @param {(t:number, i:number) => number} [options.widthProfile] 0..1 → 乘数
     * @param {number}    [options.count] 要使用的点数（默认为 points.length）
     */
    build(points, options) {
        const count = Math.min(options.count ?? points.length, this.maxSegments + 1);
        if (count < 2) {
            this.segmentCount = 0;
            this.geometry.setDrawRange(0, 0);
            return this;
        }

        const {
            width = 0.5,
            mode = RibbonMode.BILLBOARD,
            cameraPosition = null,
            normal = null,
            widthProfile = null,
            twist = 0,
            twistPhase = 0,
        } = options;

        // 第一遍：先算弧长，这样 UV 与各种曲线以距离而非索引为参数——
        // 点在间距不均时贴图也不会被拉伸。
        let total = 0;
        for (let i = 1; i < count; i++) total += points[i].distanceTo(points[i - 1]);
        const invTotal = total > 1e-5 ? 1 / total : 0;

        let travelled = 0;
        for (let i = 0; i < count; i++) {
            const point = points[i];

            if (i > 0) travelled += point.distanceTo(points[i - 1]);
            const t = travelled * invTotal;

            // 切线取自相邻采样点（可能时用中心差分）。
            if (i === 0) _tangent.copy(points[1]).sub(points[0]);
            else if (i === count - 1) _tangent.copy(points[count - 1]).sub(points[count - 2]);
            else _tangent.copy(points[i + 1]).sub(points[i - 1]);
            if (_tangent.lengthSq() < 1e-10) _tangent.set(0, 0, 1);
            _tangent.normalize();

            const upright = mode === RibbonMode.UPRIGHT;

            if (upright) {
                _side.copy(_up);
            } else if (mode === RibbonMode.FLAT) {
                _side.crossVectors(_tangent, _up);
            } else if (mode === RibbonMode.ORIENTED && normal) {
                _side.crossVectors(_tangent, normal);
            } else {
                _view.copy(cameraPosition ?? _up).sub(point);
                _side.crossVectors(_tangent, _view);
            }
            if (_side.lengthSq() < 1e-10) _side.set(1, 0, 0);
            _side.normalize();

            // 可选的扭转：随着飘带向前推进，绕它自身的切线滚转，
            // 这正是水带那副螺旋感的来源。
            if (twist !== 0) _side.applyAxisAngle(_tangent, twist * t + twistPhase);

            // 供飘带着色器做光照 / 菲涅尔的表面法线。
            _normal.crossVectors(_tangent, _side).normalize();

            const scaled = width * (widthProfile ? widthProfile(t, i) : 1);
            // 竖直飘带从折线上长出来；其余几种则跨在折线两侧。
            const lowOffset = upright ? 0 : -scaled * 0.5;
            const highOffset = upright ? scaled : scaled * 0.5;

            const i2 = i * 2;
            _p.copy(point).addScaledVector(_side, lowOffset);
            this.positions[i2 * 3 + 0] = _p.x;
            this.positions[i2 * 3 + 1] = _p.y;
            this.positions[i2 * 3 + 2] = _p.z;

            _p.copy(point).addScaledVector(_side, highOffset);
            this.positions[(i2 + 1) * 3 + 0] = _p.x;
            this.positions[(i2 + 1) * 3 + 1] = _p.y;
            this.positions[(i2 + 1) * 3 + 2] = _p.z;

            for (let v = 0; v < 2; v++) {
                this.normals[(i2 + v) * 3 + 0] = _normal.x;
                this.normals[(i2 + v) * 3 + 1] = _normal.y;
                this.normals[(i2 + v) * 3 + 2] = _normal.z;
            }

            if (this.hasFrame) {
                for (let v = 0; v < 2; v++) {
                    const o = (i2 + v) * 3;
                    this.centers[o + 0] = point.x;
                    this.centers[o + 1] = point.y;
                    this.centers[o + 2] = point.z;
                    this.tangents[o + 0] = _tangent.x;
                    this.tangents[o + 1] = _tangent.y;
                    this.tangents[o + 2] = _tangent.z;
                }
            }

            this.uvs[i2 * 2 + 0] = t;
            this.uvs[i2 * 2 + 1] = 0;
            this.uvs[(i2 + 1) * 2 + 0] = t;
            this.uvs[(i2 + 1) * 2 + 1] = 1;

            this.dists[i2] = t;
            this.dists[i2 + 1] = t;
        }

        this.segmentCount = count - 1;

        const vertexCount = count * 2;
        const { position, uv, aDist: dist, aNormal: normals, aCenter, aTangent } = this.geometry.attributes;

        const uploads = [
            [position, 3],
            [normals, 3],
            [uv, 2],
            [dist, 1],
        ];
        if (this.hasFrame) uploads.push([aCenter, 3], [aTangent, 3]);

        for (const [attribute, itemSize] of uploads) {
            attribute.needsUpdate = true;
            attribute.clearUpdateRanges?.();
            attribute.addUpdateRange?.(0, vertexCount * itemSize);
        }

        this.geometry.setDrawRange(0, this.segmentCount * 6);
        return this;
    }

    /** 隐藏飘带而不触碰它的缓冲区。 */
    clear() {
        this.segmentCount = 0;
        this.geometry.setDrawRange(0, 0);
    }

    dispose() {
        this.geometry.dispose();
    }
}
