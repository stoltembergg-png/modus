/**
 * Scroll Reveal — adapted from React Bits for list/scroll containers
 * https://reactbits.dev/text-animations/scroll-reveal
 *
 * Uses motion + IntersectionObserver instead of GSAP/ScrollTrigger so we stay
 * on the app's existing animation stack (no gsap dependency).
 *
 * Near the top of the scrollport, revealed content keeps a soft blur so the
 * chrome edge feels continuous with the scroll-fade mask.
 */
import { m, useReducedMotion } from "motion/react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";

const EASE = [0.25, 0.1, 0.25, 1] as const;
/** Soft blur while the block sits in the top chrome band of the scrollport. */
const TOP_EDGE_PX = 56;

export type ScrollRevealProps = {
  children: ReactNode;
  /** Scrollport that owns the list (sidebar / chat scroller). Defaults to viewport. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  enableBlur?: boolean;
  baseOpacity?: number;
  blurStrength?: number;
  /** Extra blur applied while the block is near the top of the scrollport. */
  topEdgeBlur?: number;
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
  baseOpacity = 0.1,
  blurStrength = 5,
  topEdgeBlur = 2.5,
  offsetY = 12,
  className,
  once = true,
  splitWords = false,
}: ScrollRevealProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(Boolean(reduce));
  const [edgeBlur, setEdgeBlur] = useState(0);

  const content = useMemo(() => {
    if (!splitWords || typeof children !== "string") {
      return children;
    }
    return children.split(/(\s+)/).map((word, index) => {
      if (/^\s+$/.test(word)) {
        return word;
      }
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
      setEdgeBlur(0);
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
        rootMargin: "0px 0px -8% 0px",
        threshold: [0, 0.12, 0.35, 0.6],
      },
    );
    io.observe(el);

    const updateEdge = (): void => {
      const node = ref.current;
      if (!node) return;
      const rootBox = root?.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const top = rootBox ? box.top - rootBox.top : box.top;
      if (top < TOP_EDGE_PX && top > -box.height) {
        const t = Math.max(0, Math.min(1, 1 - top / TOP_EDGE_PX));
        setEdgeBlur(enableBlur ? topEdgeBlur * t : 0);
      } else {
        setEdgeBlur(0);
      }
    };

    updateEdge();
    const target: HTMLElement | Window = root ?? window;
    target.addEventListener("scroll", updateEdge, { passive: true });
    window.addEventListener("resize", updateEdge);
    return () => {
      io.disconnect();
      target.removeEventListener("scroll", updateEdge);
      window.removeEventListener("resize", updateEdge);
    };
  }, [scrollContainerRef, once, reduce, enableBlur, topEdgeBlur]);

  const blurPx = visible ? edgeBlur : enableBlur ? blurStrength : 0;

  return (
    <m.div
      animate={{
        opacity: visible ? (edgeBlur > 0 ? 0.82 : 1) : baseOpacity,
        y: visible ? 0 : offsetY,
        filter: `blur(${blurPx}px)`,
      }}
      className={cn(className)}
      exit={{
        opacity: 0,
        y: -4,
        filter: "blur(0px)",
        transition: { duration: reduce ? 0 : 0.18, ease: "easeOut" },
      }}
      initial={false}
      ref={ref}
      transition={{ duration: reduce ? 0 : 0.48, ease: EASE }}
    >
      {content}
    </m.div>
  );
}
