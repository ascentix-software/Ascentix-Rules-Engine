---
title: Accessibility & Responsive Layout
section: Building Rules
order: 214
slug: accessibility-responsive
screenshots:
  - file: images/02-14-accessibility-responsive-01.png
    caption: On a narrow viewport the editor reflows, wrapping and stacking header actions, the Rule settings strip and data model, and condition rows.
    alt: "The rule editor at 800 pixels wide: the header actions wrap below the title, the Rule settings strip and the Orders chip stack, and the Only if, Outcomes and Then bands fill the width."
---

# Accessibility & Responsive Layout

## Keyboard and screen readers

- Everything in the editor (tree rows, condition and action rows, buttons, the breadcrumb) works
  from the keyboard and has an accessible name.
- Row buttons (**Duplicate condition**, **Delete condition**, **Move up**, **Move down**, **Delete
  action**) appear on keyboard focus as well as on hover.
- The data-model tree uses the arrow keys.
- Issue counts from **Check for issues** are announced as they change.

## Narrow windows

The editor reflows instead of scrolling sideways:

- The header actions wrap below the rule name.
- The **Rule settings** strip and the data model chip stack.
- Long condition and action rows stack their parts.
- The rule settings, condition, action and table panels open as an overlay.

![The rule editor at 800 pixels wide: the header actions wrap below the title, the Rule settings strip and the Orders chip stack, and the Only if, Outcomes and Then bands fill the width.](../images/02-14-accessibility-responsive-01.png)
