---
id: 01M4Y37GGXTGPZM341E99GW45B
anchor: function setParticipation
created: 2026-10-14T20:56:27Z
norm: '1'
sig: e88c226d9bf76474
body_hash: 29568c74f9f0ca2b
raw_hash: ec2a50e7f8369815
lines: 141-171
---

The production persist callback directly returns Plan.persist: its await continuation publishes initiativePaused before the next queued plan capture. Preserve this ordering if the callback becomes wrapped; otherwise a later unrelated commit could overwrite the newly saved preference.
