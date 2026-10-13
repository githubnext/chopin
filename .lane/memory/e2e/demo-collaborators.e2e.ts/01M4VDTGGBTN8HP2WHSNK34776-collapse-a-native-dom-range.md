---
id: 01M4VDTGGBTN8HP2WHSNK34776
anchor: function append
created: 2026-10-13T20:03:52Z
norm: '1'
sig: ffed5470045d6690
body_hash: 274e7d5ad6edaa57
raw_hash: 52a59c9b273dece6
lines: 30-43
---

Collapse a native DOM Range at the first paragraph end before typing. ArrowRight after selectText can cross into the next paragraph; the leading space is then serialized as &#x20;, causing a false reconnect persistence failure even though the edit was saved.
