# Adding an assistant-ui element

Chopin's elements look as assistant-ui's do, because they are assistant-ui's own source: copied from its
registry with `shadcn add`, unmodified, keeping the registry's Tailwind classes, and driven by
Chopin's own state through props. There is no assistant-ui runtime in this project (no
`@assistant-ui/react`, runtime provider or store), so Chat stays collaborative and Yjs-backed and
an element only draws what it is given.

## Which element

assistant-ui ships each element twice. The **standalone** lane, `elements-<name>`, takes props and
callbacks; the **connected** lane, `<name>`, reads a runtime. Copy the standalone one. Where an
element has only a connected form, or the connected one cannot express Chopin's state (one thread,
several authors, a queue the server keeps), say so in the pull request and draw it from props
instead of adding the runtime. The model selector, `elements-model-selector`, is the first one
copied.

## Add it

```bash
bunx shadcn@latest add @assistant-ui/elements-<name> --cwd apps/web
bun scripts/record-registry-sources.ts @assistant-ui/elements-<name>
```

The first command copies the element and what it stands on from the registries named in
[`apps/web/components.json`](../apps/web/components.json): the style `base-nova` (Base UI, as Chopin
uses `@base-ui/react`), assistant-ui's registry as
`https://r.assistant-ui.com/styles/{style}/{name}.json`, and shadcn's. Its aliases put everything in
`apps/web/src/components`, where `ui/` holds shadcn's parts, `assistant-ui/` the elements and
`hooks/` and `lib/` the rest; only `lib/utils.ts` (the registry pins it) sits in `apps/web/src/lib`.
It installs the packages the element names. Run `@assistant-ui/utils` once if `src/lib/utils.ts` is
missing. shadcn appends the `@import` an item needs to `apps/web/src/assistant-ui.css`; keep it.

The second records each copied file in `apps/web/src/components/sources.json` (its registry, item,
the upstream revision it was copied at and the sha256 of its bytes) and writes the geometry layer
again. [The design contract](design-contract.md#copied-registry-source) accepts exactly what is
recorded and nothing else: never edit a copied file (it fails its hash), and never put hand-written
code in `apps/web/src/components`. To update an element, copy it again with `--overwrite` and record
it. After a Tailwind upgrade run `bun scripts/record-registry-sources.ts` with no item.

## Sizes: assistant-ui's, not Chopin's

Chopin's theme rewrites Tailwind's scale (`rounded-xl` is 10px, `text-sm` a fluid step, and
`rounded-2xl`, `shadow-md` and `ease-in` do not exist), and a copied class cannot change. So
`apps/web/src/components/geometry.css` restores Tailwind's own value of every variable Chopin's theme
changed or dropped, on the copy's own roots (every `data-slot` the copied sources set, which is also
where a popup portalled to `<body>` is found). Chopin's elements are never inside one, so its scale
is untouched, and a copy is never given Chopin's control, pill or menu tokens. It is generated from
Tailwind's `theme.css` and checked against it; do not edit it. It also keeps Chopin's global button
rules (a `scale` press, a transition that is only `scale`, a focus outline) out of a copy, and on
touch gives the copy's controls an invisible `::after` of 44px (`--control-target-coarse`), so the
visible box never grows. An element that clips its own overflow cannot grow a target past its
edge; its box still does not move.

Chopin draws no continuous-curvature corners today, so a copy's corners are assistant-ui's own rounded
rectangles at the same radii. A pill appears only where the copy says `rounded-full`.

## Colours: Chopin's

`apps/web/src/assistant-ui.css` is the one place assistant-ui's and shadcn's colour variables meet
Chopin's tokens:

| Role                                                    | Chopin token                             |
| ------------------------------------------------------- | ---------------------------------------- |
| `background`, `card`, `popover`                         | `--color-page`                           |
| `foreground` and each `*-foreground` on a light surface | `--color-text-primary`                   |
| `primary`, `primary-foreground`                         | `--color-brand` (petrol), `--color-page` |
| `secondary`, `accent`                                   | `--color-hover`                          |
| `muted`, `muted-foreground`                             | `--color-inset`, `--color-text-tertiary` |
| `border`, `input`                                       | `--color-edge` (a hairline)              |
| `ring`                                                  | `--focus-ring-color`                     |
| `destructive`                                           | `--color-destructive`                    |

It maps roles only. Chopin's `btn-outline` edge, `btn-secondary` fill and depth shadows are not mapped,
because assistant-ui draws none of them. Chopin is light only, so `.dark` reads the same tokens and
`dark:` classes follow `.dark`, never the system setting. A copy that names a raw palette colour
(`blue-500`) needs a line in that file's `@theme`, mapped to the Chopin token that plays the role.

## Drive it from Chopin's state

An element takes props, so the seam is a plain function from Chopin's own types to them, with a
test. [`modelOptions`](../apps/web/src/chat/assistant-ui/model-options.ts) turns a document's model
catalogue into the selector's options and keeps each id and reasoning level exactly as the harness
reported it. The audit plate wires a copy to it, and state stays where it was: in Chat, the room's
socket and the server.

## The test to add

Put the element on the `assistant-ui` plate of the design audit
([`plates/assistant-ui.tsx`](../apps/web/src/design-audit/plates/assistant-ui.tsx)), every variant
and size once. Then add its roots to `ROOTS` and what a finger aims at to `TARGETS` in
[`e2e/design/assistant-ui-geometry.e2e.ts`](../e2e/design/assistant-ui-geometry.e2e.ts). It reads
each element's own classes with [`tailwind-geometry.ts`](../e2e/design/tailwind-geometry.ts), which
knows Tailwind's pixels and nothing of Chopin's, and asserts with `getComputedStyle` its height,
padding, border width, radius, gap and font size, at both widths. It then forces
`html[data-plan-coarse-pointer]` and asserts the visible boxes are identical while only the hit area
grows, through the `::after`, which it reaches with `elementFromPoint`. It runs in `bun run design:behavior`,
and fails if a Chopin rule thickens a copy.
