# Excel header styling choices

The pandas development source asks whether `DataFrame.to_excel` should stop applying bold and bordered styles to row and column headers by default. This section adapts that proposal into three choices for comparison; it does not claim a decision or later outcome.

![Current styled output shown in the source proposal](https://user-images.githubusercontent.com/24256554/208918872-c616b449-b399-42e6-8a03-b3581063857a.png)

The screenshot above is source evidence for the current output. The three small spreadsheet specimens below are illustrative reconstructions.

```openui-options
root = OptionsSection("Excel header styling choices", "The same proposal and option records, arranged for readers who want tradeoffs before illustrative outputs.", [comparison, gallery, details])
gallery = OptionGallery("Inspect the outputs", "rail", [optionB, optionA, optionC])
comparison = OptionComparison("Start with tradeoffs", [optionA, optionB, optionC])
details = OptionDetails("Read the source reasoning", [optionB, optionA, optionC])
optionA = DesignOption("a", "Keep current default", "Retains bold and bordered headers in existing exports.", "Leaves simple exports styled when some users want no formatting.", "The source report shows the current bold and bordered column and row headers. Keeping that default preserves the existing output but does not meet the request for a plain basic export.", "current")
optionB = DesignOption("b", "Plain default", "Would make a basic DataFrame export unstyled.", "Changes the appearance existing users receive by default.", "The proposal asks whether DataFrame.to_excel should omit bold and bordered header styling. Its author argues this could simplify code and make an unstyled Styler export more consistent.", "plain")
optionC = DesignOption("c", "Style with Styler", "Keeps deliberate formatting available through Styler.to_excel.", "Requires choosing the Styler path when formatting is wanted.", "The proposal suggests documenting Styler.to_excel for styled files if DataFrame.to_excel becomes plain. This is part of the proposal, not a recorded decision at this checkpoint.", "styled")
```

This arrangement leads with tradeoffs. The section, table, gallery, and detail are the same code-owned components as in the gallery-first version.
