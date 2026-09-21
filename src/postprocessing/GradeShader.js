/**
 * 最终观感 pass（在色调映射之后运行，处于显示空间）。
 *
 * 把廉价但高回报的几项调色操作合并到一个 pass 中，让画面只被重采样
 * 一次：色差、lift/gain/对比度/饱和度/色温调色、暗角、胶片颗粒
 * 以及命中闪光。
 */
export const GradeShader = {
    name: 'GradeShader',

    uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uAberration: { value: 0.35 },
        uVignette: { value: 0.4 },
        uContrast: { value: 1.05 },
        uSaturation: { value: 1.1 },
        uTemperature: { value: 0.05 },
        uLift: { value: 0.0 },
        uGain: { value: 1.0 },
        uGrain: { value: 0.03 },
        uFlashColor: { value: null },
        uFlashStrength: { value: 0 },
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
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    uniform float uLift;
    uniform float uGain;
    uniform float uGrain;
    uniform vec3  uFlashColor;
    uniform float uFlashStrength;

    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---- 色差（径向，画面四角最强） ------
      vec3 color;
      if (uAberration > 0.001) {
        vec2 offset = centered * r2 * uAberration * 0.02;
        color.r = texture2D(tDiffuse, uv + offset).r;
        color.g = texture2D(tDiffuse, uv).g;
        color.b = texture2D(tDiffuse, uv - offset).b;
      } else {
        color = texture2D(tDiffuse, uv).rgb;
      }

      // ---- 调色 -------------------------------------------------------
      color = (color - 0.5) * uContrast + 0.5;          // 对比度
      color = color * uGain + uLift;                     // lift / gain（提升 / 增益）

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);       // 饱和度

      // 色温：向 R/B 推暖色，反方向则变冷。
      color.r += uTemperature * 0.12;
      color.b -= uTemperature * 0.12;

      // ---- 暗角 ------------------------------------------------------
      // 从中心向外衰减，在画面四角达到 (1 - uVignette)，
      // 因此这个控制量直接对应“四角变暗多少”。
      color *= 1.0 - uVignette * smoothstep(0.15, 0.72, r2 * 1.9);

      // ---- 命中闪光 --------------------------------------------------
      if (uFlashStrength > 0.001) {
        color = mix(color, uFlashColor, clamp(uFlashStrength, 0.0, 1.0) * 0.75);
      }

      // ---- 颗粒 ---------------------------------------------------------
      if (uGrain > 0.0005) {
        float grain = hash12(uv * vec2(1920.0, 1080.0) + fract(uTime) * 137.0) - 0.5;
        color += grain * uGrain;
      }

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};
