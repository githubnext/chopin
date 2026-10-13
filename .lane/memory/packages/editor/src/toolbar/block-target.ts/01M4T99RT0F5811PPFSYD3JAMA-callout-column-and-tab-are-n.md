---
id: 01M4T99RT0F5811PPFSYD3JAMA
anchor: function $inContainer
created: 2026-10-13T09:25:35Z
norm: '1'
sig: 5f9b4549300f46c7
body_hash: b4423813f6ecc2f5
raw_hash: 859213ee4a0f278c
lines: 68-71
supersedes: 01M4T48KDXKXYB5B39E4DVKAS9
---

Callout, Column and Tab are not Lexical shadow roots, so in Lexical 0.48 $insertNodes flattens a block inserted in them to inline text (silently dropping a table or tabs) and $insertList turns the whole container into the list. Insert relative to the host block instead.
