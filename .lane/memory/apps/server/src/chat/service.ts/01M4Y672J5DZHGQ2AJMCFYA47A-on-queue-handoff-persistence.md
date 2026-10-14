---
id: 01M4Y672J5DZHGQ2AJMCFYA47A
anchor: '@file'
created: 2026-10-14T21:48:38Z
norm: '1'
---

On queue handoff persistence failure, synchronously close and clear Chat before resolving the shifted job or awaiting its ended callback; callers may inspect busy state as soon as the job promise settles.
