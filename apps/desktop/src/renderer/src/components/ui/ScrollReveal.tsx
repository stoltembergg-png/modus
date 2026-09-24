/**
 * Scroll Reveal — adapted from React Bits for list/scroll containers
 * https://reactbits.dev/text-animations/scroll-reveal
 *
 * Uses motion + IntersectionObserver instead of GSAP/ScrollTrigger so we stay
 * on the app's existing animation stack (no gsap dependency).
 */
import { m, useReducedMotion } from "motion/react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";

const EASE = [0.22, 1, 0.36, 1] as const;

export type ScrollRevealProps = {
  children: ReactNode;
  /** Scrollport that owns the list (sidebar scroller). Defaults to viewport. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  enableBlur?: boolean;
  baseOpacity?: number;
  blurStrength?: number;
  /** Extra Y travel while hidden (px). */
  offsetY?: number;
  className?: string;
  /** Once revealed, stay visible (default true). */
  once?: boolean;
  /** Split string children into word spans like React Bits. */
  splitWords?: boolean;
};

export function ScrollReveal({
  children,
  scrollContainerRef,
  enableBlur = true,
  baseOpacity = 0.12,
  blurStrength = 4,
  offsetY = 10,
  className,
  once = true,
  splitWords = false,
}: ScrollRevealProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(Boolean(reduce));

  const content = useMemo(() => {
    if (!splitWords || typeof children !== "string") {
      return children;
    }
    return children.split(/(\s+)/).map((word, index) => {
      if (/^\s+$/.test(word)) {
        return word;
      }
      // Stable across re-renders for a fixed string; index is the split position.
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: word order is the identity for this fixed string
        <span className="inline-block" key={`w${index}-${word}`}>
          {word}
        </span>
      );
    });
  }, [children, splitWords]);

  useEffect(() => {
    if (reduce) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const root = scrollContainerRef?.current ?? null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setVisible(true);
          if (once) io.disconnect();
        } else if (!once) {
          setVisible(false);
        }
      },
      {
        root,
        rootMargin: "0px 0px -12% 0px",
        threshold: 0.2,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollContainerRef, once, reduce]);

  return (
    <m.div
      animate={
        visible
          ? { opacity: 1, y: 0, filter: "blur(0px)" }
          : {
              opacity: baseOpacity,
              y: offsetY,
              filter: enableBlur ? `blur(${blurStrength}px)` : "blur(0px)",
            }
      }
      className={cn(className)}
      initial={false}
      ref={ref}
      transition={{ duration: reduce ? 0 : 0.42, ease: EASE }}
    >
      {content}
    </m.div>
  );
}
