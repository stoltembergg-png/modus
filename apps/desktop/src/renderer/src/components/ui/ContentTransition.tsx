import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

type ContentTransitionProps = {
  children: ReactNode;
  className?: string;
  transitionKey: string;
};

const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const DISTANCE = 4;
const DURATION = 0.14;

export function ContentTransition({ children, className, transitionKey }: ContentTransitionProps) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false} mode="wait">
      <m.div
        animate={{ opacity: 1, y: 0 }}
        className={className}
        exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -2 }}
        initial={reduceMotion ? false : { opacity: 0, y: DISTANCE }}
        key={transitionKey}
        transition={{ duration: reduceMotion ? 0 : DURATION, ease: EASE_OUT }}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
