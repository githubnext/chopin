---
id: 01M4T8QPPHVX0JGCQT2YE672VG
anchor: function answer
created: 2026-10-13T09:15:43Z
norm: '1'
---

An open question's empty anchor set gets persisted by Questions.rebase as {anchors:[], pending:false}, indistinguishable from a reviewed-empty set. Answering must convert empty sets to pending/missing (Anchors.answer) or a blank-document ask reads as 'No related text' forever.
