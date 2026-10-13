---
id: 01M4T66XV5EANMHRXJS87HK97X
anchor: DiagramDrawing
created: 2026-10-13T08:31:36Z
norm: '1'
---

The sheet's still copy is imported in the same lazy module as Diagram: DiagramSheet reads svg[width] in its mount layout effect, so a separately lazy component would not be drawn yet and the sheet would mis-pick fit.
