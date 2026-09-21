import { Points, BufferGeometry, BufferAttribute, ShaderMaterial, AdditiveBlending, Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';

const COUNT = 2600;
const VOLUME = new Vector3(46, 14, 46);

/**
 * 环境浮尘。
 *
 * 一次 Points 绘制调用；全部动画（漂移、卷曲、闪烁、在体积内卷绕
 * 回绕）都在顶点着色器中完成，因此每帧的 CPU 开销只是一次 uniform 写入。
 */
export class DustMotes {
    /**
     * 【详解】构建 2600 粒浮尘，要点四个：
     * 1. 顶点数据：位置在 46×14×46 m 体积内均匀随机，另给每粒一个随机
     *    种子 aSeed(0..1)——速度、点大小、色调、闪烁相位全部由它派生，
     *    同一份数据驱动出个体差异；
     * 2. boundingSphere 置 null + frustumCulled=false：点云要跟随角色平移，
     *    不能被视锥剔除误伤，干脆关闭剔除（2600 点全画也很便宜）；
     * 3. ShaderMaterial：加性混合（越重叠越亮，符合"光尘"感）、不写深度
     *    （避免粒子互相裁切出硬边）、fog=false（浮尘自身带光感，过雾会发灰）；
     * 4. renderOrder=-1 让浮尘最先绘制，作为场景氛围垫底，技能特效画在上层。
     */
    constructor() {
        const geometry = new BufferGeometry();
        const positions = new Float32Array(COUNT * 3);
        const seeds = new Float32Array(COUNT);

        for (let i = 0; i < COUNT; i++) {
            positions[i * 3 + 0] = (Math.random() - 0.5) * VOLUME.x;
            positions[i * 3 + 1] = Math.random() * VOLUME.y;
            positions[i * 3 + 2] = (Math.random() - 0.5) * VOLUME.z;
            seeds[i] = Math.random();
        }

        geometry.setAttribute('position', new BufferAttribute(positions, 3));
        geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
        geometry.boundingSphere = null;

        this.material = new ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
            fog: false,
            uniforms: {
                uTime: { value: 0 },
                uAmount: { value: 1 },
                uSize: { value: 20 },
                uPixelRatio: { value: 1 },
                uVolume: { value: VOLUME.clone() },
            },
            vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        uniform vec3 uVolume;
        attribute float aSeed;
        varying float vAlpha;
        varying float vSeed;
        ${noiseGLSL}

        void main() {
          vSeed = aSeed;
          vec3 p = position;

          // 缓慢的浮力式漂移，叠加 curl 噪声的摇摆。
          float t = uTime * (0.05 + aSeed * 0.06);
          p.y += mod(uTime * (0.12 + aSeed * 0.25), uVolume.y);
          p.y = mod(p.y, uVolume.y);
          p += curlNoise(p * 0.06 + vec3(0.0, t, 0.0)) * 1.35;

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float dist = -mv.z;

          // 闪烁 + 距离衰减。
          float twinkle = 0.55 + 0.45 * sin(uTime * (1.1 + aSeed * 2.6) + aSeed * 40.0);
          vAlpha = twinkle * smoothstep(90.0, 12.0, dist) * smoothstep(0.5, 4.0, dist);

          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (0.35 + aSeed * 0.9) / max(dist, 1.0);
        }
      `,
            fragmentShader: /* glsl */ `
        uniform float uAmount;
        varying float vAlpha;
        varying float vSeed;

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float mask = smoothstep(0.5, 0.02, d);
          vec3 tint = mix(vec3(1.0, 0.93, 0.78), vec3(0.78, 0.9, 1.0), vSeed);
          float a = mask * vAlpha * uAmount * 0.3;
          if (a < 0.002) discard;
          gl_FragColor = vec4(tint, a);
        }
      `,
        });

        this.points = new Points(geometry, this.material);
        this.points.frustumCulled = false;
        this.points.layers.set(LAYER.VFX);
        this.points.renderOrder = -1;
        this.points.name = 'DustMotes';
    }

    /**
     * 【详解】把设备像素比写进 uniform，驱动 gl_PointSize 的 uPixelRatio 因子。
     * 由 App 的 resize 回调触发；不写的话，窗口拖到高 DPI 屏上粒子会变小。
     */
    setPixelRatio(ratio) {
        this.material.uniforms.uPixelRatio.value = ratio;
    }

    /**
     * 【详解】每帧由 App.frame() 调用，三件事：
     * 1. 写 uTime——顶点着色器里的上浮、卷曲、闪烁全部由它驱动（CPU 侧
     *    唯一的每帧工作）；
     * 2. 写 uAmount——同步 settings 的 dustAmount，编辑器可调浮尘浓度；
     * 3. 把点云整体平移到 anchor（角色位置）的 xz——浮尘体积永远以战斗为
     *    中心，但只是 modelMatrix 平移，2600 个顶点位置不重新上传。
     */
    update(elapsed, anchor) {
        this.material.uniforms.uTime.value = elapsed;
        this.material.uniforms.uAmount.value = settings.environment.dustAmount;
        // 在不重新上传位置数据的前提下，让浮尘体积始终对中战斗位置。
        if (anchor) this.points.position.set(anchor.x, 0, anchor.z);
    }

    dispose() {
        this.points.geometry.dispose();
        this.material.dispose();
    }
}
