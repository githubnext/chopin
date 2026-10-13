---
id: 01M4T2JHCQCYV9CYNMVJYMRGH0
anchor: function runWork
created: 2026-10-13T07:28:02Z
norm: '1'
sig: 7e61b52123273461
body_hash: 25becab3e865eac8
raw_hash: 9fe15a3fc87695a1
vouched: 2026-10-13T12:38:04Z
lines: 53-341
supersedes: 01M4RRZZXR0F4HFSR1ZR6XFKZJ
---

An agent stopReason 'cancelled' counts as a terminal stop (STOPPED) only when the connector did not end the run itself. Keep the ended reason from reconnect/heartbeat handling so a refused heartbeat or exhausted grace period retains its specific failure message.
