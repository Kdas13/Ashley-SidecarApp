# Safeguard (web pilot)

Mobile-first refugee GP-continuity safeguarding pilot. Hard-separated from
Ashley-Sidecar — own artifact, own backend (`@workspace/safeguard-api`),
own DB tables (`safeguard_*`), own Clerk-authenticated user model, own
branding.

## Why web instead of native mobile?

The Replit project template only allows ONE Expo mobile artifact, and that
slot is taken by Ashley-Sidecar. Safeguard ships as a **mobile-first
responsive PWA** instead of a native app for the pilot. The product
surface (single column, large tap targets, viewport-locked, install-to-
home-screen friendly) is the same; only the runtime differs.

## Run

```sh
pnpm --filter @workspace/safeguard run dev
```

Mounts at `/safeguard/` via the global proxy.

## Required env

- `VITE_CLERK_PUBLISHABLE_KEY` — Replit-managed Clerk publishable key
- `DATABASE_URL`, `CLERK_SECRET_KEY`, `AI_INTEGRATIONS_OPENAI_*` are
  consumed by the sibling `@workspace/safeguard-api` server

## What's here

- `src/i18n/` — i18next setup, RTL handling, six locale bundles
  (en / uk / ar fully translated, ur / ps / so scaffolded with safety-
  critical strings + visible "translation in progress" banner).
- `src/lib/safeguardingInvariants.ts` — mirror of the server-side source
  of truth. Both copies must match.
- `src/lib/api.ts` — small typed Clerk-authed fetch wrapper for
  `/safeguard-api`.
- `src/pages/Landing.tsx` — pre-auth landing + Clerk modal sign-in/up.
- `src/pages/Onboarding.tsx` — 5-step onboarding (language, identity, GP,
  concerns, review + accessibility prefs).
- `src/pages/Home.tsx` — post-onboarding hub with today's check-in CTA.
- `src/pages/CheckIn.tsx` — daily wellbeing check-in (5 numeric scores +
  free text in the user's own language) + post-submit observational
  summary screen.
- `src/pages/Week.tsx` — observational summaries for the last 7 days.
- `src/components/SafeguardLayout.tsx` — top bar with language switcher,
  always-on "I need help now" button, sign-out, pilot-scope footer.
- `src/components/SupportSheet.tsx` — modal with non-clinical UK support
  numbers (NHS 111, Samaritans, British Red Cross, 999).

## Safeguarding invariants

The six pilot-phase invariants are defined in
`src/lib/safeguardingInvariants.ts` and rendered on both the landing and
home screens via `<Principles />`. Every feature added here must pass
through those six rules first.
