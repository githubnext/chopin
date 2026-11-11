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

## assistant-ui: Copy confirmation hook

The Chat message toolbar's action row (`components/assistant-ui/elements/message-actions.tsx`, with a
recorded extension-point patch `message-actions.tsx.patch`) and its overflow menu
(`components/ui/dropdown-menu.tsx`) are copied directly from their registries and listed in the
recorded-source table below. The clipboard confirmation hook (`apps/web/src/chat/actions/use-copy-to-clipboard.ts`)
is adapted from [assistant-ui](https://github.com/assistant-ui/assistant-ui)'s standalone
`use-copy-to-clipboard` registry item (no runtime, `AssistantRuntimeProvider` or `useAui`).

- **Hook:** `use-copy-to-clipboard` (<https://r.assistant-ui.com/styles/base-nova/use-copy-to-clipboard.json>),
  documented with <https://www.assistant-ui.com/elements/message-actions>.
- **Version:** commit `f92028b466cba721846de6851e4dddb6c04ecfad` of `assistant-ui/assistant-ui`
  (`packages/ui/src/hooks/use-copy-to-clipboard.ts`).
- **What was kept:** `isCopied` turning on only once `navigator.clipboard.writeText` resolves and off
  after `copiedDuration`, with a generation counter cancelling stale completions on unmount.
- **What changed:** empty messages (`""`) are copied instead of ignored, and a refused clipboard write
  sets `isFailed` for `copiedDuration` so the menu item and live region say _Couldn't copy_.
  assistant-ui's registry ships no separate multi-user reactions element, so `reaction-pills.tsx`
  renders Chopin's per-person emoji counts directly from props in assistant-ui's 28px borderless pill
  proportions.

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
([how](docs/assistant-ui.md)). Three carry a recorded patch beside them (`composer.tsx.patch`,
`directive-text.tsx.patch` and `markdown-text.tsx.patch`): props that draw a person's own picture and a
tag in a row, give a staged file's chip the id of the file, a picture in place of its icon and what a
surface offers beside its status, let the dictation's clock say a minute, draw a control inside a chip,
and forward props, a `data-slot` root and `CodeHeader`'s button slot on `MarkdownText`, which add
extension points and change no class or size. Those on
2026-11-10:

| File (under `apps/web/src/`)                                 | Registry      | Item                          | Upstream revision                        |
| ------------------------------------------------------------ | ------------- | ----------------------------- | ---------------------------------------- |
| `components/assistant-ui/elements/composer.tsx`              | @assistant-ui | `elements-composer`           | `assistant-ui/assistant-ui@d25a97a22f00` |
| `components/assistant-ui/elements/directive-text.tsx`        | @assistant-ui | `elements-directive-text`     | `assistant-ui/assistant-ui@2c298dfa8392` |
| `components/assistant-ui/elements/image-gallery.tsx`         | @assistant-ui | `elements-image-gallery`      | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/elements/image.tsx`                 | @assistant-ui | `image`                       | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/elements/markdown-text.tsx`         | @assistant-ui | `markdown-text`               | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/elements/message-actions.tsx`       | @assistant-ui | `elements-message-actions`    | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/elements/message-attachment.tsx`    | @assistant-ui | `elements-message-attachment` | `assistant-ui/assistant-ui@ec601b37f6b6` |
| `components/assistant-ui/elements/model-selector.tsx`        | @assistant-ui | `elements-model-selector`     | `assistant-ui/assistant-ui@d25a97a22f00` |
| `components/assistant-ui/elements/surfaces.tsx`              | @assistant-ui | `elements-surfaces`           | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/elements/tooltip-icon-button.tsx`   | @assistant-ui | `tooltip-icon-button`         | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/utils/href.ts`                      | @assistant-ui | `elements-href`               | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/utils/model-selection.ts`           | @assistant-ui | `elements-model-selection`    | `assistant-ui/assistant-ui@d25a97a22f00` |
| `components/assistant-ui/utils/range.ts`                     | @assistant-ui | `elements-range`              | `assistant-ui/assistant-ui@437b410726e2` |
| `components/assistant-ui/utils/useIsomorphicLayoutEffect.ts` | @assistant-ui | `elements-surfaces`           | `assistant-ui/assistant-ui@437b410726e2` |
| `components/geometry.css`                                    | tailwindcss   | `theme.css`                   | `tailwindcss@4.3.0`                      |
| `components/hooks/use-copy-to-clipboard.ts`                  | @assistant-ui | `use-copy-to-clipboard`       | `assistant-ui/assistant-ui@437b410726e2` |
| `components/ui/badge.tsx`                                    | @assistant-ui | `badge`                       | `assistant-ui/assistant-ui@2c298dfa8392` |
| `components/ui/button.tsx`                                   | @shadcn       | `button`                      | `shadcn-ui/ui@dd41d19e2f80`              |
| `components/ui/command.tsx`                                  | @shadcn       | `command`                     | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/dialog.tsx`                                   | @shadcn       | `dialog`                      | `shadcn-ui/ui@dd41d19e2f80`              |
| `components/ui/dropdown-menu.tsx`                            | @shadcn       | `dropdown-menu`               | `shadcn-ui/ui@dd41d19e2f80`              |
| `components/ui/input-group.tsx`                              | @shadcn       | `input-group`                 | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/input.tsx`                                    | @shadcn       | `input`                       | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/popover.tsx`                                  | @shadcn       | `popover`                     | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/textarea.tsx`                                 | @shadcn       | `textarea`                    | `shadcn-ui/ui@8ab27715521c`              |
| `components/ui/tooltip.tsx`                                  | @shadcn       | `tooltip`                     | `shadcn-ui/ui@dd41d19e2f80`              |
| `lib/utils.ts`                                               | @assistant-ui | `utils`                       | `assistant-ui/assistant-ui@d25a97a22f00` |

`components/geometry.css` is generated from Tailwind CSS's own `theme.css` (MIT, Tailwind Labs, Inc.)
and holds only its values. `markdown-text.tsx` has no standalone (`elements-markdown-text`) registry
entry, so its `@assistant-ui/react` and `@assistant-ui/react-markdown` imports are pointed by
`apps/web/tsconfig.json` and `vite.config.ts` at Chopin's props-driven `react-markdown` seam
(`src/chat/assistant-ui/markdown-primitive.tsx`). The packages these files import, none copied, are
`cmdk` (MIT), `class-variance-authority` (Apache-2.0), `cn` (MIT), `lucide-react` (ISC), `remark-gfm`
(MIT), `tw-animate-css` (MIT) and `tw-shimmer` (MIT, assistant-ui's own, for `surfaces.tsx`'s
shimmer), beside the `@base-ui/react` and `react-markdown` Chopin already used. The adaptations above
that were written by hand from assistant-ui's source (the connection and failure banners) are
unchanged, and are replaced by copies as their elements are migrated.

The Chat composer, message images and read-only Markdown are drawn from these copies. The composer's
model pill opens the Model selector; its `@` and `/` menus are the Composer's menu with its Mentions row
(`ComposerPersonItem`) and Slash commands row (`ComposerCommandItem`), driven by Chopin's own pure
functions (`mentions.ts`, `commands.ts`) in place of the element's `useMentionMatches`,
`useSlashMatches` and `applyMention`, because the draft keeps its caret and its references; the Chopin
chip is Directive text's chip with a Badge; the files a message stages are the Composer's attachment
chips, the microphone its voice and voice button, the non-image files of a sent message
`MessageAttachments`, every image in a Chat message (Planner, Markdown or attached) `Image` and
`ImageGallery` with `ImageGallery`'s `<Dialog>` lightbox, and Chat messages, decision cards and
phrases `MarkdownText`. None of assistant-ui's runtime is used.

### License

The adaptations above (the connection and failure banners) and the files copied from
assistant-ui's registry are under assistant-ui's MIT licence:
The adaptations above (the connection and failure banners, the message actions and MarkdownText)
and the files copied from assistant-ui's registry are under assistant-ui's MIT licence:

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
