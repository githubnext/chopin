---
id: 01M4T2JHCQCYV9CYNMVJYMRGH0
anchor: function runWork
created: 2026-10-13T07:28:02Z
norm: '1'
sig: 7e61b52123273461
body_hash: f737f9229dc01791
raw_hash: 9482ed80c96f470a
lines: 53-341
supersedes: 01M4RRZZXR0F4HFSR1ZR6XFKZJ
---

An agent stopReason 'cancelled' counts as a terminal stop (STOPPED) only when the connector did not end the run itself. Keep the ended reason from reconnect/heartbeat handling so a refused heartbeat or exhausted grace period retains its specific failure message.
