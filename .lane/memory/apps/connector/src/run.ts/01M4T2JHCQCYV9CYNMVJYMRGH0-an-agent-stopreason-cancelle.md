---
id: 01M4T2JHCQCYV9CYNMVJYMRGH0
anchor: function runWork
created: 2026-10-13T07:28:02Z
norm: '1'
supersedes: 01M4RRZZXR0F4HFSR1ZR6XFKZJ
---

An agent stopReason 'cancelled' counts as a terminal stop (STOPPED) only when the connector did not end the run itself. Keep the ended reason from reconnect/heartbeat handling so a refused heartbeat or exhausted grace period retains its specific failure message.
