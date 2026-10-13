---
id: 01M4T8QPPHVX0JGCQT2YE672VG
anchor: function answer
created: 2026-10-13T09:15:43Z
norm: '1'
sig: 18ca2a2469c3ff47
body_hash: 0c130b62b8c9c7d7
raw_hash: 93e9001c5aa26725
lines: 83-89
---

An open question's empty anchor set gets persisted by Questions.rebase as {anchors:[], pending:false}, indistinguishable from a reviewed-empty set. Answering must convert empty sets to pending/missing (Anchors.answer) or a blank-document ask reads as 'No related text' forever.
