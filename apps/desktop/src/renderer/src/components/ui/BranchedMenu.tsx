/**
 * BranchedMenu — adapted from React Bits micro interaction.
 * https://reactbits.dev/micro/branched-menu
 *
 * Tree lines draw with SVG stroke animation when a section opens.
 * No Hugeicons dependency — callers pass ReactNode icons (Tabler, etc.).
 */
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";

export type BranchedMenuChild = {
  value: string;
  label: string;
  icon?: ReactNode;
  meta?: string | undefined;
};

export type BranchedMenuItem = {
  label: string;
  value?: string;
  children?: BranchedMenuChild[];
};

const PAD = 6;
const MARK = 16;

function toSet(open: number | number[]): Set<number> {
  return new Set(Array.isArray(open) ? open : open >= 0 ? [open] : []);
}

export function BranchedMenu({
  items,
  defaultOpen = 0,
  defaultActive = "",
  onSelect,
  className,
  color = "var(--color-fg)",
  accentColor = "var(--color-accent)",
  lineColor = "var(--color-hairline-strong)",
  width = 260,
  rowHeight = 30,
  indent = 36,
  trunk = 12,
  radius = 8,
  lineWidth = 1.5,
  fontSize = 12,
  drawDuration = 420,
  foldDuration = 320,
}: {
  items: BranchedMenuItem[];
  defaultOpen?: number | number[];
  defaultActive?: string;
  onSelect?(value: string, item: BranchedMenuChild | BranchedMenuItem): void;
  className?: string;
  color?: string;
  accentColor?: string;
  lineColor?: string;
  width?: number;
  rowHeight?: number;
  indent?: number;
  trunk?: number;
  radius?: number;
  lineWidth?: number;
  fontSize?: number;
  drawDuration?: number;
  foldDuration?: number;
}) {
  const [open, setOpen] = useState(() => toSet(defaultOpen));
  const [active, setActive] = useState(() => {
    if (defaultActive) return defaultActive;
    const first = items.find((it, i) => it.children && toSet(defaultOpen).has(i));
    return first?.children?.[0]?.value ?? "";
  });
  const navRef = useRef<HTMLElement | null>(null);
  const heads = useRef<Array<HTMLButtonElement | null>>([]);
  const markerRef = useRef<HTMLSpanElement | null>(null);

  const activeSection = items.findIndex((it) =>
    it.children?.some((kid) => kid.value === active),
  );
  const markerShown = activeSection >= 0 && open.has(activeSection);

  useLayoutEffect(() => {
    const place = (glide: boolean): void => {
      const m = markerRef.current;
      const el = heads.current[activeSection];
      if (!m) return;
      const on = markerShown && el;
      if (!glide) m.style.transition = "none";
      if (on && el) m.style.top = `${el.offsetTop + (el.offsetHeight - MARK) / 2}px`;
      m.toggleAttribute("data-on", Boolean(on));
      if (!glide) {
        void m.offsetHeight;
        m.style.transition = "";
      }
    };
    place(true);
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      place(false);
    });
    if (navRef.current) ro.observe(navRef.current);
    return () => ro.disconnect();
  }, [activeSection, markerShown, items, fontSize, rowHeight]);

  const r = Math.min(radius, rowHeight / 2 - 2);
  const endX = indent - 8;
  const rowY = (k: number) => PAD + k * rowHeight + rowHeight / 2;
  const branch = (k: number) =>
    `M ${trunk} ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`;
  const reach = (k: number) =>
    `M ${trunk} 0 V ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`;
  const length = (k: number) => rowY(k) - r + (Math.PI * r) / 2 + (endX - trunk - r);

  return (
    <nav
      className={cn("branched-menu", className)}
      ref={navRef}
      style={
        {
          "--bm-w": `${width}px`,
          "--bm-ink": color,
          "--bm-accent": accentColor,
          "--bm-line": lineColor,
          "--bm-font": `${fontSize}px`,
          "--bm-row": `${rowHeight}px`,
          "--bm-indent": `${indent}px`,
          "--bm-line-w": `${lineWidth}`,
          "--bm-draw": `${drawDuration}ms`,
          "--bm-fold": `${foldDuration}ms`,
        } as CSSProperties
      }
    >
      <span aria-hidden className="branched-menu__marker" ref={markerRef} />
      {items.map((item, i) => {
        const kids = item.children;
        const isOpen = kids ? open.has(i) : false;
        const leafValue = item.value ?? item.label;
        const leafActive = !kids && leafValue === active;
        const bodyH = kids ? PAD * 2 + kids.length * rowHeight : 0;
        return (
          <div className="branched-menu__section" data-open={isOpen ? "" : undefined} key={`${item.label}-${i}`}>
            <button
              aria-current={leafActive ? "true" : undefined}
              aria-expanded={kids ? isOpen : undefined}
              className="branched-menu__head"
              data-active={leafActive ? "" : undefined}
              onClick={() => {
                if (kids) {
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  });
                  return;
                }
                setActive(leafValue);
                onSelect?.(leafValue, item);
              }}
              ref={(el) => {
                heads.current[i] = el;
              }}
              type="button"
            >
              {item.label}
            </button>
            {kids ? (
              <div className="branched-menu__body">
                <div className="branched-menu__fold">
                  <div className="branched-menu__tree" style={{ minHeight: bodyH }}>
                    <svg
                      aria-hidden
                      className="branched-menu__lines"
                      height={bodyH}
                      width={indent}
                    >
                      {kids.map((kid, k) => (
                        <path className="branched-menu__base" d={branch(k)} key={`b-${kid.value}`} />
                      ))}
                      {kids.map((kid, k) => {
                        const len = length(k);
                        const activeKid = kid.value === active;
                        return (
                          <path
                            className="branched-menu__reach"
                            d={reach(k)}
                            key={`r-${kid.value}`}
                            style={{
                              strokeDasharray: len,
                              strokeDashoffset: isOpen && activeKid ? 0 : len,
                              opacity: activeKid ? 1 : 0,
                            }}
                          />
                        );
                      })}
                    </svg>
                    {kids.map((kid) => (
                      <button
                        className="branched-menu__item"
                        data-active={kid.value === active ? "" : undefined}
                        key={kid.value}
                        onClick={() => {
                          setActive(kid.value);
                          onSelect?.(kid.value, kid);
                        }}
                        type="button"
                      >
                        {kid.icon ? <span className="branched-menu__icon">{kid.icon}</span> : null}
                        <span className="branched-menu__label">{kid.label}</span>
                        {kid.meta ? (
                          <span className="branched-menu__meta">{kid.meta}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
