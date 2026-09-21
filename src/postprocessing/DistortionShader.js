/**
 * 应用由 LAYER.DISTORTION 写入的屏幕空间折射缓冲。
 *
 * 缓冲在 RG 通道保存以 0.5 为零点编码的偏移量，B 通道保存强度，
 * A 通道保存覆盖遮罩，因此热浪、水面折射与御气术冲击波都经由
 * 这一个 pass 扭曲画面。
 */
export const DistortionShader = {
    name: 'DistortionShader',

    uniforms: {
        tDiffuse: { value: null },
        tDistortion: { value: null },
        uScale: { value: 0.03 },
    },

    vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

    fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDistortion;
    uniform float uScale;
    varying vec2 vUv;

    void main() {
      vec4 d = texture2D(tDistortion, vUv);
      vec2 offset = (d.rg - 0.5) * 2.0 * d.b * d.a * uScale;
      // 钳制，保证热点永远不会采样到画面之外。
      vec2 uv = clamp(vUv + offset, vec2(0.0), vec2(1.0));
      gl_FragColor = texture2D(tDiffuse, uv);
    }
  `,
};
