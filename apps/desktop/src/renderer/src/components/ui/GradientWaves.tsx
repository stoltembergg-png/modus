/**
 * Gradient Waves for the running composer — adapted from React Bits
 * https://reactbits.dev/backgrounds/gradient-waves (DavidHDev/react-bits).
 * Uses their raymarched plasma shader; colors follow Modus theme tokens.
 */
import { Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef, useState } from "react";

export type GradientWavesDetail = "low" | "medium" | "high";

type GradientWavesProps = {
  /** Override horizon (defaults to `--color-focus-ring`). */
  horizonColor?: string;
  /** Override wave body (defaults to `--color-focus-ring-soft`). */
  waveColor?: string;
  /** Override crest highlights (defaults to near-white). */
  crestColor?: string;
  speed?: number;
  amplitude?: number;
  waveScale?: number;
  waveRatio?: number;
  swell?: number;
  turbulence?: number;
  tilt?: number;
  zoom?: number;
  height?: number;
  fogDepth?: number;
  detail?: GradientWavesDetail;
  brightness?: number;
  /** Overall alpha — keep modest so composer text stays readable. */
  opacity?: number;
  mouseInteraction?: boolean;
  parallaxStrength?: number;
  grain?: boolean;
  grainIntensity?: number;
  className?: string;
};

type GradientWavesCtx = {
  renderer: InstanceType<typeof Renderer>;
  program: InstanceType<typeof Program>;
  mesh: InstanceType<typeof Mesh>;
};

const ctxMap = new WeakMap<HTMLDivElement, GradientWavesCtx>();

const hexToRgb = (hex: string): [number, number, number] => {
  const result = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!result) {
    return [1, 1, 1];
  }
  return [
    Number.parseInt(result[1] ?? "ff", 16) / 255,
    Number.parseInt(result[2] ?? "ff", 16) / 255,
    Number.parseInt(result[3] ?? "ff", 16) / 255,
  ];
};

/** Resolve a CSS color (hex / rgb / theme token value) to linear 0–1 RGB. */
function resolveColor(
  container: HTMLElement,
  raw: string,
  fallbackHex: string,
): [number, number, number] {
  const value = raw.trim() || fallbackHex;
  if (value.startsWith("#") && (value.length === 4 || value.length === 7)) {
    const normalized =
      value.length === 4
        ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
        : value;
    return hexToRgb(normalized);
  }
  const probe = document.createElement("span");
  probe.style.color = value;
  container.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const parts = computed.match(/(\d+(\.\d+)?)/g);
  if (!parts || parts.length < 3) {
    return hexToRgb(fallbackHex);
  }
  return [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255];
}

function themeColor(
  container: HTMLElement,
  token: string,
  fallbackHex: string,
): [number, number, number] {
  const fromToken = getComputedStyle(container).getPropertyValue(token).trim();
  return resolveColor(container, fromToken || fallbackHex, fallbackHex);
}

const detailToSteps = (detail: GradientWavesDetail): number => {
  if (detail === "low") {
    return 40;
  }
  if (detail === "high") {
    return 110;
  }
  return 70;
};

const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

// Official React Bits Gradient Waves fragment (raymarched plasma).
const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uSteps;
uniform float uBrightness;
uniform float uOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec2 uMouse;
uniform float uParallax;
uniform bool uEnableMouse;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

const float MAX_DIST = 20000.0;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float plasma(vec3 r, vec2 freq, vec4 tc) {
  float mx = r.x + tc.x;
  mx += uSwell * sin((r.y + mx) / 20.0 + tc.y);
  float my = r.y - tc.z;
  my += uTurbulence * cos(r.x / 23.0 + tc.w);
  return r.z - (sin(mx * freq.x) * uAmplitude + sin(my * freq.y) * uAmplitude + uHeight);
}

float raymarch(vec3 pos, vec3 dir, vec2 freq, vec4 tc) {
  float dist = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uSteps) break;
    float dscene = plasma(pos + dist * dir, freq, tc);
    if (abs(dscene) < 0.1) break;
    dist += 0.9 * dscene;
    if (!(abs(dist) < MAX_DIST)) return MAX_DIST;
  }
  return dist;
}

void main() {
  float T = iTime * uSpeed;
  vec2 freq = vec2(uWaveScale / 7.0, (uWaveScale * uWaveRatio) / 3.0);
  vec4 tc = vec4(T / 0.130, T / 0.810, T / 0.200, T / 0.710);
  float c, s;
  float vfov = (3.14159 / 2.3) / max(uZoom, 0.05);
  vec3 cam = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;

  vec3 dir = vec3(0.0, 0.0, -1.0);
  float ulen = length(uv);
  float xrot = vfov * ulen;
  c = cos(xrot); s = sin(xrot);
  dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  vec2 nuv = ulen > 1e-5 ? uv / ulen : vec2(1.0, 0.0);
  c = nuv.x; s = nuv.y;
  dir = mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0) * dir;
  c = cos(uTilt); s = sin(uTilt);
  dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;

  if (uEnableMouse) {
    float yaw = (uMouse.x - 0.5) * uParallax * 0.4;
    float pitch = (uMouse.y - 0.5) * uParallax * 0.4;
    c = cos(yaw); s = sin(yaw);
    dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
    c = cos(pitch); s = sin(pitch);
    dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  }

  float dist = raymarch(cam, dir, freq, tc);
  vec3 pos = cam + dist * dir;

  float t = clamp(uFogDepth / max(dist, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(pos.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 col = mix(uHorizonColor, body, t);
  col *= uBrightness;
  col = clamp(col, 0.0, 1.0);

  float alpha = clamp(t, 0.0, 1.0) * uOpacity;
  if (uGrain > 0.5) {
    float g = hash21(gl_FragCoord.xy + mod(iTime, 64.0) * 11.0);
    alpha += (g - 0.5) * uGrainIntensity;
  }
  alpha = clamp(alpha, 0.0, 1.0);
  fragColor = vec4(col * alpha, alpha);
}
`;

/** Raymarched Gradient Waves (React Bits) — soft overlay for the active composer. */
export function GradientWaves({
  horizonColor,
  waveColor,
  crestColor,
  speed = 0.4,
  amplitude = 2.5,
  waveScale = 0.6,
  waveRatio = 0.9,
  swell = 35,
  turbulence = 20,
  tilt = 1.11,
  zoom = 1,
  height = 5.5,
  fogDepth = 15,
  detail = "medium",
  brightness = 1,
  // Composer overlay: keep text readable while still looking like the demo.
  opacity = 0.55,
  mouseInteraction = false,
  parallaxStrength = 0.5,
  grain = true,
  grainIntensity = 0.04,
  className,
}: GradientWavesProps = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const enableMouseRef = useRef(mouseInteraction);
  const [webglReady, setWebglReady] = useState(false);

  // Mount once — uniforms sync in the effect below (React Bits pattern).
  // biome-ignore lint/correctness/useExhaustiveDependencies: WebGL context is created once; props apply via ctxMap sync effect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motionPreference.matches) {
      setWebglReady(false);
      return;
    }

    let disposed = false;
    let raf = 0;
    let isVisible = true;
    let isPageVisible = !document.hidden;
    let canvas: HTMLCanvasElement | undefined;
    let renderer: InstanceType<typeof Renderer> | undefined;

    try {
      renderer = new Renderer({
        webgl: 2,
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        // Cap DPR for Electron composer (small surface, continuous animate).
        dpr: Math.min(window.devicePixelRatio || 1, 1.5),
      });
      if (!renderer.isWebgl2) {
        throw new Error("WebGL 2 unavailable");
      }

      const gl = renderer.gl;
      gl.clearColor(0, 0, 0, 0);
      canvas = gl.canvas as HTMLCanvasElement;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      container.appendChild(canvas);

      const geometry = new Triangle(gl);
      const program = new Program(gl, {
        vertex,
        fragment,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          iTime: { value: 0 },
          iResolution: { value: new Float32Array([1, 1]) },
          uSpeed: { value: speed },
          uAmplitude: { value: amplitude },
          uWaveScale: { value: waveScale },
          uWaveRatio: { value: waveRatio },
          uSwell: { value: swell },
          uTurbulence: { value: turbulence },
          uTilt: { value: tilt },
          uZoom: { value: zoom },
          uHeight: { value: height },
          uFogDepth: { value: fogDepth },
          uSteps: { value: detailToSteps(detail) },
          uBrightness: { value: brightness },
          uOpacity: { value: opacity },
          uGrain: { value: grain ? 1 : 0 },
          uGrainIntensity: { value: grainIntensity },
          uMouse: { value: new Float32Array([0.5, 0.5]) },
          uParallax: { value: parallaxStrength },
          uEnableMouse: { value: mouseInteraction },
          uHorizonColor: {
            value: new Float32Array(themeColor(container, "--color-focus-ring", "#5227FF")),
          },
          uWaveColor: {
            value: new Float32Array(themeColor(container, "--color-focus-ring-soft", "#FF9FFC")),
          },
          uCrestColor: { value: new Float32Array(hexToRgb("#FFFFFF")) },
        },
      });
      const mesh = new Mesh(gl, { geometry, program });
      ctxMap.set(container, { renderer, program, mesh });

      const setSize = (): void => {
        if (disposed || !renderer) {
          return;
        }
        const rect = container.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        renderer.setSize(w, h);
        const res = (program.uniforms.iResolution as { value: Float32Array }).value;
        res[0] = gl.drawingBufferWidth;
        res[1] = gl.drawingBufferHeight;
        renderer.render({ scene: mesh });
      };

      const ro = new ResizeObserver(setSize);
      ro.observe(container);
      setSize();

      const currentMouse: [number, number] = [0.5, 0.5];
      const targetMouse: [number, number] = [0.5, 0.5];

      const onPointerMove = (event: PointerEvent): void => {
        if (!canvas) {
          return;
        }
        const rect = canvas.getBoundingClientRect();
        targetMouse[0] = (event.clientX - rect.left) / Math.max(rect.width, 1);
        targetMouse[1] = 1 - (event.clientY - rect.top) / Math.max(rect.height, 1);
      };
      const onPointerLeave = (): void => {
        targetMouse[0] = 0.5;
        targetMouse[1] = 0.5;
      };
      // Listen on the composer container (canvas is pointer-events: none).
      container.addEventListener("pointermove", onPointerMove);
      container.addEventListener("pointerleave", onPointerLeave);

      const t0 = performance.now();
      const loop = (t: number): void => {
        raf = 0;
        if (disposed || !renderer) {
          return;
        }
        (program.uniforms.iTime as { value: number }).value = (t - t0) * 0.001;
        const tx = enableMouseRef.current ? targetMouse[0] : 0.5;
        const ty = enableMouseRef.current ? targetMouse[1] : 0.5;
        currentMouse[0] += 0.05 * (tx - currentMouse[0]);
        currentMouse[1] += 0.05 * (ty - currentMouse[1]);
        const mouse = (program.uniforms.uMouse as { value: Float32Array }).value;
        mouse[0] = currentMouse[0];
        mouse[1] = currentMouse[1];
        renderer.render({ scene: mesh });
        if (isVisible && isPageVisible) {
          raf = requestAnimationFrame(loop);
        }
      };

      const tryStart = (): void => {
        if (isVisible && isPageVisible && raf === 0 && !disposed) {
          raf = requestAnimationFrame(loop);
        }
      };
      const tryStop = (): void => {
        if (raf !== 0) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      };

      const io = new IntersectionObserver(
        ([entry]) => {
          isVisible = Boolean(entry?.isIntersecting);
          if (isVisible) {
            tryStart();
          } else {
            tryStop();
          }
        },
        { threshold: 0 },
      );
      io.observe(container);

      const onVisibility = (): void => {
        isPageVisible = !document.hidden;
        if (isPageVisible) {
          tryStart();
        } else {
          tryStop();
        }
      };
      document.addEventListener("visibilitychange", onVisibility);

      const onMotionChange = (event: MediaQueryListEvent): void => {
        if (event.matches) {
          tryStop();
          setWebglReady(false);
        } else {
          setWebglReady(true);
          tryStart();
        }
      };
      motionPreference.addEventListener("change", onMotionChange);

      setWebglReady(true);
      tryStart();

      return () => {
        disposed = true;
        tryStop();
        ro.disconnect();
        io.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        motionPreference.removeEventListener("change", onMotionChange);
        container.removeEventListener("pointermove", onPointerMove);
        container.removeEventListener("pointerleave", onPointerLeave);
        ctxMap.delete(container);
        canvas?.remove();
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
    } catch {
      setWebglReady(false);
      return;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const ctx = ctxMap.get(container);
    if (!ctx) {
      return;
    }
    const { program } = ctx;
    const u = program.uniforms;

    enableMouseRef.current = mouseInteraction;

    (u.uSpeed as { value: number }).value = speed;
    (u.uAmplitude as { value: number }).value = amplitude;
    (u.uWaveScale as { value: number }).value = waveScale;
    (u.uWaveRatio as { value: number }).value = waveRatio;
    (u.uSwell as { value: number }).value = swell;
    (u.uTurbulence as { value: number }).value = turbulence;
    (u.uTilt as { value: number }).value = tilt;
    (u.uZoom as { value: number }).value = zoom;
    (u.uHeight as { value: number }).value = height;
    (u.uFogDepth as { value: number }).value = fogDepth;
    (u.uSteps as { value: number }).value = detailToSteps(detail);
    (u.uBrightness as { value: number }).value = brightness;
    (u.uOpacity as { value: number }).value = opacity;
    (u.uGrain as { value: number }).value = grain ? 1 : 0;
    (u.uGrainIntensity as { value: number }).value = grainIntensity;
    (u.uParallax as { value: number }).value = parallaxStrength;
    (u.uEnableMouse as { value: boolean }).value = mouseInteraction;

    const hc = (u.uHorizonColor as { value: Float32Array }).value;
    const wc = (u.uWaveColor as { value: Float32Array }).value;
    const cc = (u.uCrestColor as { value: Float32Array }).value;
    const h = horizonColor
      ? resolveColor(container, horizonColor, "#5227FF")
      : themeColor(container, "--color-focus-ring", "#5227FF");
    const w = waveColor
      ? resolveColor(container, waveColor, "#FF9FFC")
      : themeColor(container, "--color-focus-ring-soft", "#FF9FFC");
    const cr = crestColor ? resolveColor(container, crestColor, "#FFFFFF") : hexToRgb("#FFFFFF");
    hc[0] = h[0];
    hc[1] = h[1];
    hc[2] = h[2];
    wc[0] = w[0];
    wc[1] = w[1];
    wc[2] = w[2];
    cc[0] = cr[0];
    cc[1] = cr[1];
    cc[2] = cr[2];
  }, [
    horizonColor,
    waveColor,
    crestColor,
    speed,
    amplitude,
    waveScale,
    waveRatio,
    swell,
    turbulence,
    tilt,
    zoom,
    height,
    fogDepth,
    detail,
    brightness,
    opacity,
    grain,
    grainIntensity,
    mouseInteraction,
    parallaxStrength,
  ]);

  return (
    <div
      aria-hidden="true"
      className={`modus-gradient-waves pointer-events-none absolute inset-px z-0${className ? ` ${className}` : ""}`}
      data-webgl={webglReady ? "ready" : "fallback"}
      ref={containerRef}
    />
  );
}
