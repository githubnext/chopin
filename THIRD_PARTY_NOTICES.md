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
    `overrides/withDefaults.ts` (`2c9bcc745cbe40f09c862e4a626da4831b074474`), in `code-blocks.tsx`.

**What changed.** The element's own page says that, standalone, MarkdownText has no controlled form:
its primitive reads the text from the surrounding message part with `useMessagePartText()` and
`INTERNAL.useSmooth()` of `@assistant-ui/react`, which need that library's runtime. Chopin does not use
that runtime (its Chat is collaborative and Yjs-backed), so the one seam that read the message part is
replaced by two props, `text` and `status`; `status` is drawn as `data-status`, as upstream's runtime
status was. The primitive's own `className`, `containerProps` (its class merged with the root's),
`containerComponent`, `defer` and the react-markdown options are kept under their upstream names. Added:
`lead`, an inline lead drawn inside the root before the first block (Chat's leading `@chopin`). Not
taken: `smooth`, the typewriter reveal, which is `INTERNAL.useSmooth`, and `preprocess`, which nothing
here uses. Upstream styles each element with Tailwind utility classes and shadcn colour names; the
elements here keep upstream's `aui-md-*` class names, and the way a given class joins the element's own,
and are styled with Chopin's tokens in `markdown-text.css`. The copy button is Chopin's icon button
and icons. `classnames` is a one-line join and `@types/hast` is replaced by react-markdown's own type.
No `@assistant-ui/*` package is a dependency, and `apps/web/src/markdown-text/markdown-text.test.tsx`
fails if one is imported.

`gfm.ts` is Chopin's, not upstream's: the element passes `remark-gfm` to its renderer, and that is the
element's default here. Chat's messages pass a plugin built from `micromark-extension-gfm-table`,
`-strikethrough` and `-task-list-item` and their `mdast-util-*` counterparts (MIT, unified collective),
because `remark-gfm` also reads footnotes and bare addresses, which Chat has always shown as text.

## assistant-ui and shadcn/ui: copied registry source

Components in `apps/web/src/components/` (and `apps/web/src/lib/utils.ts`) are **copied unmodified**
with `shadcn add` from the [assistant-ui](https://github.com/assistant-ui/assistant-ui) registry
(`https://r.assistant-ui.com/styles/base-nova/{name}.json`, MIT) and from the
[shadcn/ui](https://github.com/shadcn-ui/ui) registry they stand on
(`https://ui.shadcn.com/r/styles/base-nova/{name}.json`, MIT), and they keep those registries'
Tailwind classes. They are the standalone (props-driven) lane of assistant-ui's elements: nothing of
its runtime is used and no `@assistant-ui/*` package is a dependency. Each file is recorded in
[`apps/web/src/components/sources.json`](apps/web/src/components/sources.json) with its registry,
item, upstream revision (the registry's repository at its main commit when it was fetched) and the
sha256 of its bytes, and the design contract fails if one is edited
([how](docs/assistant-ui.md)). Two carry a recorded patch beside them (`composer.tsx.patch` and
`directive-text.tsx.patch`): props that draw a person's own picture and a tag in a row, give a staged
file's chip the id of the file, a picture in place of its icon and what a surface offers beside its
status, and let the dictation's clock say a minute, and a control drawn inside a chip, which add an
extension point and change no class or size. Those on
2026-11-10:

| File (under `apps/web/src/`)                                 | Registry      | Item                          | Upstream revision                        |
| ------------------------------------------------------------ | ------------- | ----------------------------- | ---------------------------------------- |
| `components/assistant-ui/elements/composer.tsx`              | @assistant-ui | `elements-composer`           | `assistant-ui/assistant-ui@d25a97a22f00` |
| `components/assistant-ui/elements/directive-text.tsx`        | @assistant-ui | `elements-directive-text`     | `assistant-ui/assistant-ui@2c298dfa8392` |
| `components/assistant-ui/elements/message-attachment.tsx`    | @assistant-ui | `elements-message-attachment` | `assistant-ui/assistant-ui@ec601b37f6b6` |
| `components/assistant-ui/elements/model-selector.tsx`        | @assistant-ui | `elements-model-selector`     | `assistant-ui/assistant-ui@d25a97a22f00` |
| `components/assistant-ui/elements/surfaces.tsx`              | @assistant-ui | `elements-surfaces`           | `assistant-ui/assistant-ui@ec601b37f6b6` |
| `components/assistant-ui/utils/model-selection.ts`           | @assistant-ui | `elements-model-selection`    | `assistant-ui/assistant-ui@d25a97a22f00` |
| `components/assistant-ui/utils/range.ts`                     | @assistant-ui | `elements-range`              | `assistant-ui/assistant-ui@d25a97a22f00` |
| `components/assistant-ui/utils/useIsomorphicLayoutEffect.ts` | @assistant-ui | `elements-surfaces`           | `assistant-ui/assistant-ui@ec601b37f6b6` |
| `components/geometry.css`                                    | tailwindcss   | `theme.css`                   | `tailwindcss@4.3.0`                      |
| `components/ui/badge.tsx`                                    | @assistant-ui | `badge`                       | `assistant-ui/assistant-ui@2c298dfa8392` |
| `components/ui/button.tsx`                                   | @shadcn       | `button`                      | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/command.tsx`                                  | @shadcn       | `command`                     | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/dialog.tsx`                                   | @shadcn       | `dialog`                      | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/input-group.tsx`                              | @shadcn       | `input-group`                 | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/input.tsx`                                    | @shadcn       | `input`                       | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/popover.tsx`                                  | @shadcn       | `popover`                     | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/textarea.tsx`                                 | @shadcn       | `textarea`                    | `shadcn-ui/ui@8ab27715521c`              |
| `lib/utils.ts`                                               | @assistant-ui | `utils`                       | `assistant-ui/assistant-ui@d25a97a22f00` |

`components/geometry.css` is generated from Tailwind CSS's own `theme.css` (MIT, Tailwind Labs, Inc.)
and holds only its values. The packages these files import, none copied, are `cmdk` (MIT),
`class-variance-authority` (Apache-2.0), `cn` (MIT), `lucide-react` (ISC), `tw-animate-css` (MIT) and
`tw-shimmer` (MIT, assistant-ui's own, for `surfaces.tsx`'s shimmer),
beside the `@base-ui/react` Chopin already used. The adaptations above that were written by hand from
assistant-ui's source (the banners and MarkdownText) are unchanged, and are replaced by copies as
their elements are migrated.

The Chat composer is drawn from these copies. Its model pill opens the Model selector; its `@` and
`/` menus are the Composer's menu with its Mentions row (`ComposerPersonItem`) and Slash commands row
(`ComposerCommandItem`), driven by Chopin's own pure functions (`mentions.ts`, `commands.ts`) in place
of the element's `useMentionMatches`, `useSlashMatches` and `applyMention`, because the draft keeps its
caret and its references; the Chopin chip is Directive text's chip with a Badge; the files a message
stages are the Composer's attachment chips, the microphone its voice and voice button, and the files
of a sent message `MessageAttachments`. None of assistant-ui's runtime is used.

### License

The adaptations above (the connection and failure banners and MarkdownText) and the files copied from
assistant-ui's registry are under assistant-ui's MIT licence:

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

`remark-gfm` and the strikethrough and task-list packages of `micromark-extension-gfm-*` and
`mdast-util-gfm-*` are the new dependencies (MIT, unified collective); the table packages were already
one. `remark-gfm` is there because the upstream element passes it to its renderer.

The files copied from shadcn/ui's registry are under its MIT licence:

```
MIT License

Copyright (c) 2023 shadcn

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
