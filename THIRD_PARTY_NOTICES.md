# Third-party notices

## assistant-ui elements

Two components in `apps/web/src/chat/` are adapted from the standalone (props-driven) lane of
[assistant-ui](https://github.com/assistant-ui/assistant-ui)'s elements. They use none of its
runtime: no `AssistantRuntimeProvider`, `useAui` or runtime primitives.

| Chopin file                              | Upstream element                                                                                                       | Upstream source                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/web/src/chat/connection-state.tsx` | [`ConnectionState`](https://www.assistant-ui.com/elements/connection-state), registry item `elements-connection-state` | `packages/ui/src/components/react/assistant-ui/elements/connection-state.tsx` |
| `apps/web/src/chat/error-state.tsx`      | [`ErrorState`](https://www.assistant-ui.com/elements/error-state), registry item `elements-error-state`                | `packages/ui/src/components/react/assistant-ui/elements/error-state.tsx`      |

Both were copied by hand from the registry items (`https://r.assistant-ui.com/elements-connection-state.json`
and `elements-error-state.json`), which match `assistant-ui/assistant-ui` at commit `f92028b4`
(main, fetched 2026-11-09). The registry's `surfaces` helper, `tw-shimmer`, `lucide-react` and the
shadcn `cn` utility are not used; the classes are replaced with Chopin's tokens, text roles, button
sizes and icons.

## assistant-ui: MarkdownText

Chopin's read-only Markdown (Chat messages, decision cards, the phrases inside them) is drawn by
`apps/web/src/markdown-text/`, which is source adapted from the MarkdownText element of
[assistant-ui](https://github.com/assistant-ui/assistant-ui) (MIT licence).

- **Element:** MarkdownText, https://www.assistant-ui.com/elements/markdown-text
- **Commit:** `f92028b466cba721846de6851e4dddb6c04ecfad` of `assistant-ui/assistant-ui`
  (2026-11-09), with `@assistant-ui/react-markdown` 0.14.25.
- **Source files** (path, then git blob):
  - `packages/ui/src/components/react/assistant-ui/elements/markdown-text.tsx`
    (`e1d670e1b5bdb2f46167ed3c896711e24aa28950`): the `aui-md-*` element set and `CodeHeader`, in
    `default-components.tsx`.
  - `packages/react-markdown/src/primitives/MarkdownText.tsx`
    (`b50dd08628f6c65679c1b2724529b8d5c6c75735`): the memoized and deferred renderer, the stable-props
    hooks and the code override context, in `markdown-text.tsx`.
  - `packages/react-markdown/src/memoization.tsx` (`84b15e0198015197c8f18265334b3a0c0a037f0d`), in
    `memoization.tsx`.
  - `packages/react-markdown/src/code-fence.ts` (`3453b39f5bf0218849586f52146dc0004176092d`),
    `overrides/types.ts` (`bf0a6c5e9594f6331bd9e53f24cc083384d81be8`),
    `overrides/PreOverride.tsx` (`10a778e27ebd7696156a586f635763e1d36427e5`),
    `overrides/CodeOverride.tsx` (`556ff6f8ec4edf4aad94c2ef1a7206f8a50c89c4`),
    `overrides/CodeBlock.tsx` (`23743f4581f5b8b7cc442d0670d588585c94c9b7`),
    `overrides/defaultComponents.tsx` (`299b9b1d4f0b568c317c37dca7ef3fca5961e965`) and
    `overrides/withDefaults.ts`, in `code-blocks.tsx`.

**What changed.** The element's own page says that, standalone, MarkdownText has no controlled form:
its primitive reads the text from the surrounding message part with `useMessagePartText()` and
`INTERNAL.useSmooth()` of `@assistant-ui/react`, which need that library's runtime. Chopin does not use
that runtime (its Chat is collaborative and Yjs-backed), so the one seam that read the message part is
replaced by two props, `text` and `status`; `status` is drawn as `data-status`, as upstream's
runtime status was. The `smooth` typewriter reveal is `INTERNAL.useSmooth` and is not taken. Added:
`container`, `containerProps` and `lead`. Upstream styles each element with Tailwind utility classes and
shadcn colour names; the elements here keep upstream's `aui-md-*` class names and are styled with
Chopin's tokens in `markdown-text.css`. `classnames` is a one-line join and `@types/hast` is replaced by
react-markdown's own type. No `@assistant-ui/*` package is a dependency, and
`apps/web/src/markdown-text/markdown-text.test.tsx` fails if one is imported.

### License

Both adaptations above are under assistant-ui's MIT licence:

```
MIT License

Copyright (c) 2026 AgentbaseAI Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

`remark-gfm` (MIT, unified collective) is the one new dependency, because the upstream element passes it
to its renderer.
