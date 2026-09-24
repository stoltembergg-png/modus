import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guard for the light-theme Monaco syntax colours.
 *
 * These tokens are consumed only by `lib/monaco.ts` (defineModusTheme) for the
 * CodeViewer. Numeric review found two collisions: `string` shared the exact
 * grey of the line numbers while `comment` sat right next to it, and `type`
 * was within a hair of the body ink — so highlighted code read as monochrome.
 * The test pins the fix and then guards the surfaces those tokens actually land
 * on: the white canvas AND the git diff washes (inserted/removed line
 * backgrounds), where code is highlighted too. Every token must stay legible on
 * all three and perceptibly distinct from every other token (and the body ink).
 */
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

function lightThemeBlock(): string {
  const start = css.indexOf(':root[data-theme="light"]');
  if (start === -1) {
    throw new Error("light theme block not found");
  }
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
    } else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  throw new Error("light theme block not terminated");
}

function tokenHex(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) {
    throw new Error(`token ${name} not found in light theme`);
  }
  return match[1].toLowerCase();
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function channelLinear(component: number): number {
  const normalized = component / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channelLinear(r) + 0.7152 * channelLinear(g) + 0.0722 * channelLinear(b);
}

/** WCAG contrast ratio between any two opaque colours. */
function contrast(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Euclidean distance in RGB — a proxy for "these look different at a glance". */
function distance(a: string, b: string): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

describe("light-theme Monaco code tokens", () => {
  const block = lightThemeBlock();
  const fg = tokenHex(block, "--color-code-fg");
  const tokens = {
    comment: tokenHex(block, "--color-code-comment"),
    keyword: tokenHex(block, "--color-code-keyword"),
    string: tokenHex(block, "--color-code-string"),
    number: tokenHex(block, "--color-code-number"),
    type: tokenHex(block, "--color-code-type"),
  };
  const backgrounds = {
    canvas: "#ffffff",
    "diff add": tokenHex(block, "--color-diff-add-bg"),
    "diff del": tokenHex(block, "--color-diff-del-bg"),
  };

  it("keeps every code token legible on the canvas and both diff washes", () => {
    for (const [name, hex] of Object.entries({ ...tokens, fg })) {
      for (const [bgName, bg] of Object.entries(backgrounds)) {
        expect(contrast(hex, bg), `${name} on ${bgName}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps every code token perceptibly distinct from the others and the body ink", () => {
    const entries = Object.entries({ fg, ...tokens });
    for (const [aName, aHex] of entries) {
      for (const [bName, bHex] of entries) {
        if (aName >= bName) {
          continue;
        }
        expect(distance(aHex, bHex), `${aName} vs ${bName}`).toBeGreaterThanOrEqual(60);
      }
    }
  });
});
