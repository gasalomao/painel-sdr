---
name: awesome-design-md
description: "Curated collection of 73+ DESIGN.md design system specifications from top tech websites (Linear, Stripe, Supabase, Vercel, Apple, Notion, Raycast, Figma, PostHog, etc.). Use this skill whenever designing, building, or styling UI components, pages, landing pages, and web apps to replicate professional design systems, color tokens, typography, and component states."
---

# Awesome DESIGN.md

A curated collection of real-world `DESIGN.md` specifications extracted from 73+ leading developer and tech websites.

## Purpose

AI models (GPT, Claude, Gemini, DeepSeek, etc.) can generate generic or inconsistent styling when prompted with vague design requests. `DESIGN.md` provides an exact markdown-based design system containing:
- Color palettes (Primary, Secondary, Background, Surface, Accents, Borders)
- Typography scales, weights, and Google Fonts pairings
- Spacing, padding, and layout grid systems
- Component states (buttons, inputs, cards, dialogs, hover and active states)
- Shadows, blur effects, glassmorphism, and micro-interactions
- Brand-specific DOs and DONTs

## Available Design Systems in `references/`

- **Linear (`references/linear.app/DESIGN.md`)**: Sleek dark mode, keyboard-first UX, subtle borders, high contrast accents.
- **Stripe (`references/stripe/DESIGN.md`)**: Vibrant gradients, clean white backgrounds, sophisticated typography, soft shadows.
- **Supabase (`references/supabase/DESIGN.md`)**: Emerald green accents, developer-focused dark surfaces, crisp typography.
- **Vercel (`references/vercel/DESIGN.md`)**: Monochrome minimalism, bold black/white contrast, geometric grid lines.
- **Apple (`references/apple/DESIGN.md`)**: Clean san-serif, expansive whitespace, glassmorphism, rounded corners.
- **Notion (`references/notion/DESIGN.md`)**: Editorial minimalism, serif/sans-serif blends, understated borders.
- **Raycast (`references/raycast/DESIGN.md`)**: Modern command palette styling, deep blacks, vibrant neon highlights.
- **PostHog, Figma, Resend, Framer, ClickHouse, Replicate, Meta, Wise, X.ai, and 60+ more.**

## How to Use

1. **Adopt a Design System for the Current Project**:
   To apply a specific design language (e.g. Linear), copy or link its specification into your project root as `DESIGN.md`:
   ```bash
   # Read the reference DESIGN.md
   # Apply colors, typography and layout tokens to Tailwind/CSS configuration
   ```

2. **Generate Matching Components**:
   When building a component or page, reference the relevant `DESIGN.md` in `references/<brand>/DESIGN.md` and instruct the model:
   > "Implement this feature adhering strictly to the design tokens and visual guidelines in the Linear DESIGN.md."

3. **Multi-Model Consistency**:
   Pinning a `DESIGN.md` alongside `AGENTS.md` ensures that switching models (Claude, Gemini, GPT) maintains 100% visual consistency without styling drift.
