---
id: 01M4TJZMAY55NDV1FFR955WWKM
anchor: function renderDiagram
created: 2026-10-13T12:14:48Z
norm: '1'
sig: 29937ce19a13457a
body_hash: f7f6526f08417299
raw_hash: 6713c63fb6e966bc
lines: 152-296
supersedes: 01M4T9FWN316SE9DTBSA00TJZ6
---

Charts redraw to the column (settings.width) whenever the authored layout is wider than it, including the ~550px desktop document column; a chart that fits keeps its authored output byte for byte. Bar (plain/grouped/horizontal), plain line, waterfall and scatter/bubble read settings.width; other chart renderers ignore it and stay scaled (phone gets Expand).
