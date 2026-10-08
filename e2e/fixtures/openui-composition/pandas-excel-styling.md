# Excel header styling

This comparison adapts [pandas issue #54154](https://github.com/pandas-dev/pandas/issues/54154) at its 16 July 2023 checkpoint. The image shows current output. The plain alternative is a proposal, not a recorded decision or measured result.

```openui-options
root = OptionsSection("Excel header styling", "Compare the current output with a proposed plain default.", [gallery, comparison, details])
gallery = OptionGallery("Outputs", "grid", [option1, option2])
comparison = OptionComparison("Tradeoffs", [option1, option2])
details = OptionDetails("Source reasoning", [option1, option2])
option1 = DesignOption("current", "Keep current default", "Preserves styled headers", "Basic exports retain formatting", "The issue shows bold and bordered headers in the current output.", "Current", media1)
media1 = OptionImage("https://user-images.githubusercontent.com/24256554/208918872-c616b449-b399-42e6-8a03-b3581063857a.png", "Spreadsheet with styled row and column headers", "Current output shown in pandas issue #54154")
option2 = DesignOption("plain", "Plain default", "Would produce unstyled basic exports", "Changes existing default output", "The issue proposes removing default header styling and using Styler for deliberate formatting.", "Proposal", media2)
media2 = OptionPreview("A  B\n1  2", "Illustrative reconstruction; not a source screenshot")
```

The proposed plain default remains a proposal. Filtering and opening details change only this reader's view.
