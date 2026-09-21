import {
    BufferGeometry,
    BufferAttribute,
    Float32BufferAttribute,
    IcosahedronGeometry,
    InstancedBufferGeometry,
    InstancedBufferAttribute,
    Sphere,
    Vector3,
} from 'three';
import { clamp, hash11, smoothstep } from '../utils/math.js';

/**
 * CPU 侧的程序化几何体。
 *
 * 除了角色之外，本项目不带任何网格资源，所以冰晶是在这里生成的。一块冰晶
 * 重建起来的开销足够低——六边形的一块只有 108 个三角形——因此编辑器里那
 * 几个*形状*滑块会直接重新生成它，而不是在顶点着色器里做近似。这正是
 * 棱面数、锥度和表面粗糙度能保持为实时控件的原因，在模拟暂停时也一样。
 *
 * 一切都由 `seed` 决定：同一个种子永远产出同一块冰晶，因此在施放途中重建
 * 会重塑整片冰原，而不会把它重新洗牌。
 */

const TAU = Math.PI * 2;

/**
 * 冰晶的高度 / 半径剖面，在下面这些环的高度上采样。
 * `t` 是到尖端路程的比例；返回的半径是底面半径的比例。
 */
const RING_HEIGHTS = [0, 0.22, 0.5, 0.75, 0.92];

function profileRadius(t, taper) {
    return taper + (1 - taper) * Math.pow(1 - t, 1.15);
}

/**
 * 单块冰晶：一个带锥度、有棱面、略微弯曲的棱柱。
 *
 * 单位空间——底面环位于 y = 0、外接半径为 0.5，顶点在 y = 1。因此一个实例
 * 可以独立缩放占地范围和高度，而 `local.y` 直接读作“我在这一块冰晶上有多高”，
 * 这正是 `materials/IceMaterial.js` 里雾凇分带所依据的量。
 *
 * @param {object} options
 * @param {number} [options.seed]      确定性的形状种子
 * @param {number} [options.sides]     棱柱一圈上的棱面数（5–8 最耐看）
 * @param {number} [options.taper]     尖端半径占底面的比例
 * @param {number} [options.roughness] 棱面偏离干净棱柱的程度
 * @param {number} [options.bend]      从底部到尖端的侧向弯曲量
 */
export function createCrystalGeometry({ seed = 1, sides = 6, taper = 0.13, roughness = 0.28, bend = 0.22 } = {}) {
    const facets = Math.max(3, Math.round(sides));
    const tipRadius = Math.min(0.9, Math.max(0.01, taper));

    // 每块冰晶只用一个固定的弯曲方向，这样整片冰原倾斜起来才可信，
    // 而不是每一根尖刺都朝同一个方向弯。
    const bendAngle = hash11(seed * 1.77) * TAU;
    const bendX = Math.cos(bendAngle);
    const bendZ = Math.sin(bendAngle);

    /** 高度为 `t` 处，冰晶轴线的横向漂移量。 */
    const axisOffset = (t) => bend * 0.5 * Math.pow(t, 1.6);

    // --- 环 -----------------------------------------------------------------
    // 角度只抖动一次，并被每一个环共用，这样棱面在整块冰晶上保持为连续的
    // 棱边，而不会扭成一根螺丝。
    const angles = [];
    for (let i = 0; i < facets; i++) {
        const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / facets) * 0.55 * roughness * 3;
        angles.push((i / facets) * TAU + jitter);
    }

    const rings = RING_HEIGHTS.map((t, ringIndex) => {
        const baseR = profileRadius(t, tipRadius) * 0.5;
        const drift = axisOffset(t);
        // 高度上的抖动，避免各条肩线叠成一道道干净的横带。
        const y = t + (hash11(seed * 5.9 + ringIndex * 2.3) - 0.5) * 0.06 * roughness * (t > 0 ? 1 : 0);

        return angles.map((angle, i) => {
            // 不规则程度朝尖端递增：冰晶在离开地面的地方大致还是圆的，
            // 越往上（被撕开的地方）就越参差不齐。
            const wobble =
                1 + (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) * roughness * 1.3 * (0.35 + 0.65 * t);
            const r = Math.max(0.002, baseR * wobble);
            return [Math.cos(angle) * r + bendX * drift, y, Math.sin(angle) * r + bendZ * drift];
        });
    });

    // 顶点稍微偏离轴线，好让尖端看起来像是被磕掉的，
    // 而不是一个圆锥的顶点。
    const apexDrift = axisOffset(1);
    const apex = [
        bendX * apexDrift + (hash11(seed * 17.3) - 0.5) * 0.09 * roughness,
        1,
        bendZ * apexDrift + (hash11(seed * 19.7) - 0.5) * 0.09 * roughness,
    ];
    const floorCentre = [0, 0, 0];

    // --- 三角形 -----------------------------------------------------------
    const positions = [];
    const push = (p) => positions.push(p[0], p[1], p[2]);

    for (let ring = 0; ring < rings.length - 1; ring++) {
        const lower = rings[ring];
        const upper = rings[ring + 1];
        for (let i = 0; i < facets; i++) {
            const j = (i + 1) % facets;
            push(lower[i]);
            push(lower[j]);
            push(upper[i]);
            push(lower[j]);
            push(upper[j]);
            push(upper[i]);
        }
    }

    const top = rings[rings.length - 1];
    const base = rings[0];
    for (let i = 0; i < facets; i++) {
        const j = (i + 1) % facets;
        push(top[i]);
        push(top[j]);
        push(apex); // 顶点
        push(floorCentre);
        push(base[j]);
        push(base[i]); // 底面
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    // 非索引化 + 逐面法线：正是这一点让棱面显得锐利。
    geometry.computeVertexNormals();
    return geometry;
}

/**
 * 一块矮而宽的冰晶碎片——就是填在主要尖刺周围、高到脚踝的那些碎块。
 * 单位空间相同，所以它走的是完全一样的实例化路径。
 */
export function createShardGeometry(seed = 5, sides = 5) {
    return createCrystalGeometry({
        seed: seed * 2.7 + 41,
        sides,
        taper: 0.22,
        roughness: 0.55,
        bend: 0.35,
    });
}

/* ---------------------------------------------------------------------- */
/* 小行星                                                                  */
/* ---------------------------------------------------------------------- */

/** 下面这套值噪声的一个晶格角点。 */
function lattice(ix, iy, iz, seed) {
    return hash11(ix * 127.1 + iy * 311.7 + iz * 74.7 + seed * 19.19);
}

/**
 * 确定性的 3D 值噪声，0..1。
 *
 * GLSL 库里有 simplex 噪声，但小行星是在 CPU 上做位移的
 * （顶点着色器无法移动一个投射阴影者的轮廓，也移动不了它的法线），所以
 * 这里需要一个 JS 版本。在做过 smoothstep 的晶格上取值噪声就足够了：
 * 这个形状是在轮廓上被读到的，而不是凑近了看，而这块岩石的*细节*
 * 来自那些平整棱面，以及叠加在上面的裂缝着色器。
 */
function valueNoise3(x, y, z, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;

    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const uz = fz * fz * (3 - 2 * fz);

    const c000 = lattice(ix, iy, iz, seed);
    const c100 = lattice(ix + 1, iy, iz, seed);
    const c010 = lattice(ix, iy + 1, iz, seed);
    const c110 = lattice(ix + 1, iy + 1, iz, seed);
    const c001 = lattice(ix, iy, iz + 1, seed);
    const c101 = lattice(ix + 1, iy, iz + 1, seed);
    const c011 = lattice(ix, iy + 1, iz + 1, seed);
    const c111 = lattice(ix + 1, iy + 1, iz + 1, seed);

    const x00 = c000 + (c100 - c000) * ux;
    const x10 = c010 + (c110 - c010) * ux;
    const x01 = c001 + (c101 - c001) * ux;
    const x11 = c011 + (c111 - c011) * ux;

    const y0 = x00 + (x10 - x00) * uy;
    const y1 = x01 + (x11 - x01) * uy;

    return y0 + (y1 - y0) * uz;
}

/** 在 `valueNoise3` 上做的带符号 fbm，大致在 -1..1。 */
function fbmValue(x, y, z, seed, octaves) {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    for (let i = 0; i < octaves; i++) {
        value += amplitude * (valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7.7) * 2 - 1);
        frequency *= 2.03;
        amplitude *= 0.5;
    }
    return value;
}

/**
 * 一颗陨石：一个碎裂、布满陨坑的石球。
 *
 * 单位空间——一个半径为 1 的二十面体球，其顶点沿各自的方向被推进推出，
 * 因此一个实例可以直接把它按米缩放，而 `local` 读作岩石上的一个方向。
 * 这一点很重要，因为 `materials/MeteorMaterial.js` 正是在那个空间里采样
 * 它的熔岩缝隙：裂缝是焊在岩石上的，会随它一起翻滚，而不是在它里面游动。
 *
 * 有三样东西层层叠加，才让它读起来像*石头*，而不是一个晃晃悠悠的球：
 *
 *  1. **fbm 块面**——大形状，让任何两个方向看起来都不一样。
 *  2. **平面切割**——岩石被几组随机的半空间切过：平面之外的东西
 *     都被推回到平面上。这会留下真正平坦的面在硬边处相交，采石场里的石头
 *     和被砸碎的石头正是这个样子，这也是它与一个做过位移的球体之间
 *     最大的区别。
 *  3. **陨坑**——带隆起喷射物边缘的碗，直接穿透以上所有东西。
 *
 * 位移是顶点*方向*的纯函数，正因如此，几何体才能非索引化（平整棱面需要）
 * 而不裂开——重复的顶点共享同一个方向，所以它们的位移完全相同。
 *
 * @param {object} options
 * @param {number} [options.seed]        确定性的形状种子
 * @param {number} [options.detail]      二十面体球的细分级别，0–3
 * @param {number} [options.lumpiness]   低频形变，× 半径
 * @param {number} [options.noiseScale]  每单位半径上的块面数
 * @param {number} [options.roughness]   高频的缺口
 * @param {number} [options.cuts]        从它身上切下的平整断裂面数量
 * @param {number} [options.cutDepth]    这些平面切进去多深，× 半径
 * @param {number} [options.craters]     砸进它身上的撞击碗数量
 * @param {number} [options.craterDepth] 那些碗挖到多深，× 半径
 * @param {number} [options.craterSize]  它们的角半径，弧度
 */
export function createAsteroidGeometry({
    seed = 1,
    detail = 3,
    lumpiness = 0.26,
    noiseScale = 1.5,
    roughness = 0.16,
    cuts = 7,
    cutDepth = 0.2,
    craters = 5,
    craterDepth = 0.18,
    craterSize = 0.5,
} = {}) {
    const geometry = new IcosahedronGeometry(1, clamp(Math.round(detail), 0, 3)).toNonIndexed();
    const array = geometry.attributes.position.array;

    /** 单位球面上的一个确定性点。 */
    const direction = (a, b) => {
        const phi = Math.acos(2 * hash11(a) - 1);
        const theta = hash11(b) * TAU;
        const sinPhi = Math.sin(phi);
        return { x: sinPhi * Math.cos(theta), y: Math.cos(phi), z: sinPhi * Math.sin(theta) };
    };

    // 切割与陨坑按种子只挑一次，并由每个顶点共用，因此下面的顶点循环
    // 始终只是一次纯粹的查表。
    const planes = [];
    for (let i = 0; i < Math.max(0, Math.round(cuts)); i++) {
        const n = direction(seed * 2.3 + i * 9.1, seed * 5.7 + i * 4.3);
        // 平面沿自身法线坐在多远处：1 表示相切（不切进去），更小则会削掉一个面。
        // 保持在 0.55 以上，这样任何一次切割都不会把岩石砍成两半。
        n.offset = 1 - cutDepth * (0.35 + 0.9 * hash11(seed * 13.1 + i * 6.7));
        planes.push(n);
    }

    const bowls = [];
    for (let i = 0; i < Math.max(0, Math.round(craters)); i++) {
        const c = direction(seed * 3.1 + i * 12.9, seed * 7.7 + i * 5.3);
        c.radius = Math.max(0.08, craterSize * (0.45 + 0.8 * hash11(seed * 11.3 + i * 3.7)));
        c.depth = craterDepth * (0.5 + hash11(seed * 17.9 + i * 2.1));
        bowls.push(c);
    }

    for (let i = 0; i < array.length; i += 3) {
        // IcosahedronGeometry(1) 交给我们的顶点本来就是单位长度的。
        const x = array[i];
        const y = array[i + 1];
        const z = array[i + 2];

        /* --- 1. 坑坑洼洼的躯体 --- */
        let radius = 1;
        radius += fbmValue(x * noiseScale, y * noiseScale, z * noiseScale, seed, 3) * lumpiness;
        radius +=
            fbmValue(x * noiseScale * 4.3, y * noiseScale * 4.3, z * noiseScale * 4.3, seed + 31.7, 2) *
            roughness *
            0.5;

        /* --- 2. 陨坑，放在切割之前，这样一次切割才可能把一个坑剪成两半 --- */
        for (const bowl of bowls) {
            const angle = Math.acos(clamp(x * bowl.x + y * bowl.y + z * bowl.z, -1, 1));
            const q = angle / bowl.radius;
            if (q >= 1.4) continue;
            radius -= bowl.depth * Math.max(0, 1 - q * q);
            radius += bowl.depth * 0.5 * smoothstep(0.72, 1.0, q) * (1 - smoothstep(1.0, 1.4, q));
        }

        radius = Math.max(0.35, radius);
        let px = x * radius;
        let py = y * radius;
        let pz = z * radius;

        /* --- 3. 切掉那些平整的面 --- */
        for (const plane of planes) {
            const along = px * plane.x + py * plane.y + pz * plane.z;
            const over = along - plane.offset;
            if (over <= 0) continue;
            // 投影回平面上。每一个在平面之外的顶点都会落到*平面之上*，
            // 所以结果是一块真正平坦的面，而不是一条被压扁的曲线。
            px -= plane.x * over;
            py -= plane.y * over;
            pz -= plane.z * over;
        }

        array[i] = px;
        array[i + 1] = py;
        array[i + 2] = pz;
    }

    geometry.attributes.position.needsUpdate = true;
    // 非索引化 + 逐面法线：棱面保持锐利，和冰晶一样。
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

/**
 * 闪电细丝所绘制的那条带子——一排平坦的四边形，位于*参数*空间
 * 而不是世界空间。
 *
 * 每个顶点携带 `position = (t, side, 0)`，其中 `t` 从施法者的手到命中点
 * 由 0 走到 1，`side` 是横跨丝带的 ±1。这里完全没有“米”这个单位：
 * `materials/LightningMaterial.js` 每帧把这一对值变成世界空间位置，所以
 * 一条带子可以服务于任意长度、任意形状、任意粗细的一道闪电，
 * 整条路径也都能保持为实时滑块。
 *
 * 一个实例就是一根细丝，`aStrand` 就是它的下标——着色器由它推导出
 * 这根细丝的种子、它在扇形里的位置以及它的宽度。
 *
 * @param {number} nodes   沿闪电的采样数；扭折细节的上限
 * @param {number} strands 实例容量（实际存活数由 `instanceCount` 决定）
 */
export function createBoltRibbonGeometry(nodes = 72, strands = 24) {
    const steps = Math.max(2, Math.round(nodes));
    const count = Math.max(1, Math.round(strands));

    const positions = new Float32Array(steps * 2 * 3);
    for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const o = i * 6;
        positions[o + 0] = t;
        positions[o + 1] = -1;
        positions[o + 3] = t;
        positions[o + 4] = 1;
    }

    const indices = new Uint16Array((steps - 1) * 6);
    for (let i = 0; i < steps - 1; i++) {
        const a = i * 2;
        const o = i * 6;
        indices[o + 0] = a;
        indices[o + 1] = a + 1;
        indices[o + 2] = a + 2;
        indices[o + 3] = a + 1;
        indices[o + 4] = a + 3;
        indices[o + 5] = a + 2;
    }

    const strandIndex = new Float32Array(count);
    for (let i = 0; i < count; i++) strandIndex[i] = i;

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aStrand', new InstancedBufferAttribute(strandIndex, 1));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.instanceCount = count;
    // 闪电是在顶点着色器里于世界空间构建的，所以几何体自己的包围盒
    // 没有意义——改为手动做剔除（技能会设置
    // `frustumCulled = false`）。
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    return geometry;
}

/* ---------------------------------------------------------------------- */
/* 光束                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * 光束所绘制的那根柱体——一个位于*参数*空间的管。
 *
 * 与闪电带子同样的把戏，只是多了一个维度：每个顶点携带
 * `position = (t, a, 0)`，其中 `t` 从枪口到命中点由 0 走到 1，`a` 绕管身
 * 一圈由 0 走到 1。这里同样没有“米”；`materials/BeamMaterial.js` 每帧把
 * 这一对值变成世界空间位置，所以一根管可以服务于任意长度、任意剖面的光束。
 *
 * 用真正的管，而不是闪电那种朝向相机的带子，因为这么粗的光束必须*有*
 * 一个横截面：绕它环绕时轮廓必须正确地鼓起，远侧的壁必须能透过近侧的壁
 * 叠加出来，冲击环也必须能贴住它。带子这些一样都伪造不出来。
 *
 * 接缝那一列被复制了一份，使 `a` 能取满 1.0 而不是回绕到 0——否则
 * 着色器里的角度噪声会在光束全长上显出一条生硬的接缝。
 *
 * @param {number} nodes 沿柱体的采样数；剖面细节的上限
 * @param {number} sides 管身一圈上的棱面数（20–32 看起来干净）
 */
export function createBeamTubeGeometry(nodes = 96, sides = 26) {
    const steps = Math.max(2, Math.round(nodes));
    const facets = Math.max(3, Math.round(sides));
    const columns = facets + 1;

    const positions = new Float32Array(steps * columns * 3);
    let v = 0;
    for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        for (let j = 0; j < columns; j++) {
            positions[v++] = t;
            positions[v++] = j / facets;
            positions[v++] = 0;
        }
    }

    const indices = new Uint16Array((steps - 1) * facets * 6);
    let k = 0;
    for (let i = 0; i < steps - 1; i++) {
        for (let j = 0; j < facets; j++) {
            const a = i * columns + j;
            const b = a + columns;
            indices[k++] = a;
            indices[k++] = b;
            indices[k++] = a + 1;
            indices[k++] = b;
            indices[k++] = b + 1;
            indices[k++] = a + 1;
        }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    // 跟闪电一样由顶点着色器放到世界空间里——它自己的包围盒
    // 没有意义（技能会设置 `frustumCulled = false`）。
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    return geometry;
}

/**
 * 沿光束飞奔而下的冲击圆盘——一个实例化的圆环，同样位于参数空间：
 * `position = (band, a, 0)`，`band` 在内缘是 0、在外缘是 1，`a` 绕一圈。
 *
 * 一个实例就是一个圆盘，`aRing` 只是它的下标——着色器由它把圆盘沿柱体
 * 均匀铺开、并让它们朝前方滑动，因此整列车队是时钟的函数，
 * 而不是 CPU 上的一个队列。
 *
 * @param {number} rings    实例容量（实际存活数由 `instanceCount` 决定）
 * @param {number} segments 一个圆盘一圈上的棱面数
 */
export function createBeamRingGeometry(rings = 10, segments = 44) {
    const count = Math.max(1, Math.round(rings));
    const facets = Math.max(6, Math.round(segments));
    const columns = facets + 1;

    const positions = new Float32Array(2 * columns * 3);
    let v = 0;
    for (let band = 0; band < 2; band++) {
        for (let j = 0; j < columns; j++) {
            positions[v++] = band;
            positions[v++] = j / facets;
            positions[v++] = 0;
        }
    }

    const indices = new Uint16Array(facets * 6);
    let k = 0;
    for (let j = 0; j < facets; j++) {
        const a = j;
        const b = columns + j;
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = a + 1;
        indices[k++] = b;
        indices[k++] = b + 1;
        indices[k++] = a + 1;
    }

    const ringIndex = new Float32Array(count);
    for (let i = 0; i < count; i++) ringIndex[i] = i;

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aRing', new InstancedBufferAttribute(ringIndex, 1));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.instanceCount = count;
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    return geometry;
}
