/**
 * Send → stop morph glyph extracted from React Bits Prompt Bar
 * https://reactbits.dev/components/prompt-bar
 */
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

export type PromptSendGlyphProps = {
  busy: boolean;
  morphDuration?: number;
  squash?: number;
  tilt?: number;
  className?: string;
};

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = "";
  for (let i = 0; i < a.length; i += 2) {
    const ax = a[i] ?? 0;
    const ay = a[i + 1] ?? 0;
    const bx = b[i] ?? 0;
    const by = b[i + 1] ?? 0;
    d += `${i ? "L" : "M"}${mix(ax, bx, t).toFixed(2)} ${mix(ay, by, t).toFixed(2)}`;
  }
  return `${d}Z`;
};

export function PromptSendGlyph({
  busy,
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  className = "block h-4 w-4 origin-center",
}: PromptSendGlyphProps) {
  const reduce = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const dir = useRef(busy ? 1 : -1);
  const t = useMotionValue(busy ? 1 : 0);

  useEffect(() => {
    const target = busy ? 1 : 0;
    dir.current = busy ? 1 : -1;
    if (t.get() === target) return undefined;
    const controls = animate(
      t,
      target,
      reduce ? { duration: 0 } : { duration: morphDuration / 1000, ease: EASE_IN_OUT },
    );
    return () => controls.stop();
  }, [busy, morphDuration, reduce, t]);

  useMotionValueEvent(t, "change", (v) => {
    pathRef.current?.setAttribute("d", pathAt(ARROW_UP, SQUARE, v));
    const goo = reduce ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - squash * goo;
    if (svgRef.current) {
      svgRef.current.style.transform = goo
        ? `rotate(${dir.current * tilt * goo}deg) scale(${sx}, ${1 / sx})`
        : "";
    }
  });

  return (
    <svg
      ref={svgRef}
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, SQUARE, t.get())} />
    </svg>
  );
}
