/**
 * TextType — adapted from React Bits (no GSAP; CSS cursor blink).
 * https://reactbits.dev/text-animations/text-type
 *
 * Chat uses the blinking caret while content is revealing. Optional
 * `mode="typewriter"` types the full string character-by-character.
 */
import { createElement, useEffect, useState } from "react";
import { cn } from "../../lib/cn";

type TextTypeProps = {
  text?: string;
  as?: "span" | "div" | "p";
  className?: string;
  cursorClassName?: string;
  showCursor?: boolean;
  cursorCharacter?: string;
  /** When true, caret stays visible (streaming / catching up). */
  active?: boolean;
  mode?: "caret" | "typewriter";
  typingSpeed?: number;
};

export function TextType({
  text = "",
  as: Component = "span",
  className,
  cursorClassName,
  showCursor = true,
  cursorCharacter = "|",
  active = false,
  mode = "caret",
  typingSpeed = 18,
}: TextTypeProps) {
  const [displayed, setDisplayed] = useState(mode === "typewriter" ? "" : text);
  const typing = mode === "typewriter" && displayed.length < text.length;
  const caret = showCursor && (active || typing);

  useEffect(() => {
    if (mode !== "typewriter") {
      setDisplayed(text);
      return;
    }
    setDisplayed("");
    let index = 0;
    let timer = 0;
    const tick = (): void => {
      index += 1;
      setDisplayed(text.slice(0, index));
      if (index < text.length) {
        timer = window.setTimeout(tick, typingSpeed);
      }
    };
    timer = window.setTimeout(tick, typingSpeed);
    return () => window.clearTimeout(timer);
  }, [text, mode, typingSpeed]);

  return createElement(
    Component,
    { className: cn("text-type", className) },
    mode === "typewriter" ? displayed : null,
    caret ? (
      <span aria-hidden className={cn("text-type__cursor", cursorClassName)}>
        {cursorCharacter}
      </span>
    ) : null,
  );
}
