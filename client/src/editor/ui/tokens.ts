/**
 * Ascentix v2 design tokens: color, the Fluent brand ramp/theme, and the
 * rule-editor zone map. The single source for all of it: no hex literal may
 * appear anywhere else under src/editor/ui, enforced by tokens.guard.test.ts.
 *
 * Every color value is verified by test/editor/tokens.contrast.test.ts.
 *
 * The values are the Ascentix v2 palette (brand, neutral, editor-zone and
 * intent colors), each annotated below with the role it serves and, where it
 * carries text or state, the contrast ratio it was chosen to meet.
 */

import { createLightTheme, type BrandVariants, type Theme } from "@fluentui/react-components";

export const color = {
  ink: "#1b1c33",          // titles, values (16.66:1 on surface)
  inkMuted: "#565b6b",     // labels, hints, body (6.76:1 on surface)
  inkDisabled: "#8b8fa3",  // disabled / rest-state icons ONLY (3.20:1, see roles.disabled)
  brand: "#6462e8",        // fills, primary button, focus ring
  brandInk: "#4a44c9",     // links, eyebrows, text-on-light (7.09:1)
  brandTint: "#edecfb",    // chips, info callout bg
  brandLine: "#dcd9f6",
  canvas: "#f5f6fb",
  surface: "#ffffff",
  fill: "#f3f2fc",
  line: "#e7e8f0",
  // zones (rule editor + filters), absorbed from the retired zones.ts
  execution: "#4a44c9",
  executionTint: "#edecfb",
  validation: "#0f766e",      // teal, also "collection"/exists
  validationTint: "#e6f4f2",
  action: "#15803d",
  actionTint: "#ecf7f0",
  // intent
  success: "#15803d",
  successTint: "#ecf7f0",
  warn: "#b7791f",         // FILL ONLY (3.38:1 on warnTint). Use warnInk for text.
  warnInk: "#8a5a00",      // 5.49:1 on warnTint
  warnTint: "#fdf6e3",
  danger: "#c8372d",
  dangerTint: "#fdeeef",
} as const satisfies Record<string, string>;

/**
 * Every legal token name. `as const satisfies` above makes each key a literal,
 * so `color.inkMutd` is a compile error rather than a silent `undefined`, the
 * failure mode a 355-site sweep invites and that no runtime test can catch.
 */
export type ColorToken = keyof typeof color;

/**
 * What each token is allowed to be, and what contrast floor that implies.
 *
 * This split is load-bearing. `warn` (3.38:1 on warnTint) and `inkDisabled`
 * (3.20:1) fail 4.5:1 by design because they are not text; `line` and the tints
 * are ~1.1-1.4:1 because they are backgrounds. A flat rule at either 4.5:1 or
 * 3:1 would fail a correct palette, so the contrast test is role-aware.
 *
 * Roles OVERLAP: `danger` is text on dangerTint and a fill on surface. Every
 * token must hold at least one role, so a new token cannot escape every check.
 */
export const roles = {
  /** token -> background it is asserted against. WCAG 1.4.3, >= 4.5:1. */
  text: {
    ink: "surface",
    inkMuted: "surface",
    brandInk: "surface",
    execution: "executionTint",
    validation: "validationTint",
    action: "actionTint",
    success: "successTint",
    danger: "dangerTint",
    warnInk: "warnTint",
  },
  /** Fills that convey state (buttons, accents, dots). WCAG 1.4.11, >= 3:1 on surface. */
  uiFill: ["brand", "warn", "execution", "validation", "action", "success", "danger"],
  /**
   * Backgrounds and hairlines. No floor: 1.4.11 governs UI boundaries that
   * convey state, not decorative tints (Fluent's own colorBrandStroke2 is 1.53:1).
   */
  decorative: [
    "brandTint", "brandLine", "canvas", "surface", "fill", "line",
    "executionTint", "validationTint", "actionTint", "successTint",
    "warnTint", "dangerTint",
  ],
  /** Exempt from 1.4.3: disabled controls and rest-state icons only. */
  disabled: ["inkDisabled"],
} satisfies {
  text: Partial<Record<ColorToken, ColorToken>>;
  uiFill: ColorToken[];
  decorative: ColorToken[];
  disabled: ColorToken[];
};

const srgbToLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

const relativeLuminance = (hex: string): number => {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2.1 relative-contrast ratio. Order-independent; returns 1..21. */
export function contrastRatio(fg: string, bg: string): number {
  const [lighter, darker] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Manrope is a variable font (wght 200-800), so one file covers every weight
 * the design calls for. Self-hosted via a CSS web resource. See
 * scripts/build-font-css.mjs. The fallbacks matter: if the web resource fails
 * to load, Fluent controls must still render in a sane stack, not serif.
 */
export const FONT_STACK = "'Manrope', 'Segoe UI', system-ui, sans-serif";

/**
 * Fluent's 16-shade brand ramp.
 *
 * Anchored on the palette's four brand values, each placed on the slot Fluent
 * actually reads it from (see @fluentui/tokens/lib/alias/lightColor.js):
 *   80  -> colorBrandBackground, colorBrandForeground1, colorBrandStroke1
 *   70  -> colorBrandForegroundLink, colorBrandBackgroundHover
 *   140 -> colorBrandStroke2
 *   160 -> colorBrandBackground2
 * The remaining 12 are interpolated in OKLab between those anchors; their only
 * contract is tokens.theme.test.ts. Regenerate rather than hand-edit.
 */
export const brandRamp: BrandVariants = {
  10: "#120054",
  20: "#1a0b66",
  30: "#231779",
  40: "#2c228c",
  50: "#362da0",
  60: "#4039b4",
  70: "#4a44c9",
  80: "#6462e8",
  90: "#7578ec",
  100: "#888cef",
  110: "#9ca0f2",
  120: "#b0b3f4",
  130: "#c6c6f5",
  140: "#dcd9f6",
  150: "#e4e2f9",
  160: "#edecfb",
};

/** The one theme. Applied by AppProvider; never use webLightTheme directly. */
export const ascentixTheme: Theme = {
  ...createLightTheme(brandRamp),
  fontFamilyBase: FONT_STACK,
};

export type Zone = "execution" | "validation" | "action";

export interface ZoneStyle {
  numeral: string;
  color: string;
  gradient: string;
  headerBorder: string;
  rowTint: string;
  selTint: string;
  selBorder: string;
  subtitle: string;
  /** AA-safe solid subtitle color (replaces opacity). */
  subtitleColor: string;
}

/**
 * Zone hues, remapped to kill the blue+purple clash:
 * execution indigo, validation teal, action green.
 * Absorbed from the retired zones.ts: two color modules would defeat the guard.
 */
export const ZONES: Record<Zone, ZoneStyle> = {
  execution: {
    numeral: "1", color: color.execution,
    gradient: `linear-gradient(90deg,${color.executionTint},${color.canvas})`,
    headerBorder: color.brandLine,
    rowTint: color.canvas, selTint: color.executionTint, selBorder: color.brandLine,
    subtitle: "Rule evaluates only if these match",
    subtitleColor: color.execution,
  },
  validation: {
    numeral: "2", color: color.validation,
    gradient: `linear-gradient(90deg,${color.validationTint},${color.canvas})`,
    headerBorder: color.validationTint,
    rowTint: color.canvas, selTint: color.validationTint, selBorder: color.validationTint,
    subtitle: "Checked at save time",
    subtitleColor: color.validation,
  },
  action: {
    numeral: "3", color: color.action,
    gradient: `linear-gradient(90deg,${color.actionTint},${color.canvas})`,
    headerBorder: color.actionTint,
    rowTint: color.surface, selTint: color.actionTint, selBorder: color.actionTint,
    subtitle: "Run in order when the rule fires",
    subtitleColor: color.action,
  },
};
