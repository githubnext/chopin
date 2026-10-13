---
id: 01M4TJZMBPBFA2EY2G3PRRJJBA
anchor: const SeeCodeDiagram
created: 2026-10-13T12:14:48Z
norm: '1'
sig: 3db6f9bae10444d5
body_hash: 03fe86a2afe23c87
raw_hash: 2e51716ab4628861
lines: 90-129
supersedes: 01M4T66XV5EANMHRXJS87HK97X
---

The sheet’s still copy is imported in the same lazy module as Diagram: DiagramSheet reads svg[width] in its mount layout effect, so a separately lazy component would not be drawn yet and the sheet would mis-pick fit.
