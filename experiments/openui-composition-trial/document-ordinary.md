# Excel header styling choices

The pandas development source asks whether `DataFrame.to_excel` should stop applying bold and bordered styles to row and column headers by default. This ordinary document presents the same choices without OpenUI. It does not claim a decision or later outcome.

## Current output

![Current styled output shown in the source proposal](https://user-images.githubusercontent.com/24256554/208918872-c616b449-b399-42e6-8a03-b3581063857a.png)

The source screenshot shows bold and bordered headers in the current output. The options below are a source-grounded interpretation of the proposal.

## Keep current default

Retains bold and bordered headers in existing exports. It leaves simple exports styled when some users want no formatting.

The source report shows the current bold and bordered column and row headers. Keeping that default preserves the existing output but does not meet the request for a plain basic export.

## Plain default

Would make a basic `DataFrame.to_excel` export unstyled. It changes the appearance existing users receive by default.

The proposal asks whether `DataFrame.to_excel` should omit bold and bordered header styling. Its author argues this could simplify code and make an unstyled Styler export more consistent.

## Style with Styler

Keeps deliberate formatting available through `Styler.to_excel`. It requires choosing the Styler path when formatting is wanted.

The proposal suggests documenting `Styler.to_excel` for styled files if `DataFrame.to_excel` becomes plain. This is part of the proposal, not a recorded decision at this checkpoint.

| Option               | Strength                                               | Tradeoff                                                         |
| :------------------- | :----------------------------------------------------- | :--------------------------------------------------------------- |
| Keep current default | Retains bold and bordered headers in existing exports. | Leaves simple exports styled when some users want no formatting. |
| Plain default        | Would make a basic export unstyled.                    | Changes the appearance existing users receive by default.        |
| Style with Styler    | Keeps deliberate formatting available.                 | Requires choosing the Styler path when formatting is wanted.     |

The proposal asks for feedback; this checkpoint does not establish the outcome.
