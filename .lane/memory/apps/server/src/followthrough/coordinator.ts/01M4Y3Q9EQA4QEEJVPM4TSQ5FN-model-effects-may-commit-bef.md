---
id: 01M4Y3Q9EQA4QEEJVPM4TSQ5FN
anchor: '@file'
created: 2026-10-14T21:05:04Z
norm: '1'
sig: 8c063416b115092a
body_hash: 9450c796c95b7594
raw_hash: 27006dbafe766e1e
lines: 1-230
---

Model effects may commit before receipt finalization. Running receipts cannot replay automatically; only the synchronous pre-stream guard may use releaseUnstarted, with exact revision and attempt token, before any model stream was invoked.
