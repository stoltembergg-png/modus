import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type CollapsibleMotionPreset = "default" | "compact" | "timeline";

/** Slightly deliberate expand/collapse — short snappy times feel abrupt in panels. */
const COLLAPSIBLE_MOTION = {
  compact: 0.3,
  default: 0.34,
  timeline: 0.36,
} satisfies Record<CollapsibleMotionPreset, number>;

const COLLAPSIBLE_EASE = [0.25, 0.1, 0.25, 1] as const;

export function CollapsibleMotion({
  children,
  className,
  id,
  open,
  preset = "default",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  open: boolean;
  preset?: CollapsibleMotionPreset;
}) {
  const reduceMotion = useReducedMotion();
  const duration = reduceMotion ? 0 : COLLAPSIBLE_MOTION[preset];

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <m.div
          animate={{ height: "auto", opacity: 1 }}
          className={cn("relative overflow-hidden", className)}
          data-collapsible-motion
          exit={{ height: 0, opacity: 0 }}
          id={id}
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          key="open"
          style={{ transformOrigin: "top" }}
          transition={{ duration, ease: COLLAPSIBLE_EASE }}
        >
          <m.div
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            initial={reduceMotion ? false : { opacity: 0, y: -6 }}
            transition={{ duration: duration * 0.9, ease: "easeOut" }}
          >
            {children}
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
