# Third-party notice: assistant-ui message actions

`message-actions.tsx`, `use-copy-to-clipboard.ts` and the icon swap in `message-actions.css` are
adapted from assistant-ui's standalone **MessageActions** element and its `use-copy-to-clipboard`
hook. Chopin drives them with its own state through props. It does not use assistant-ui's runtime
(`AssistantRuntimeProvider`, `useAui` or any primitive that needs one), and it does not depend on
the library.

- Project: https://github.com/assistant-ui/assistant-ui
- Element page: https://www.assistant-ui.com/elements/message-actions
- Registry items: `elements-message-actions` and `use-copy-to-clipboard` from https://r.assistant-ui.com
- Source commit: `f92028b466cba721846de6851e4dddb6c04ecfad` (the registry content is byte-identical
  to `packages/ui/src/components/react/assistant-ui/elements/message-actions.tsx` and
  `packages/ui/src/hooks/use-copy-to-clipboard.ts` at that commit)
- License: MIT

What was kept: the controlled-props shape (`copied`, `onCopy`, `onMore`, toggles with `aria-pressed`),
the `data-slot="message-actions"` row, the copy and check icons crossfading in one grid cell, and the
copy hook that turns `isCopied` on only after the clipboard accepts the text and off after a delay.

What Chopin changed: the copy hook also writes an empty message instead of ignoring it; icons come from `@chopin/icons`, styles use Chopin's tokens in
`message-actions.css`, the toggles are quick reactions, Copy moved into the overflow menu, and the
thumbs and regenerate buttons are left out because Chopin cannot honour them.

```
MIT License

Copyright (c) 2026 AgentbaseAI Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
