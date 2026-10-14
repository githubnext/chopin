---
id: 01M4Y73Y8V90SAD3PTQFZEEYRH
anchor: let navigate
created: 2026-10-14T22:04:24Z
norm: '1'
sig: 2cff01a70296470c
body_hash: b63e339717fea0c7
raw_hash: 6ad2c2ddc7f94e07
lines: 158-204
---

Canonicalization changes browser history synchronously before React may commit its route. Child and sibling navigation must classify the current history entry from location.pathname; a render-updated route ref can discard an explicit opener and its parent history marker under load.
