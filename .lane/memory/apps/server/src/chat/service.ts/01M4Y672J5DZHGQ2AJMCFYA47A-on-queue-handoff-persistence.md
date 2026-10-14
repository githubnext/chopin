---
id: 01M4Y672J5DZHGQ2AJMCFYA47A
anchor: '@file'
created: 2026-10-14T21:48:38Z
norm: '1'
sig: e3b0c44298fc1c14
body_hash: 354c697744eb0bba
raw_hash: 3b226670f045b6df
lines: 1-2711
---

On queue handoff persistence failure, synchronously close and clear Chat before resolving the shifted job or awaiting its ended callback; callers may inspect busy state as soon as the job promise settles.
