# Theming Guide

## Goal
Provide a maintainable light/dark theming system with VS Code-like hierarchy while preserving existing product interactions.

## Theme Source of Truth
- Theme key: `ui_theme`
- Allowed values: `light` | `dark`
- Runtime attribute: `data-theme` on `document.documentElement`
- Theme API: `src/lib/theme.ts`

## Core Tokens
Defined in `src/style.css` on `:root` and `[data-theme='dark']`:
- Background: `--ui-bg-app`, `--ui-bg-panel`, `--ui-bg-panel-muted`, `--ui-bg-elevated`, `--ui-bg-tabbar`
- Text: `--ui-text-primary`, `--ui-text-secondary`, `--ui-text-muted`
- Border: `--ui-border-default`, `--ui-border-strong`
- State/Accent: `--ui-accent`, `--ui-success`, `--ui-warning`, `--ui-danger`

## Usage Rules
1. Prefer semantic tokens via `var(--token)` for new CSS.
2. Prefer reusable semantic utility classes over per-component hardcoded color literals.
3. Keep interaction contrast readable in both themes: default/hover/active/disabled/focus/error.

## Forbidden for New Code
- Raw hex colors for theme surfaces/text/borders (icon asset colors are allowed).
- New one-off hardcoded `slate-*` palette usage when semantic token can represent intent.

## Migration Notes
- Existing legacy classes are temporarily supported by the dark compatibility layer in `style.css`.
- When touching old components, migrate from compatibility-layer reliance to semantic token usage.
