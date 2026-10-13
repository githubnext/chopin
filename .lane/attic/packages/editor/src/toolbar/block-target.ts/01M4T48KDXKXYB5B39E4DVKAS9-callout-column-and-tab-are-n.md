---
id: 01M4T48KDXKXYB5B39E4DVKAS9
anchor: function $containedBlock
created: 2026-10-13T07:57:33Z
norm: '1'
---

Callout, Column and Tab are not Lexical shadow roots, so in Lexical 0.48 $insertNodes flattens a block inserted in them to inline text (silently dropping a table or tabs) and $insertList turns the whole container into the list. Insert relative to the host block instead.
