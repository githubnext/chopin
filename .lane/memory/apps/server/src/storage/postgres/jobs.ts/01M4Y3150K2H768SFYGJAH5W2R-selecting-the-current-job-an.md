---
id: 01M4Y3150K2H768SFYGJAH5W2R
anchor: '@file'
created: 2026-10-14T20:52:58Z
norm: '1'
sig: eadaffe8c292d62d
body_hash: da3be412d33c3aef
raw_hash: 699147cf4d5fcde0
lines: 1-818
---

Selecting the current job and reading its target, artifact and channel revision must share one repeatable-read transaction; separate queries can mix target generations during enqueue.
