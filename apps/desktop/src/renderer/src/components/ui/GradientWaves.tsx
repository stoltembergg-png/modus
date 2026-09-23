import { Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef, useState } from "react";

const VERTEX_SHADER = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float x = (uv.x - 0.5) * 2.0;
  float depth = 1.0 - uv.y;
  float time = uTime * 0.32;

  float horizon = 0.34
    + 0.052 * sin(x * 2.2 - time * 0.72)
    + 0.022 * sin(x * 4.7 + time * 0.38);
  float waveA = horizon
    + 0.038 * sin(x * 3.1 + sin(x * 1.2 + time * 0.5) - time * 1.1);
  float waveB = horizon + 0.092
    + 0.030 * sin(x * 4.2 + sin(x * 1.8 - time * 0.35) - time * 0.76);
  float waveC = horizon + 0.19
    + 0.022 * sin(x * 5.6 + sin(x * 2.5 + time * 0.24) - time * 0.52);

  float fog = smoothstep(horizon - 0.08, horizon + 0.48, depth);
  float crestA = exp(-abs(depth - waveA) * 30.0);
  float crestB = exp(-abs(depth - waveB) * 25.0);
  float crestC = exp(-abs(depth - waveC) * 21.0);
  float crests = crestA * 0.30 + crestB * 0.22 + crestC * 0.15;

  vec3 color = mix(uHorizonColor, uWaveColor, smoothstep(0.0, 1.0, fog));
  color = mix(color, uCrestColor, clamp(crests, 0.0, 0.46));
  float alpha = clamp(fog * 0.24 + crests * 0.18, 0.0, 0.34);
  fragColor = vec4(color * alpha, alpha);
}
`;

type Rgb = readonly [number, number, number];

function cssColor(container: HTMLElement, token: string, fallback: Rgb): Float32Array {
  const value = getComputedStyle(container).getPropertyValue(token).trim();
  const hex = value.startsWith("#") ? value.slice(1) : "";
  const normalized = hex.length === 3 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return new Float32Array(fallback);
  }

  return new Float32Array([
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255,
  ]);
}

/** A quiet, transparent Gradient Waves shader confined to the active composer. */
export function GradientWaves() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [webglReady, setWebglReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: Renderer | undefined;
    let program: Program | undefined;
    let mesh: Mesh | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frameId = 0;
    let lastFrame = 0;
    let disposed = false;
    let contextLost = false;
    let pageVisible = !document.hidden;

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let prefersReducedMotion = motionPreference.matches;

    const stopAnimation = (): void => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
    };

    const draw = (time: number): void => {
      if (!renderer || !program || !mesh || contextLost) return;
      (program.uniforms.uTime as { value: number }).value = time * 0.001;
      renderer.render({ scene: mesh });
    };

    const canAnimate = (): boolean =>
      !disposed && !contextLost && pageVisible && !prefersReducedMotion;

    const animate = (time: number): void => {
      frameId = 0;
      if (!canAnimate()) return;
      if (time - lastFrame >= 1000 / 30) {
        lastFrame = time;
        draw(time);
      }
      frameId = window.requestAnimationFrame(animate);
    };

    const startAnimation = (): void => {
      if (frameId === 0 && canAnimate()) {
        frameId = window.requestAnimationFrame(animate);
      }
    };

    const onMotionPreferenceChange = (event: MediaQueryListEvent): void => {
      prefersReducedMotion = event.matches;
      if (prefersReducedMotion) {
        stopAnimation();
      } else {
        startAnimation();
      }
    };

    const onVisibilityChange = (): void => {
      pageVisible = !document.hidden;
      if (pageVisible) {
        startAnimation();
      } else {
        stopAnimation();
      }
    };

    const onContextLost = (event: Event): void => {
      event.preventDefault();
      contextLost = true;
      stopAnimation();
      setWebglReady(false);
    };

    const cleanup = (): void => {
      disposed = true;
      stopAnimation();
      resizeObserver?.disconnect();
      motionPreference.removeEventListener("change", onMotionPreferenceChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas?.removeEventListener("webglcontextlost", onContextLost);
      canvas?.remove();
      if (renderer) {
        const extension = renderer.gl.getExtension(
          "WEBGL_lose_context",
        ) as WEBGL_lose_context | null;
        extension?.loseContext();
      }
    };

    try {
      renderer = new Renderer({
        alpha: true,
        antialias: false,
        dpr: Math.min(window.devicePixelRatio || 1, 1),
        premultipliedAlpha: true,
        webgl: 2,
      });
      if (!renderer.isWebgl2) throw new Error("WebGL 2 is unavailable");

      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 0);
      canvas = gl.canvas as HTMLCanvasElement;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      container.appendChild(canvas);

      const geometry = new Triangle(gl);
      program = new Program(gl, {
        depthTest: false,
        depthWrite: false,
        fragment: FRAGMENT_SHADER,
        transparent: true,
        uniforms: {
          uResolution: { value: new Float32Array([1, 1]) },
          uTime: { value: 0 },
          uHorizonColor: { value: cssColor(container, "--color-focus-ring", [0.52, 0.25, 0.96]) },
          uWaveColor: {
            value: cssColor(container, "--color-focus-ring-soft", [0.7, 0.53, 1]),
          },
          uCrestColor: { value: new Float32Array([0.92, 0.78, 1]) },
        },
        vertex: VERTEX_SHADER,
      });
      mesh = new Mesh(gl, { geometry, program });

      const resize = (): void => {
        if (!renderer || !program || !mesh) return;
        const bounds = container.getBoundingClientRect();
        renderer.setSize(
          Math.max(1, Math.floor(bounds.width)),
          Math.max(1, Math.floor(bounds.height)),
        );
        const resolution = (program.uniforms.uResolution as { value: Float32Array }).value;
        resolution[0] = gl.drawingBufferWidth;
        resolution[1] = gl.drawingBufferHeight;
        draw(lastFrame);
      };

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
      canvas.addEventListener("webglcontextlost", onContextLost);
      motionPreference.addEventListener("change", onMotionPreferenceChange);
      document.addEventListener("visibilitychange", onVisibilityChange);
      resize();
      setWebglReady(true);
      startAnimation();
    } catch {
      cleanup();
      setWebglReady(false);
    }

    return cleanup;
  }, []);

  return (
    <div
      aria-hidden="true"
      className="modus-gradient-waves pointer-events-none absolute inset-px z-0"
      data-webgl={webglReady ? "ready" : "fallback"}
      ref={containerRef}
    />
  );
}
