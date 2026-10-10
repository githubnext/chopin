---
id: 01M4JHF89WXY4D1JD3785H1TEJ
anchor: method assign
created: 2026-10-10T09:14:28Z
norm: '1'
sig: f8675142fa786e15
body_hash: 0b2572e2b4c95f54
raw_hash: 6cfbb54a446f4e21
lines: 124-126
---

A connection serves every document in its repository. Implementation pickup finds its build through assign()/assigned() (connection -> document of its last queued build), set by the Build POST; run tokens carry their own documentId. Both are in-memory, like connections themselves.
