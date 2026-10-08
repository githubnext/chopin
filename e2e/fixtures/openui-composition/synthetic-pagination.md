# Pagination choices

This API comparison is synthetic. Its requests illustrate possible response navigation; they are not repository evidence or measured performance results.

```openui-options
root = OptionsSection("Pagination choices", "Illustrative API alternatives.", [comparison, details, gallery])
gallery = OptionGallery("Response shapes", "rail", [option2, option1, option3])
comparison = OptionComparison("Tradeoffs", [option1, option2, option3])
details = OptionDetails("How each works", [option1, option2, option3])
option1 = DesignOption("offset", "Offset", "Simple page numbers", "Deep pages can be costly", "A client sends an offset and limit.", "Simple", media1)
media1 = OptionPreview("GET /items?offset=20&limit=10", "Synthetic request")
option2 = DesignOption("cursor", "Cursor", "Stable continuation", "Opaque navigation", "A client sends the cursor from the prior response.", "Stable", media2)
media2 = OptionPreview("GET /items?after=eyJpZCI6MjB9", "Synthetic request")
option3 = DesignOption("keyset", "Keyset", "Efficient ordered scan", "Needs a stable sort key", "A client sends the last sort key it observed.", "Stable", media3)
media3 = OptionPreview("GET /items?after_id=20", "Synthetic request")
```

No alternative has been selected by this document.
