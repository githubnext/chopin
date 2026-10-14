---
id: 01M4Y3410819GT9GBNV09MN4GZ
anchor: function textSplice
created: 2026-10-14T20:54:33Z
norm: '1'
sig: b29b0c3dbecf4d97
body_hash: ce7d63825165f5be
raw_hash: d216a4502796f8d8
lines: 2-18
---

Keep unchanged CRDT characters intact when applying textarea edits so another collaborator’s concurrent prose edits can merge. Never split a UTF-16 surrogate pair at either splice boundary.
