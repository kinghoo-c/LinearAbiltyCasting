import {
    BufferGeometry,
    BufferAttribute,
    Mesh,
    MeshStandardMaterial,
    InstancedMesh,
    Object3D,
    Group,
    ShaderMaterial,
    AdditiveBlending,
    Color,
    DynamicDrawUsage,
    Sphere,
    Vector3,
    DoubleSide,
} from 'three';
import { createAsteroidGeometry } from '../assets/ProceduralGeometry.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { clamp, saturate, lerp, randRange, Easing } from '../utils/math.js';

/**
 * 熔融地裂——冲击之下，地面从内部撕裂开。
 *
 * 一片裂缝网络从冲击点向外奔涌：数条蜿蜒而非笔直的主枝，每条主枝又甩出
 * 闪电式的侧枝，整体画成贴着地面的条带。每条条带都渲染两遍——一遍是窄的
 * 白热 **核心** 层，一遍是宽的加性 **底辉** 层，后者把炽热的橙色涂到周围
 * 的石头上——同时沿裂缝两侧的唇缘掀起一块块玄武岩，让裂缝有物理上的起伏，
 * 而不是一片发光的贴花。
 *
 * 这是从 geometry-painter 沙盒里的熔融裂缝绘制模式移植过来的，并重新对准
 * 了弹坑：在那里裂缝沿着网格表面上的笔画走，而在这里它在地板平面上辐射开，
 * 这让坐标系的数学变得很简单（法线永远是 +Y），也让整片网络可以活在
 * **单位空间（unit space）** 里。
 *
 * 最后这一点才是关键。路径被烘焙进一个半径为 1 的圆盘，顶点着色器把它们
 * 乘以 `uRadius`，所以弹坑的触及范围就是一个实时滑杆，它重新缩放一片已经
 * 在地面上的网络，而不需要重建。宽度、侧枝密度、侧枝长度、热量和脉动出于
 * 同样的理由也都是 uniform。
 *
 * 缓冲区只分配一次。一次生成只重写它们，从不让它们增长。
 */

/** 整片网络里的条带节点数。生成器用完即停。 */
const MAX_NODES = 900;
/** 沿唇缘掀起的玄武岩块。 */
const MAX_LIPS = 44;
/** 侧枝按这个数量生成；密度滑杆负责剔除它们。 */
const MAX_BRANCHES = 8;
const TAU = Math.PI * 2;
/** 中心线的重采样步长，单位空间。 */
const STEP = 0.045;

const _dummy = new Object3D();

const FISSURE_VERTEX = /* glsl */ `
  uniform float uRadius;
  uniform float uWidth;
  uniform float uBranchFrac;
  uniform float uLenFrac;

  attribute vec3  aSide;
  attribute float aAcross;
  attribute float aDist;
  attribute float aJit;
  attribute float aWalk;
  attribute float aMaxWalk;
  attribute float aRank;

  varying float vAcross;
  varying float vDist;
  varying float vTaper;
  varying float vSel;

  void main() {
    // 只要一条侧枝的 rank 低于密度比例，它就能存活；主枝的 rank 是 0，
    // 所以它们永远不可能被剔除。
    float sel = step(aRank, uBranchFrac);
    // ……并且在长度滑杆当前结束的位置收束成一个尖点。
    float taper = pow(clamp(1.0 - aWalk / (aMaxWalk * uLenFrac + 1e-4), 0.0, 1.0), 0.7);

    vAcross = aAcross;
    vDist = aDist;
    vTaper = taper;
    vSel = sel;

    // 整片网络烘焙在一个单位圆盘里；触及范围是一个实时滑杆。
    vec3 centre = vec3(position.x * uRadius, position.y, position.z * uRadius);
    vec3 pos = centre + aSide * (uWidth * 0.5 * aAcross * aJit * taper * sel);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FISSURE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uGrown;
  uniform float uHeat;
  uniform float uPulse;
  uniform float uFade;
  uniform float uGlobalGlow;
  uniform vec3  uColorSeam;
  uniform vec3  uColorRed;
  uniform vec3  uColorOrange;
  uniform vec3  uColorWhite;

  varying float vAcross;
  varying float vDist;
  varying float vTaper;
  varying float vSel;

  void main() {
    // 裂缝只在奔涌的锋面之后才是张开的。
    float openness = smoothstep(0.0, 0.08, uGrown - vDist);
    if (openness <= 0.001 || vSel < 0.5) discard;

    #if FISSURE_PASS == 0                       /* 核心 */
      float centre = 1.0 - smoothstep(0.12, 1.0, abs(vAcross));
      float pulse = sin(vDist * 22.0 - uTime * uPulse * 2.6) * 0.28 + 0.72;
      float flicker = sin(uTime * 9.0 + vDist * 120.0) * 0.08 + 0.94;
      // 一道白色闪光乘着正在传播的裂缝锋面前行。
      float flash = (1.0 - smoothstep(0.0, 0.14, abs(uGrown - vDist))) * 1.6;

      float heat = centre * pulse * flicker * uHeat * (vTaper * 0.35 + 0.65) + flash;

      vec3 color = mix(uColorSeam, uColorRed, smoothstep(0.0, 0.55, heat));
      color = mix(color, uColorOrange, smoothstep(0.55, 1.15, heat));
      color = mix(color, uColorWhite, smoothstep(1.15, 2.1, heat));

      float edge = 1.0 - smoothstep(0.82, 1.0, abs(vAcross));
      float alpha = openness * edge * uFade;

    #else                                       /* 底辉 */
      float falloff = pow(max(1.0 - abs(vAcross), 0.0), 1.6);
      float pulse = sin(vDist * 22.0 - uTime * uPulse * 2.6) * 0.22 + 0.78;
      float strength = falloff * pulse * uHeat * (vTaper * 0.5 + 0.5) * 0.34;
      vec3 color = uColorOrange * strength;
      float alpha = openness * uFade * clamp(strength * 2.2, 0.0, 1.0);
    #endif

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/** 同一份条带几何体上的两遍绘制中，一个材质画的是哪一遍——CORE（核心）还是 GLOW（底辉）。 */
const FissurePass = Object.freeze({ CORE: 0, GLOW: 1 });

/* ---------------------------------------------------------------------- */
/* 一个弹坑份量的裂缝                                            */
/* ---------------------------------------------------------------------- */

class Fissure {
    constructor() {
        this.group = new Group();
        this.group.name = 'Fissure';

        const vertices = MAX_NODES * 2;
        this.positions = new Float32Array(vertices * 3);
        this.sides = new Float32Array(vertices * 3);
        this.across = new Float32Array(vertices);
        this.dists = new Float32Array(vertices);
        this.jitters = new Float32Array(vertices);
        this.walks = new Float32Array(vertices);
        this.maxWalks = new Float32Array(vertices);
        this.ranks = new Float32Array(vertices);
        // 每一对节点两个三角形；真正限制它的是绘制范围（draw range）。
        this.indices = new Uint16Array(MAX_NODES * 6);

        for (let i = 0; i < vertices; i++) this.across[i] = i % 2 === 0 ? -1 : 1;

        this.geometry = new BufferGeometry();
        const attribute = (array, size) => new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
        this.geometry.setAttribute('position', attribute(this.positions, 3));
        this.geometry.setAttribute('aSide', attribute(this.sides, 3));
        this.geometry.setAttribute('aAcross', attribute(this.across, 1));
        this.geometry.setAttribute('aDist', attribute(this.dists, 1));
        this.geometry.setAttribute('aJit', attribute(this.jitters, 1));
        this.geometry.setAttribute('aWalk', attribute(this.walks, 1));
        this.geometry.setAttribute('aMaxWalk', attribute(this.maxWalks, 1));
        this.geometry.setAttribute('aRank', attribute(this.ranks, 1));
        this.geometry.setIndex(new BufferAttribute(this.indices, 1));
        this.geometry.setDrawRange(0, 0);
        this.geometry.boundingSphere = new Sphere(new Vector3(), 1e4);

        this.materials = [];
        this.meshes = [];
        // 先画底辉，这样核心层叠在它上面做加性混合。
        for (const pass of [FissurePass.GLOW, FissurePass.CORE]) {
            const material = new ShaderMaterial({
                defines: { FISSURE_PASS: pass },
                transparent: true,
                depthWrite: false,
                depthTest: true,
                blending: AdditiveBlending,
                side: DoubleSide,
                toneMapped: false,
                uniforms: sharedUniforms({
                    uRadius: { value: 3 },
                    uWidth: { value: 0.12 },
                    uBranchFrac: { value: 0.7 },
                    uLenFrac: { value: 0.8 },
                    uGrown: { value: 0 },
                    uHeat: { value: 1.4 },
                    uPulse: { value: 1 },
                    uFade: { value: 1 },
                    uColorSeam: { value: new Color(0.02, 0.004, 0.002) },
                    uColorRed: { value: new Color(1.1, 0.1, 0.01) },
                    uColorOrange: { value: new Color(2.6, 0.85, 0.1) },
                    uColorWhite: { value: new Color(4.6, 3.6, 2.4) },
                }),
                vertexShader: FISSURE_VERTEX,
                fragmentShader: FISSURE_FRAGMENT,
            });

            const mesh = new Mesh(this.geometry, material);
            mesh.frustumCulled = false;
            mesh.layers.set(LAYER.VFX);
            mesh.renderOrder = pass === FissurePass.GLOW ? 7 : 9;
            this.group.add(mesh);
            this.materials.push(material);
            this.meshes.push(mesh);
        }

        /**
         * 沿唇缘掀起的玄武岩。
         *
         * 记录里只存"骰子"——一个单位空间锚点、它落在哪一侧的唇缘，以及几个
         * 抖动值。它们的米数每帧从设置里取，所以弹坑的触及范围和岩块大小都
         * 保持为实时滑杆。
         */
        // 切面很少：在这个细分级别下，一块被切得很碎的石头会扁成一颗卵石，
        // 而这些岩块要读起来像从地面里顶出来的地壳块。
        this.lipGeometry = createAsteroidGeometry({
            seed: 4.2,
            detail: 1,
            lumpiness: 0.34,
            cuts: 3,
            cutDepth: 0.16,
            craters: 2,
        });
        this.lipMaterial = new MeshStandardMaterial({
            color: 0x565056,
            roughness: 0.95,
            metalness: 0.02,
            flatShading: true,
        });
        this.lips = new InstancedMesh(this.lipGeometry, this.lipMaterial, MAX_LIPS);
        this.lips.castShadow = true;
        this.lips.receiveShadow = true;
        this.lips.frustumCulled = false;
        this.lips.count = 0;
        this.lips.layers.set(LAYER.WORLD);
        this.group.add(this.lips);

        this.lipRecords = [];
        for (let i = 0; i < MAX_LIPS; i++) {
            this.lipRecords.push({
                x: 0, // 单位空间锚点
                z: 0,
                sideX: 0, // 单位侧向，带符号：落在哪一侧的唇缘
                sideZ: 0,
                yaw: 0,
                dist: 0, // 它位于裂缝上的哪个位置，0..1
                size: 0, // 0..1 抖动
                flat: 0, // 0..1 压扁程度
                offset: 0, // 0..1 位于裂缝边缘之外多远
                rank: 0, // 随它所属的侧枝一起被剔除
            });
        }

        this.age = 0;
        this.life = 1;
        this.radius = 3;
        this.nodeCount = 0;
        this.lipCount = 0;
    }

    /* ------------------------------------------------------------------ */

    /**
     * 在单位空间里生成一片新的裂缝网络并上传。
     *
     * 这段游走刻意 *不是* 径向的：一条主枝前进时会偏转，它的侧枝偏转得更
     * 厉害，这正是"裂缝"与"从中心往外画线得到的那颗辐条星"之间的全部区别。
     *
     * @param {number} arms   从冲击点辐射出去的主裂缝数量
     * @param {number} wander 主枝的偏转强度，每走一个单位对应的弧度
     */
    _generate(arms, wander) {
        let node = 0;
        let quad = 0;

        const pushNode = (x, z, sx, sz, dist, jitter, walk, maxWalk, rank) => {
            if (node >= MAX_NODES) return false;
            const v = node * 2;
            for (let k = 0; k < 2; k++) {
                const i = v + k;
                this.positions[i * 3 + 0] = x;
                this.positions[i * 3 + 1] = 0;
                this.positions[i * 3 + 2] = z;
                this.sides[i * 3 + 0] = sx;
                this.sides[i * 3 + 1] = 0;
                this.sides[i * 3 + 2] = sz;
                this.dists[i] = dist;
                this.jitters[i] = jitter;
                this.walks[i] = walk;
                this.maxWalks[i] = maxWalk;
                this.ranks[i] = rank;
            }
            node++;
            return true;
        };

        /**
         * 让一条裂缝走过地面。
         * @returns {Array} 它铺下的节点，供侧枝挂靠
         */
        const walk = (startX, startZ, heading, length, rank, originDist, widthScale) => {
            const laid = [];
            let x = startX;
            let z = startZ;
            let angle = heading;
            let jitter = 1;
            const curvature = randRange(-wander, wander);
            const first = node;

            for (let travelled = 0; travelled <= length; travelled += STEP) {
                // 平滑过的随机游走 → 逐节点烘焙出有机的宽度变化。
                jitter = clamp(jitter + randRange(-0.18, 0.18), 0.6, 1.45);
                const dist = saturate(originDist + travelled);
                // 裂缝终止成一根针尖，而不是一个圆头。
                const tip = Math.pow(saturate((length - travelled) / 0.22), 0.65);
                const width = jitter * widthScale * (rank > 0 ? 0.62 : tip);

                // 侧向在地板平面内，与前进方向垂直。
                if (
                    !pushNode(
                        x,
                        z,
                        Math.cos(angle + Math.PI / 2),
                        Math.sin(angle + Math.PI / 2),
                        dist,
                        width,
                        rank > 0 ? travelled : 0,
                        rank > 0 ? length : 1,
                        rank
                    )
                )
                    break;
                laid.push({ x, z, angle, dist });

                x += Math.cos(angle) * STEP;
                z += Math.sin(angle) * STEP;
                // 偏转，再加一点高频抖动，让线条永远不会是平滑的。
                angle += curvature * STEP + randRange(-0.35, 0.35) * STEP;
                // ……但再把它拉回出发时的方位角，否则持续的偏转会
                // 把一条主枝卷成一个圆，而不是把它推离冲击点。
                angle = lerp(angle, heading, 0.06);
            }

            // 把这一段缝进索引缓冲区。不同的段之间永远不相接。
            for (let i = first; i < node - 1; i++) {
                const a = i * 2;
                this.indices[quad * 6 + 0] = a;
                this.indices[quad * 6 + 1] = a + 1;
                this.indices[quad * 6 + 2] = a + 2;
                this.indices[quad * 6 + 3] = a + 1;
                this.indices[quad * 6 + 4] = a + 3;
                this.indices[quad * 6 + 5] = a + 2;
                quad++;
            }
            return laid;
        };

        const spin = Math.random() * TAU;
        const mains = [];
        for (let i = 0; i < arms; i++) {
            // 间距不均匀：等角度无论怎么蜿蜒都会读成一颗星。
            const heading = spin + (i / arms) * TAU + randRange(-0.45, 0.45);
            const length = randRange(0.6, 1.0);
            // 从弹坑口外一点点开始，而不是从一个点上开始。
            const r0 = randRange(0.04, 0.12);
            mains.push(walk(Math.cos(heading) * r0, Math.sin(heading) * r0, heading, length, 0, r0, 1));
        }

        /* --- 侧枝，挂在主枝上 --- */
        for (let b = 0; b < MAX_BRANCHES; b++) {
            const arm = mains[Math.floor(Math.random() * mains.length)];
            if (!arm || arm.length < 4) continue;
            const at = arm[Math.floor(randRange(1, arm.length - 1))];
            const side = Math.random() < 0.5 ? 1 : -1;
            // 与父枝偏开 32°–72°，像闪电的分叉。
            const heading = at.angle + side * randRange(0.55, 1.25);
            walk(at.x, at.z, heading, randRange(0.18, 0.42), (b + 1) / MAX_BRANCHES, at.dist, 0.8);
        }

        this.nodeCount = node;
        this.geometry.setDrawRange(0, quad * 6);
        for (const name of ['position', 'aSide', 'aAcross', 'aDist', 'aJit', 'aWalk', 'aMaxWalk', 'aRank']) {
            this.geometry.attributes[name].needsUpdate = true;
        }
        this.geometry.index.needsUpdate = true;

        /* --- 沿唇缘的玄武岩 --- */
        let lip = 0;
        for (const arm of mains) {
            for (let i = 2; i < arm.length && lip < MAX_LIPS; i += 3) {
                const point = arm[i];
                const record = this.lipRecords[lip++];
                record.x = point.x;
                record.z = point.z;
                record.sideX = Math.cos(point.angle + Math.PI / 2) * (i % 6 === 2 ? 1 : -1);
                record.sideZ = Math.sin(point.angle + Math.PI / 2) * (i % 6 === 2 ? 1 : -1);
                record.yaw = point.angle + randRange(-0.5, 0.5);
                record.dist = point.dist;
                record.size = Math.random();
                record.flat = Math.random();
                record.offset = Math.random();
                record.rank = 0;
            }
        }
        this.lipCount = lip;
    }

    /** 根据实时设置摆放唇缘岩块的姿态。 */
    _poseLips(grown, sink) {
        const c = settings.meteor;
        let used = 0;

        for (let i = 0; i < this.lipCount; i++) {
            const record = this.lipRecords[i];
            // 当裂缝锋面经过时，岩块被顶起来。
            const emerge = saturate((grown - record.dist) / 0.18);
            const size = c.fissureRockSize * lerp(0.55, 1.35, record.size);

            if (emerge <= 0) {
                _dummy.position.set(0, -999, 0);
                _dummy.scale.setScalar(0.0001);
                _dummy.quaternion.identity();
            } else {
                const out = c.fissureWidth * 0.55 + record.offset * c.fissureWidth * 0.6 + size * 0.15;
                _dummy.position.set(
                    record.x * this.radius + record.sideX * out,
                    // 沉得很深，只有顶部的棱脊破土而出：是被撑破的地壳，
                    // 而不是散落在地板上的卵石。
                    -size * lerp(0.3, 0.6, record.flat) - sink * (size * 2 + 0.4),
                    record.z * this.radius + record.sideZ * out
                );
                _dummy.rotation.set(0, record.yaw, 0);
                const grow = Easing.outBack(emerge);
                _dummy.scale.set(size * grow, size * lerp(0.45, 0.85, record.flat) * grow, size * 0.8 * grow);
            }

            _dummy.updateMatrix();
            this.lips.setMatrixAt(i, _dummy.matrix);
            used = i + 1;
        }

        this.lips.count = used;
        this.lips.instanceMatrix.needsUpdate = true;
    }

    /* ------------------------------------------------------------------ */

    spawn(position, options) {
        const c = settings.meteor;
        this.age = 0;
        this.life = Math.max(0.2, options.life ?? c.fissureLife);
        this.radius = options.radius ?? c.fissureRadius;

        this.group.position.set(position.x, options.height ?? 0.02, position.z);
        this.group.rotation.y = Math.random() * TAU;

        this._generate(Math.max(2, Math.round(c.fissureArms)), c.fissureWander);
        this._poseLips(0, 0);
        this.sync(0);
    }

    /** 把实时设置推进两遍绘制里。 */
    sync(grown) {
        const c = settings.meteor;
        const g = settings.global;
        const t = saturate(this.age / this.life);

        // 熔融物在裂缝闭合之前很久就冷却了，随后整片裂缝淡出。
        const heat = c.fissureHeat * (1 - Easing.inQuad(saturate((t - 0.25) / 0.75))) * g.shaderIntensity;
        const fade = 1 - Easing.inQuad(saturate((t - 0.7) / 0.3));

        for (const material of this.materials) {
            const u = material.uniforms;
            u.uRadius.value = this.radius;
            u.uWidth.value =
                material.defines.FISSURE_PASS === FissurePass.CORE ? c.fissureWidth : c.fissureWidth * 3.4 + 0.16;
            u.uBranchFrac.value = saturate(c.fissureBranches);
            u.uLenFrac.value = saturate(c.fissureBranchLength);
            u.uGrown.value = grown;
            u.uHeat.value = heat;
            u.uPulse.value = c.fissurePulse;
            u.uFade.value = fade;
            u.uColorSeam.value.copy(getColor(c.colorScorch));
            u.uColorRed.value.copy(getColor(c.colorFlameEdge));
            u.uColorOrange.value.copy(getColor(c.colorCrack));
            u.uColorWhite.value.copy(getColor(c.colorHot));
        }

        // 焦黑，而不是灰色：这些岩块就坐在熔融物 *里*，而一块被火光照亮的
        // 中灰色石头会被读成散在地板上的浅色卵石。
        this.lipMaterial.color.copy(getColor(c.colorChar));
    }

    update(dt) {
        const c = settings.meteor;
        this.age += dt;
        const t = saturate(this.age / this.life);

        // 锋面从冲击点奔涌而出，随后在它消散时唇缘沉回去。
        const grown = saturate((this.age * c.fissureGrowth) / Math.max(0.05, this.radius));
        const sink = Easing.inCubic(saturate((t - 0.82) / 0.18));

        this.sync(grown);
        this._poseLips(grown, sink);

        return t < 1;
    }

    dispose() {
        this.geometry.dispose();
        this.lipGeometry.dispose();
        this.lipMaterial.dispose();
        this.lips.dispose();
        for (const material of this.materials) material.dispose();
    }
}

/* ---------------------------------------------------------------------- */

/**
 * 池化的裂缝网络。每次冲击复用一个实例，所以施放二十颗陨石最多也只会建出
 * 少量几份条带缓冲区。
 */
export class FissureSystem {
    constructor(scene) {
        this.group = new Group();
        this.group.name = 'Fissures';
        scene.add(this.group);

        this.active = [];
        this.pool = new ObjectPool(
            () => new Fissure(),
            (fissure) => {
                fissure.group.visible = false;
                this.group.remove(fissure.group);
            }
        );
    }

    /**
     * 把地面撕开。
     * @param {THREE.Vector3} position 被击中的位置
     * @param {object} [options] { radius, life, height }
     */
    spawn(position, options = {}) {
        const fissure = this.pool.acquire();
        fissure.spawn(position, options);
        fissure.group.visible = true;
        this.group.add(fissure.group);
        this.active.push(fissure);
        return fissure;
    }

    update(dt) {
        for (let i = this.active.length - 1; i >= 0; i--) {
            if (!this.active[i].update(dt)) {
                this.pool.release(this.active.splice(i, 1)[0]);
            }
        }
    }

    clear() {
        for (const fissure of this.active) this.pool.release(fissure);
        this.active.length = 0;
    }

    dispose() {
        this.clear();
        this.pool.dispose((fissure) => fissure.dispose());
        this.group.parent?.remove(this.group);
    }
}
