---
id: 01M4KPZB1GT4SYWR9ZM0K820FN
anchor: function pendingLinks
created: 2026-10-10T20:09:52Z
norm: '1'
sig: 6318734f4e0bf8bd
body_hash: b7a7e912716354f5
raw_hash: 57a81cefac062c52
lines: 16-19
---

anchor_plan already passes during rebuilds (implementationActive uses locksEditing); only a first build's lock can strand cards on Linking…, so the release edge in announceImplementation re-asks the Planner under LIVE_BUILD only.
