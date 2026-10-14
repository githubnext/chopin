---
id: 01M4Y73Y8V90SAD3PTQFZEEYRH
anchor: let navigate
created: 2026-10-14T22:04:24Z
norm: '1'
---

Canonicalization changes browser history synchronously before React may commit its route. Child and sibling navigation must classify the current history entry from location.pathname; a render-updated route ref can discard an explicit opener and its parent history marker under load.
