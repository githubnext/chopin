---
id: 01M4QZ1TMXQV16WKYC8SPZZ2EP
anchor: --phone-pane-top
created: 2026-10-12T11:48:00Z
norm: '1'
---

Phone pane scrollers (Document, Decisions, Build, Chat) take their top/bottom clearance only from --phone-pane-top/--phone-pane-bottom here. Do not add per-pane padding-top overrides in packages/editor or build-view CSS: a 16px .plan-decisions[data-phone] override once hid the first decision card under the glass top bar.
