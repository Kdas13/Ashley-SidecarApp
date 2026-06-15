---
name: Ashley design system
description: Color palette and visual conventions for the Ashley mobile app post-storyboard overhaul.
---

## Color tokens (constants/colors.ts)

- `background`: `#0B0F18` (Deep Navy)
- `card`: `#14181F` (Slate)
- `primary` / `accent`: `#00B9FF` (Electric Blue)
- `primaryForeground`: `#0B0F18`
- `text`: `#E8EDF2`
- `mutedForeground`: `rgba(232, 237, 242, 0.45)`
- `muted`: `rgba(232, 237, 242, 0.08)`
- `bubbleUser`: `#14181F` with blue border `rgba(0,185,255,0.45)` + shadow glow
- `bubbleUserText`: `#E8EDF2`
- `bubbleAshley`: `#2A2F36`
- `bubbleAshleyText`: `#E8EDF2`

**Why:** "Black is the room. Blue is Ashley's presence." — the storyboard brief.

## Conventions
- No purple anywhere — the old accent was `#7a5cff`. All rgba(122, 92, 255, *) values have been replaced with rgba(0, 185, 255, *) equivalents.
- Mic button: `rgba(0,185,255,0.15)` bg, blue border at rest; solid `#00B9FF` with glow shadow when recording.
- Animated pulse rings on mic button use `Animated.loop` + `Animated.sequence` from React Native's built-in `Animated`.
- `BlueOrb` component (components/BlueOrb.tsx) used on welcome screen — Reanimated breathing core + expanding rings.
- `AmbientBackground` now a pure navy gradient with a faint blue glow layer — no image asset dependency.

## How to apply
- Any new UI surface: deep navy background, blue accents only, no warm/orange/purple tones.
- New bubbles or cards should reference `colors.light.card` (`#14181F`) not hardcoded hex.
- If adding a highlight/border, use `rgba(0, 185, 255, *)` not the old purple.
