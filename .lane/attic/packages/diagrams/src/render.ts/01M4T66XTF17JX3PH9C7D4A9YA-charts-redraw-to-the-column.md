---
id: 01M4T66XTF17JX3PH9C7D4A9YA
anchor: draw({ width
created: 2026-10-13T08:31:36Z
norm: '1'
---

Charts redraw to the column (settings.width) only when scaling the authored layout would go below DIAGRAM_VIEWPORT.minimumZoom; near fits stay scaled so desktop output is byte-identical. Only bar (plain/grouped/horizontal) and plain line read settings.width; other chart renderers ignore it and stay scaled (phone gets Expand).
