# Fro Bot Design Styleguide

> **Aesthetic**: Afrofuturism × Cyberpunk — where organic soul meets machine precision.

The Fro Bot visual identity blends bold streetwear confidence with futuristic robotics. Cel-shaded illustration, high-contrast neon-adjacent color, and structured geometry define every surface.

---

## Table of Contents

1. [Color Palette](#1-color-palette)
2. [WCAG Compliance](#2-wcag-compliance)
3. [Typography](#3-typography)
4. [Spacing & Layout](#4-spacing--layout)
5. [Dark Theme](#5-dark-theme)
6. [Light Theme](#6-light-theme)
7. [CSS Design Tokens](#7-css-design-tokens)
8. [Component Patterns](#8-component-patterns)
9. [Iconography & Imagery](#9-iconography--imagery)
10. [Motion & Animation](#10-motion--animation)
11. [Do's and Don'ts](#11-dos-and-donts)

---

## 1. Color Palette

### 1.1 Brand Core

These five colors define the Fro Bot identity. They map directly to the avatar's visual elements — the afro, the faceplate, the jacket, and the void of space.

| Token | Name | Hex | Swatch | Usage |
| --- | --- | --- | --- | --- |
| `--frobot-void` | Void | `#0D0216` | ![#0D0216](https://placehold.co/80x28/0D0216/FFFFFF?text=%230D0216) | Deepest background, shadows |
| `--frobot-purple` | Deep Purple | `#1A0B2E` | ![#1A0B2E](https://placehold.co/80x28/1A0B2E/FFFFFF?text=%231A0B2E) | Primary dark background, cards |
| `--frobot-cyan` | Cyber Cyan | `#00BCD4` | ![#00BCD4](https://placehold.co/80x28/00BCD4/000000?text=%2300BCD4) | Primary accent, links (dark mode) |
| `--frobot-magenta` | Neon Magenta | `#E91E63` | ![#E91E63](https://placehold.co/80x28/E91E63/FFFFFF?text=%23E91E63) | Secondary accent, CTAs (large) |
| `--frobot-amber` | Solar Amber | `#FFC107` | ![#FFC107](https://placehold.co/80x28/FFC107/000000?text=%23FFC107) | Highlights, warnings, badges |

### 1.2 Neutral Scale

| Token | Name | Hex | Swatch | Usage |
| --- | --- | --- | --- | --- |
| `--frobot-white` | Pure White | `#FFFFFF` | ![#FFFFFF](https://placehold.co/80x28/FFFFFF/000000?text=%23FFFFFF) | Text on dark, faceplates |
| `--frobot-cream` | Warm Cream | `#F5EBEB` | ![#F5EBEB](https://placehold.co/80x28/F5EBEB/000000?text=%23F5EBEB) | Secondary text, muted surfaces |
| `--frobot-purple-mid` | Purple Mid | `#2D1B4E` | ![#2D1B4E](https://placehold.co/80x28/2D1B4E/FFFFFF?text=%232D1B4E) | Elevated cards on dark |
| `--frobot-purple-muted` | Purple Muted | `#3D2A5F` | ![#3D2A5F](https://placehold.co/80x28/3D2A5F/FFFFFF?text=%233D2A5F) | Borders on dark bg |

### 1.3 Accessible Variants (Light-Mode Safe)

These adjusted values maintain the brand feel while meeting WCAG AA/AAA on white (`#FFFFFF`) and cream (`#F5EBEB`) backgrounds.

| Token | Name | Hex | Swatch | Based On | Ratio on White |
| --- | --- | --- | --- | --- | --- |
| `--frobot-cyan-aa` | Teal Accessible | `#00838F` | ![#00838F](https://placehold.co/80x28/00838F/FFFFFF?text=%2300838F) | Cyber Cyan | **4.52:1 AA** |
| `--frobot-cyan-aaa` | Dark Teal | `#006064` | ![#006064](https://placehold.co/80x28/006064/FFFFFF?text=%23006064) | Cyber Cyan | **7.35:1 AAA** |
| `--frobot-magenta-aaa` | Deep Rose | `#880E4F` | ![#880E4F](https://placehold.co/80x28/880E4F/FFFFFF?text=%23880E4F) | Neon Magenta | **9.45:1 AAA** |
| `--frobot-amber-large` | Burnt Amber | `#E65100` | ![#E65100](https://placehold.co/80x28/E65100/FFFFFF?text=%23E65100) | Solar Amber | **3.79:1 AA Large** |

---

## 2. WCAG Compliance

All text and interactive elements must meet **WCAG 2.1 AA** minimum. AAA is the target for body copy.

### 2.1 Requirements

| Level   | Normal Text (≤18pt) | Large Text (≥18pt bold / ≥24pt) |
| ------- | ------------------- | ------------------------------- |
| **AA**  | **4.5:1**           | **3.0:1**                       |
| **AAA** | **7.0:1**           | **4.5:1**                       |

### 2.2 Dark Mode — Approved Pairings

| Foreground             | Background            | Ratio       | Level       | Use                     |
| ---------------------- | --------------------- | ----------- | ----------- | ----------------------- |
| White `#FFFFFF`        | Deep Purple `#1A0B2E` | **18.56:1** | ✅ AAA      | Body text, headings     |
| White `#FFFFFF`        | Void `#0D0216`        | **20.24:1** | ✅ AAA      | Body text, headings     |
| Cream `#F5EBEB`        | Deep Purple `#1A0B2E` | **15.88:1** | ✅ AAA      | Secondary text          |
| Cyber Cyan `#00BCD4`   | Deep Purple `#1A0B2E` | **8.08:1**  | ✅ AAA      | Links, code, accents    |
| Cyber Cyan `#00BCD4`   | Void `#0D0216`        | **8.81:1**  | ✅ AAA      | Links, code, accents    |
| Solar Amber `#FFC107`  | Deep Purple `#1A0B2E` | **11.39:1** | ✅ AAA      | Highlights, badges      |
| Solar Amber `#FFC107`  | Void `#0D0216`        | **12.42:1** | ✅ AAA      | Highlights, badges      |
| Neon Magenta `#E91E63` | Void `#0D0216`        | **4.66:1**  | ✅ AA       | Accent text (normal)    |
| Neon Magenta `#E91E63` | Deep Purple `#1A0B2E` | **4.27:1**  | ✅ AA Large | Large text / icons only |

### 2.3 Light Mode — Approved Pairings

| Foreground                | Background      | Ratio       | Level  | Use                 |
| ------------------------- | --------------- | ----------- | ------ | ------------------- |
| Deep Purple `#1A0B2E`     | White `#FFFFFF` | **18.56:1** | ✅ AAA | Body text, headings |
| Deep Purple `#1A0B2E`     | Cream `#F5EBEB` | **15.88:1** | ✅ AAA | Body text, headings |
| Dark Teal `#006064`       | White `#FFFFFF` | **7.35:1**  | ✅ AAA | Links, interactive  |
| Dark Teal `#006064`       | Cream `#F5EBEB` | **6.29:1**  | ✅ AA  | Links, interactive  |
| Teal Accessible `#00838F` | White `#FFFFFF` | **4.52:1**  | ✅ AA  | Links, captions     |
| Deep Rose `#880E4F`       | White `#FFFFFF` | **9.45:1**  | ✅ AAA | Accent text, CTA    |
| Deep Rose `#880E4F`       | Cream `#F5EBEB` | **8.08:1**  | ✅ AAA | Accent text, CTA    |

### 2.4 ⚠️ Non-Compliant Pairs — Never Use for Text

| Foreground            | Background            | Ratio  | Issue                                             |
| --------------------- | --------------------- | ------ | ------------------------------------------------- |
| Cyber Cyan `#00BCD4`  | White `#FFFFFF`       | 2.30:1 | ❌ Use `--frobot-cyan-aaa` instead                |
| Solar Amber `#FFC107` | White `#FFFFFF`       | 1.63:1 | ❌ Use `--frobot-amber-large` for large text only |
| White `#FFFFFF`       | Cyber Cyan `#00BCD4`  | 2.30:1 | ❌ Never use as text background                   |
| White `#FFFFFF`       | Solar Amber `#FFC107` | 1.63:1 | ❌ Never use as text background                   |

---

## 3. Typography

### 3.1 Font Stack

The Fro Bot brand leans on clean geometric sans-serif paired with monospace for technical content — reflecting the robot's dual nature: soulful yet precise.

```css
/* Display / Brand headings */
--font-display: "Inter", "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif;

/* Body copy */
--font-body: "Inter", "SF Pro Text", "Segoe UI", system-ui, -apple-system, sans-serif;

/* Code / Technical / Labels */
--font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", "Courier New", monospace;
```

### 3.2 Type Scale

| Token            | Size            | Line Height | Weight | Usage                      |
| ---------------- | --------------- | ----------- | ------ | -------------------------- |
| `--text-display` | 96px / 6rem     | 1.0         | 900    | Hero banners, single words |
| `--text-h1`      | 56px / 3.5rem   | 1.1         | 800    | Page titles                |
| `--text-h2`      | 40px / 2.5rem   | 1.2         | 700    | Section headings           |
| `--text-h3`      | 28px / 1.75rem  | 1.3         | 600    | Sub-headings               |
| `--text-h4`      | 22px / 1.375rem | 1.4         | 600    | Card titles                |
| `--text-body-lg` | 18px / 1.125rem | 1.6         | 400    | Lead paragraphs            |
| `--text-body`    | 16px / 1rem     | 1.6         | 400    | Body copy                  |
| `--text-body-sm` | 14px / 0.875rem | 1.5         | 400    | Captions, metadata         |
| `--text-label`   | 12px / 0.75rem  | 1.4         | 500    | Labels, badges, tags       |
| `--text-code`    | 14px / 0.875rem | 1.6         | 400    | Code blocks, inline code   |

### 3.3 Letter Spacing

```css
--tracking-display: -0.04em; /* Tight for large display type */
--tracking-heading: -0.02em; /* Slightly tight for headings */
--tracking-body: 0em; /* Normal for body */
--tracking-label: 0.06em; /* Open tracking for labels/caps */
--tracking-code: 0.02em; /* Slight open for monospace */
```

---

## 4. Spacing & Layout

### 4.1 Spacing Scale

Base unit: **4px**. All spacing is a multiple of this base.

| Token        | Value   | px   | Common Use                  |
| ------------ | ------- | ---- | --------------------------- |
| `--space-1`  | 0.25rem | 4px  | Icon padding, micro gaps    |
| `--space-2`  | 0.5rem  | 8px  | Tight gaps, inline elements |
| `--space-3`  | 0.75rem | 12px | Small padding               |
| `--space-4`  | 1rem    | 16px | Default padding             |
| `--space-5`  | 1.25rem | 20px | Button padding Y            |
| `--space-6`  | 1.5rem  | 24px | Card padding                |
| `--space-8`  | 2rem    | 32px | Section gaps                |
| `--space-10` | 2.5rem  | 40px | Large gaps                  |
| `--space-12` | 3rem    | 48px | Section padding             |
| `--space-16` | 4rem    | 64px | Hero padding                |
| `--space-24` | 6rem    | 96px | Page section spacing        |

### 4.2 Border Radius

```css
--radius-sm: 4px; /* Tags, small chips */
--radius-md: 8px; /* Cards, inputs */
--radius-lg: 12px; /* Modals, panels */
--radius-xl: 20px; /* Pill buttons */
--radius-full: 9999px; /* Circular, fully rounded */
```

### 4.3 Breakpoints

```css
--bp-sm: 640px; /* Small devices */
--bp-md: 768px; /* Tablets */
--bp-lg: 1024px; /* Laptops */
--bp-xl: 1280px; /* Desktops */
--bp-2xl: 1536px; /* Wide screens */
```

---

## 5. Dark Theme

> **Default theme.** The Fro Bot brand lives in the dark. Deep space, neon light.

### 5.1 Semantic Tokens — Dark

```css
[data-theme="dark"],
@media (prefers-color-scheme: dark) {
  --color-bg: #0d0216; /* Page background */
  --color-surface: #1a0b2e; /* Card/panel background */
  --color-surface-raised: #2d1b4e; /* Elevated card, tooltip */
  --color-surface-overlay: #3d2a5f; /* Dialog overlay surface */

  --color-border: #3d2a5f; /* Default border */
  --color-border-muted: #2d1b4e; /* Subtle separator */
  --color-border-accent: #00bcd4; /* Focused/active border */

  --color-text: #ffffff; /* Primary text */
  --color-text-muted: #f5ebeb; /* Secondary/dimmed text */
  --color-text-subtle: rgba(245, 235, 235, 0.5); /* Placeholder */
  --color-text-disabled: rgba(255, 255, 255, 0.3); /* Disabled state */

  --color-accent: #00bcd4; /* Primary interactive (links) */
  --color-accent-hover: #00e5ff; /* Hover state */
  --color-accent-pressed: #00acc1; /* Active/pressed */

  --color-cta: #e91e63; /* Call-to-action buttons */
  --color-cta-hover: #f06292; /* CTA hover */

  --color-highlight: #ffc107; /* Badges, warnings, stars */

  --color-success: #69f0ae; /* Success states */
  --color-warning: #ffc107; /* Warning states */
  --color-error: #f44336; /* Error states */
  --color-info: #00bcd4; /* Info states */

  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.6);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.7);
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.8);
  --shadow-glow: 0 0 20px rgba(0, 188, 212, 0.25);
  --shadow-glow-magenta: 0 0 20px rgba(233, 30, 99, 0.25);
}
```

---

## 6. Light Theme

> The light mode is warm — cream and deep violet, grounded, still technical.

### 6.1 Semantic Tokens — Light

```css
[data-theme="light"],
@media (prefers-color-scheme: light) {
  --color-bg: #ffffff; /* Page background */
  --color-surface: #f5ebeb; /* Card/panel background */
  --color-surface-raised: #edd8d8; /* Elevated card */
  --color-surface-overlay: #e8cccc; /* Dialog overlay */

  --color-border: #d4b8b8; /* Default border */
  --color-border-muted: #edd8d8; /* Subtle separator */
  --color-border-accent: #006064; /* Focused/active border */

  --color-text: #1a0b2e; /* Primary text — AAA on white */
  --color-text-muted: #5c4569; /* Secondary text */
  --color-text-subtle: rgba(26, 11, 46, 0.45); /* Placeholder */
  --color-text-disabled: rgba(26, 11, 46, 0.3); /* Disabled state */

  --color-accent: #006064; /* Primary interactive (links) — AAA */
  --color-accent-hover: #00838f; /* Hover state */
  --color-accent-pressed: #004d50; /* Active/pressed */

  --color-cta: #880e4f; /* Call-to-action — AAA on white */
  --color-cta-hover: #ad1457; /* CTA hover */

  --color-highlight: #e65100; /* Badges — AA Large on white */

  --color-success: #2e7d32; /* Success */
  --color-warning: #e65100; /* Warning */
  --color-error: #c62828; /* Error */
  --color-info: #006064; /* Info */

  --shadow-sm: 0 1px 3px rgba(26, 11, 46, 0.12);
  --shadow-md: 0 4px 12px rgba(26, 11, 46, 0.15);
  --shadow-lg: 0 8px 32px rgba(26, 11, 46, 0.18);
  --shadow-glow: 0 0 20px rgba(0, 96, 100, 0.15);
  --shadow-glow-magenta: 0 0 20px rgba(136, 14, 79, 0.15);
}
```

---

## 7. CSS Design Tokens

Complete token file for use in any project:

```css
:root {
  /* ─── Brand Colors ────────────────────────────────────── */
  --frobot-void: #0d0216;
  --frobot-purple: #1a0b2e;
  --frobot-purple-mid: #2d1b4e;
  --frobot-purple-muted: #3d2a5f;
  --frobot-cyan: #00bcd4;
  --frobot-cyan-bright: #00e5ff;
  --frobot-cyan-aa: #00838f;
  --frobot-cyan-aaa: #006064;
  --frobot-magenta: #e91e63;
  --frobot-magenta-light: #f06292;
  --frobot-magenta-aaa: #880e4f;
  --frobot-amber: #ffc107;
  --frobot-amber-large: #e65100;
  --frobot-white: #ffffff;
  --frobot-cream: #f5ebeb;

  /* ─── Typography ──────────────────────────────────────── */
  --font-display: "Inter", "SF Pro Display", system-ui, sans-serif;
  --font-body: "Inter", "SF Pro Text", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", monospace;

  --text-display: 6rem; /* 96px */
  --text-h1: 3.5rem; /* 56px */
  --text-h2: 2.5rem; /* 40px */
  --text-h3: 1.75rem; /* 28px */
  --text-h4: 1.375rem; /* 22px */
  --text-body-lg: 1.125rem; /* 18px */
  --text-body: 1rem; /* 16px */
  --text-body-sm: 0.875rem; /* 14px */
  --text-label: 0.75rem; /* 12px */
  --text-code: 0.875rem; /* 14px */

  --tracking-display: -0.04em;
  --tracking-heading: -0.02em;
  --tracking-body: 0em;
  --tracking-label: 0.06em;

  /* ─── Spacing ─────────────────────────────────────────── */
  --space-1: 0.25rem; /* 4px  */
  --space-2: 0.5rem; /* 8px  */
  --space-3: 0.75rem; /* 12px */
  --space-4: 1rem; /* 16px */
  --space-6: 1.5rem; /* 24px */
  --space-8: 2rem; /* 32px */
  --space-12: 3rem; /* 48px */
  --space-16: 4rem; /* 64px */

  /* ─── Border Radius ───────────────────────────────────── */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 20px;
  --radius-full: 9999px;

  /* ─── Breakpoints ─────────────────────────────────────── */
  --bp-sm: 640px;
  --bp-md: 768px;
  --bp-lg: 1024px;
  --bp-xl: 1280px;
}
```

---

## 8. Component Patterns

### 8.1 Buttons

```css
/* Base button */
.btn {
  font-family: var(--font-body);
  font-size: var(--text-body);
  font-weight: 600;
  letter-spacing: var(--tracking-label);
  padding: 0.625rem 1.25rem;
  border-radius: var(--radius-xl);
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 180ms ease;
  text-transform: uppercase;
}

/* Primary — Cyan on Dark */
.btn-primary {
  background: var(--frobot-cyan);
  color: var(--frobot-void); /* Deep Purple on Cyan: 8:1 AAA */
  border-color: var(--frobot-cyan);
}
.btn-primary:hover {
  background: var(--frobot-cyan-bright);
}

/* Secondary — Outlined */
.btn-secondary {
  background: transparent;
  color: var(--frobot-cyan);
  border-color: var(--frobot-cyan);
}

/* CTA — Magenta */
.btn-cta {
  background: var(--frobot-magenta);
  color: var(--frobot-white); /* 4.35:1 — use only for large buttons */
  border-color: var(--frobot-magenta);
  font-size: var(--text-body-lg); /* Must be ≥18pt for AA compliance */
}

/* Ghost — Amber */
.btn-ghost {
  background: transparent;
  color: var(--frobot-amber);
  border-color: var(--frobot-amber);
}
```

### 8.2 Badges / Chips

```css
.badge {
  font-family: var(--font-mono);
  font-size: var(--text-label);
  font-weight: 500;
  letter-spacing: var(--tracking-label);
  padding: 0.25rem 0.625rem;
  border-radius: var(--radius-sm);
  border: 1px solid currentColor;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.badge-cyan {
  color: var(--frobot-cyan);
  background: rgba(0, 188, 212, 0.1);
}
.badge-magenta {
  color: var(--frobot-magenta);
  background: rgba(233, 30, 99, 0.1);
}
.badge-amber {
  color: var(--frobot-amber);
  background: rgba(255, 193, 7, 0.1);
}
.badge-muted {
  color: var(--frobot-cream);
  background: rgba(245, 235, 235, 0.05);
}
```

### 8.3 Code Blocks

```css
/* Inline code */
code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--frobot-cyan);
  background: rgba(0, 188, 212, 0.08);
  padding: 0.1em 0.4em;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(0, 188, 212, 0.2);
}

/* Block code */
pre {
  font-family: var(--font-mono);
  background: var(--frobot-void);
  border: 1px solid var(--frobot-purple-muted);
  border-left: 3px solid var(--frobot-cyan);
  border-radius: var(--radius-md);
  padding: var(--space-6);
  overflow-x: auto;
}
```

### 8.4 Cards

```css
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  box-shadow: var(--shadow-sm);
  transition:
    box-shadow 180ms ease,
    border-color 180ms ease;
}

.card:hover {
  border-color: var(--frobot-cyan);
  box-shadow: var(--shadow-md), var(--shadow-glow);
}

/* Accent card with left border stripe */
.card-accent {
  border-left: 3px solid var(--frobot-magenta);
}
```

### 8.5 Glow Effects

```css
/* Cyan glow — use sparingly on interactive focal elements */
.glow-cyan {
  box-shadow:
    0 0 0 1px var(--frobot-cyan),
    0 0 12px rgba(0, 188, 212, 0.35),
    0 0 40px rgba(0, 188, 212, 0.15);
}

/* Magenta glow — CTA focal point */
.glow-magenta {
  box-shadow:
    0 0 0 1px var(--frobot-magenta),
    0 0 12px rgba(233, 30, 99, 0.35),
    0 0 40px rgba(233, 30, 99, 0.15);
}

/* Text glow — display/hero only */
.text-glow {
  text-shadow:
    0 0 20px rgba(0, 188, 212, 0.5),
    0 0 60px rgba(0, 188, 212, 0.2);
}
```

---

## 9. Iconography & Imagery

### 9.1 Fro Bot Avatar

The `assets/fro-bot.png` avatar is the primary brand mark. Usage rules:

| Context                  | Size                            | Notes                                 |
| ------------------------ | ------------------------------- | ------------------------------------- |
| GitHub profile / org     | 800×800px                       | Use as-is, no background modification |
| Repository social banner | Embedded in `assets/banner.png` | Use stylized variant                  |
| README header            | 96–128px                        | Center-aligned                        |
| Inline / badge           | 24–32px                         | Round crop acceptable                 |

### 9.2 Icon Style

Use **outlined** or **two-tone** icon sets that complement the cel-shaded aesthetic:

- **Recommended**: [Phosphor Icons](https://phosphoricons.com/), [Lucide](https://lucide.dev/)
- **Weight**: Regular (1.5px stroke) for UI, Bold for emphasis
- **Size grid**: 16 / 20 / 24 / 32 / 48px

---

## 10. Motion & Animation

### 10.1 Duration Scale

```css
--duration-instant: 80ms; /* Micro: checkbox, radio toggle */
--duration-fast: 150ms; /* Fast: button hover, tooltip */
--duration-normal: 250ms; /* Default: color transitions */
--duration-slow: 400ms; /* Slow: panel open, drawer */
--duration-deliberate: 600ms; /* Page transition, modal */
```

### 10.2 Easing

```css
--ease-standard: cubic-bezier(0.2, 0, 0, 1); /* Most transitions */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* Bouncy/playful */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1); /* Decelerating */
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1); /* Symmetric */
```

### 10.3 Principles

- **Purposeful**: Every animation communicates something (state change, causality, focus)
- **Fast by default**: Most interactions ≤250ms; users should never feel slowed
- **Reduce motion**: Always implement `@media (prefers-reduced-motion: reduce)` overrides
- **No autoplay**: Looping animations pause on hover/focus unless decorative

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 11. Do's and Don'ts

### ✅ Do

- Use **Void** (`#0D0216`) or **Deep Purple** (`#1A0B2E`) as primary backgrounds
- Use **Cyber Cyan** on dark backgrounds for links and interactive elements
- Use **Deep Purple** on light backgrounds for body text (18.56:1 AAA)
- Apply glow effects **only** to focal interactive elements, not every element
- Use **monospace font** for code, labels, badges, and technical identifiers
- Keep brand color usage purposeful: cyan = action, magenta = emphasis, amber = highlight
- Use **Dark Teal** (`#006064`) for links on light backgrounds (AAA compliant)

### ❌ Don't

- Put **Cyber Cyan** text on white backgrounds (2.30:1 — fails all WCAG levels)
- Put **Solar Amber** text on white backgrounds (1.63:1 — invisible)
- Use **Neon Magenta** for small body text on deep purple (4.27:1 — AA Large only)
- Add glow effects to every UI element — reserve them for maximum impact
- Use more than **2 accent colors** in a single component
- Override the brand with generic blue links — use the teal accessible variants
- Use font weights below **400** for body copy on dark backgrounds (legibility)

---

## Appendix A: Quick Reference Cheat Sheet

```
DARK THEME                     LIGHT THEME
─────────────────────────────  ─────────────────────────────
BG:      #0D0216               BG:      #FFFFFF
Surface: #1A0B2E               Surface: #F5EBEB
Text:    #FFFFFF  (18.56:1)    Text:    #1A0B2E  (18.56:1)
Muted:   #F5EBEB  (15.88:1)    Muted:   #5C4569
Links:   #00BCD4  (8.08:1)     Links:   #006064  (7.35:1)
CTA:     #E91E63  (4.27:1 L)   CTA:     #880E4F  (9.45:1)
Highlight:#FFC107 (11.39:1)    Highlight:#E65100  (3.79:1 L)
```

---

_Generated for fro-bot/agent · Last updated 2026-02-25_
