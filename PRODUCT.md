# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Shift workers checking their own daily schedule quickly on a phone. The user
confirmed that desktop should provide a fuller layout for the same tasks.

## Product Purpose

Turn a photographed shift roster into a personal, editable schedule. The selected
date's shift, context, coworkers, and personal event should be easy to find.

## Operating Context

Users upload a roster photo, select their profile, check dates, and correct OCR or
shift data when necessary. The app is also installed on phones as a PWA.

## Capabilities and Constraints

- Preserve photo OCR, CSV editing/export, cached profiles and name aliases.
- Preserve date navigation, swipeable daily cards, coworkers, sharing, and shift editing.
- Preserve local date events, next-month planning, and opt-in reminder settings.
- Keep Japanese weekday labels in the daily date badge and the supplied panda assets.
- Retain the existing Vue application, Tailwind v4 CLI build, and Cloudflare backend.
- No new explanatory UI labels; keep the interface minimal and all existing actions available.
- Keep the phone schedule and page viewport fixed; only dialogs and editing surfaces may scroll when needed.
- Preserve the explicit phone zoom restriction requested to prevent accidental zoom.
- Do not commit, push, or deploy without an explicit instruction.

## Brand Commitments

The supplied panda stickers and app icon are existing user-selected assets. The
redesign should avoid generic SaaS dashboard styling. The user prefers a darker
palette for the dashboard.

## Evidence on Hand

The working implementation, user-provided UI screenshots in the task history,
and assets in `assets/`. Browser test rosters are synthetic and never installed
in a user's real browser profile.

## Product Principles

- Put today's personal shift ahead of administrative actions.
- Make dates and shift status readable at a glance.
- Preserve user-entered data across presentation changes.
- Use reusable components with predictable interaction states.

## Accessibility & Inclusion

Preserve reduced-motion behavior, keyboard access, readable contrast, and
responsive layouts. No additional product-specific accessibility requirements
have been established.
