---
title: Rule Lifecycle
section: Getting Started
order: 105
slug: rule-lifecycle
---

# Rule Lifecycle

A rule's **status** determines whether it is enforced; an optional effective window
determines when.

## Draft / Published / Archived

Every rule has a status:

- **Draft** is the default status for a new rule. You can edit it freely, and it is
  **never enforced**, no matter what triggers or channels it has selected.
- **Published** is the live status. The engine enforces **only Published** rules,
  and only within their effective window, described below. A rule must pass the
  rule validator before it can move from Draft to Published. See *Validating &
  Publishing* for what the validator checks and how the Rule Builder surfaces
  issues.
- **Archived** is a retired status. An Archived rule is kept for history but is
  **never enforced**.

## Effective window

A rule can optionally carry an effective window:

- **Effective From**: the rule is not enforced before this date/time.
- **Effective To**: the rule is not enforced after this date/time.

Both are stored in **UTC**, and both are optional independently. Leaving a bound
**null** leaves that side of the window open. A Published rule with no effective
window set is enforced continuously, subject only to its Triggers and Channels.

The Rule Builder edits an exact **date and time**, including seconds. Its
**Schedule timezone** defaults to UTC; choose Local to display and enter values in
your browser's timezone. Switching the display timezone preserves the scheduled
instants. The summary shows when enforcement starts and ends.

The end bound is inclusive and refers to that exact time, not the end of the
selected calendar day. For an ambiguous local time during a daylight-saving
transition, use UTC to specify the intended instant precisely.

> A rule outside its effective window, or still in Draft, is loaded and evaluated
> the same way structurally, but does not apply.
