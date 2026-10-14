---
id: 01M4Y3133HRA0JH924AGPSRX7R
anchor: class RecommendationCoordinator
created: 2026-10-14T20:52:54Z
norm: '1'
sig: 95c91dae205c84f6
body_hash: 607731d0a7244230
raw_hash: 1e12a69072124f91
lines: 24-187
---

A context hash may return to an earlier value; active reads must also be invalidated by durable job changes so an older completed generation cannot reappear over a cancelled or pending replacement.
