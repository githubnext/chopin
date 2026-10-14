---
id: 01M4Y37WHN2GAVVF0681N0X6GB
anchor: interface FollowthroughStore
created: 2026-10-14T20:56:39Z
norm: '1'
sig: d03dcf3c4d1d2a0d
body_hash: 97e1fc914e2bf6e7
raw_hash: 96c4c1a3207efc1d
lines: 30-87
---

releaseUnstarted is only for a claim refused before any model stream starts. It preserves attempts to prevent notice identity reuse; interrupted or already started work must fail and require explicit retry.
