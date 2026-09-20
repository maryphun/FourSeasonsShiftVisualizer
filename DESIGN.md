---
name: Schedule Photo Reader
description: A quiet dark shift ledger built for a fast glance at today's work.
colors:
  canvas: "#17191b"
  surface: "#25282b"
  raised: "#33373a"
  edge: "#464b4e"
  ink: "#f3f4f1"
  quiet: "#b8c0c0"
  accent: "#e4adbd"
  accent-soft: "#48343d"
  work: "#a5d8bd"
  work-soft: "#304039"
  leave: "#efc5aa"
  leave-soft: "#41362f"
  late: "#c8c2e7"
  late-soft: "#363440"
typography:
  title:
    fontFamily: "Manrope, Segoe UI, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "0"
  shift:
    fontFamily: "Manrope, Segoe UI, sans-serif"
    fontSize: "2.625rem"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "0"
  body:
    fontFamily: "Manrope, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0"
  label:
    fontFamily: "Manrope, Segoe UI, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0"
rounded:
  control: "6px"
  card: "8px"
spacing:
  tight: "4px"
  small: "8px"
  medium: "12px"
  large: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.card}"
    height: "42px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    height: "42px"
  day-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  calendar-date:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  text-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
---

## Overview

**Creative North Star: "The Night Shift Ledger"**

The selected personal shift is the first read. Calendar, event actions, and counts remain in the same view, but they are quieter than the day card. The surface uses a restrained dark palette with small rose, mint, apricot, and lavender signals for meaning rather than decoration. The user-supplied panda art belongs on the day card, not throughout the interface.

**Key Characteristics:** compact phone-first hierarchy; flat tonal surfaces; tabular time and date numbers; restrained spring motion; a fuller two-column desktop ledger.

**The Glance Rule.** The date, shift value, and any context must remain readable without moving the phone's central schedule. Do not make the day-card region an inner scroller.

## Colors

Rose is the primary action and selection color. Mint denotes work, apricot denotes leave, and lavender denotes late work. Canvas, surface, raised, and edge form the neutral hierarchy; ink and quiet text form the reading hierarchy. Status colors are paired with darker soft surfaces so a color change never has to carry the meaning by itself.

**The Semantic Color Rule.** Keep shift status readable in text; color reinforces it. Reserve the rose accent for active dates, primary actions, and focus.

## Typography

Manrope is self-hosted and used throughout. The shift value is the display-sized element inside the compact day card; contextual parentheses sit on a separate, smaller line. Small labels stay legible and numbers use tabular figures to prevent jitter while changing dates.

**The One Voice Rule.** Use the same font family across cards, controls, dialogs, and the CSV editor. Do not add a decorative display face.

## Layout

On phones the selected day precedes actions, month grid, and statistics in one fixed viewport. Six-week months contract the card area rather than creating an inner scroll. Dialogs and the editing table may scroll independently. At 960px and wider, the day focus occupies the left column and the full month the right; statistics run across the bottom. Safe-area insets protect edge controls.

**The Whole Month Rule.** All calendar weeks and the summary stay visible in the phone schedule, including narrow and short viewports.

## Elevation & Depth

The schedule is flat: borders and tonal surfaces establish grouping without floating section cards. Dialogs alone use a diffuse shadow and darkened scrim to separate them from the schedule. Hover raises a control tonally; it does not add a hard offset shadow.

## Shapes

Small controls use the tighter radius; the day card, dialogs, and primary controls use the slightly broader radius. Calendar dates keep stable dimensions across hover, selection, work, and leave states. Date and shift content must not change their container geometry during transitions.

## Components

The day card combines a top date line, a Japanese weekday date badge, shift value and optional context, an event line, and a coworker action in fixed rows. Previous and next cards remain visible as subdued neighbors. The month grid uses filled date cells on desktop and compact date buttons on phone. Modal editors use segmented state controls, wheel time pickers, and a single clear primary save command. All interactive controls have visible keyboard focus; reduced-motion preferences limit movement.

**The Stable Card Rule.** Switching days or work/leave status must not shift nearby controls or reflow the card.

## Do's and Don'ts

- Do prioritize the selected shift over statistics and administrative actions.
- Do keep the supplied panda stickers tied to shift status.
- Do keep the phone's central schedule static and fit six-week months.
- Don't add explanatory labels, decorative gradients, or floating section cards.
- Don't use color alone to communicate work, leave, late shifts, or selection.
