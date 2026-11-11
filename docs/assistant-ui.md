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
instead of adding the runtime. The model selector, `elements-model-selector`, was the first one
copied, and the composer, `elements-composer`, with the `surfaces` recipes and `range` helper it
stands on, is Chat's composer shell. Its menu and rows (`ComposerMenu`, `ComposerPersonItem`,
`ComposerCommandItem`) are Chat's `@` and `/` menus, and `elements-directive-text` and the Badge it
stands on are the Chopin chip. The same Composer holds the standalone elements for what a message
carries: its staged-file chips (`ComposerAttachments`, `ComposerAttachmentChip`) and the dictation's
voice and button (`ComposerVoice`, `ComposerVoiceButton`) fill the box's slots, and
`elements-message-attachment` draws a sent message's files. The tile the registry calls `attachment`
draws a live runtime attachment through `AttachmentPrimitive` and has no props-driven form, so it is
not copied and the chip carries a file's states from props. Each carries a
[recorded patch](#patching-a-copy) where Chat needed an extension point.

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

## Patching a copy

A copy is never edited, with one exception: a **recorded patch** that adds an extension point the
element needs, such as a prop, a slot (a `ReactNode` prop drawn where the registry put none) or a
`data-` attribute. The patch is `<file>.patch` beside the copy, a unified diff from the registry's
bytes to the file in the repository, with a one-line reason after the `@@` of every hunk:

```diff
@@ -125,6 +125,8 @@ Reason: an owner prop so a row can say whose choice it is
```

[The design contract](design-contract.md#copied-registry-source) accepts the file as "the registry
file at its recorded hash, plus exactly this patch": the record in `sources.json` keeps the registry's
`sha256` and adds `patch` and `patchSha256`, and undoing the patch on the file has to give back
exactly those registry bytes. A patch may not change a class or a size, so it has every hunk's
reason, it keeps every string the registry wrote, adds no string with a space in it, and adds no
`className`, `class`, `style`, `cn(`, `cva(`, `clsx(` or `twMerge(`. The geometry spec keeps proving the
sizes of the patched file.

```bash
# 1. the copy is committed as the registry wrote it; edit it, then write and record the patch
bun scripts/record-registry-sources.ts --patch apps/web/src/components/assistant-ui/elements/<file>.tsx \
  --reason "why the first hunk" --reason "why the second"
# 2. later, after `shadcn add ... --overwrite` brings the registry's newer bytes
bun scripts/record-registry-sources.ts @assistant-ui/elements-<name>
```

The first builds the patch from `git diff HEAD` (HEAD must hold the registry's recorded bytes; one
`--reason` for every hunk is allowed) and fails if a rule above is broken. The second applies the
patch again onto the fresh bytes and records them, or fails naming the hunk that no longer applies:
edit the patch and run it again. Until then the check fails with the same hunk, which is how
you find out that a registry update moved under a patch.

## Sizes: assistant-ui's, not Chopin's

Chopin's theme rewrites Tailwind's scale (`rounded-xl` is 10px, `text-sm` a fluid step, and
`rounded-2xl`, `shadow-md` and `ease-in` do not exist), and a copied class cannot change. So
`apps/web/src/components/geometry.css` restores Tailwind's own value of every variable Chopin's theme
changed or dropped, on the copy's own roots (`[data-slot|="command"]` for every `data-slot` whose first word a copied source
sets, which is also where a popup portalled to `<body>` is found; Chopin's own code never sets a
`data-slot` that starts with one of those words, and a unit test says so). Chopin's elements are
never inside one, so its scale is untouched, and a copy is never given Chopin's control, pill or menu tokens. It is generated from
Tailwind's `theme.css` and checked against it; do not edit it. It also keeps Chopin's global button
rules (a `scale` press, a transition that is only `scale`, a focus outline) out of a copy, and when
the primary pointer is coarse (`(pointer: coarse)`, mirrored as `data-plan-coarse-pointer`; a touch
laptop used with a mouse keeps the desktop's sizes) gives the copy's controls an invisible
`::after` of 44px (`--control-target-coarse`), so the visible box never grows. An element that
clips its own overflow cannot grow a target past its edge; its box still does not move. Stacked
rows cannot each take such a target without covering a neighbour's; see Touch targets in
[DESIGN.md](../apps/web/DESIGN.md).

The unit tests that police Chopin's own code (`focus.test.ts`, `tokens.test.ts`) skip the recorded
files through `recorded-sources.test-fixtures.ts`; a new scan of that kind should too.

Chopin draws no continuous-curvature corners today, so a copy's corners are assistant-ui's own rounded
rectangles at the same radii. A pill appears only where the copy says `rounded-full`.

A Chopin control placed inside a copy through a patch slot (a words button, a text field) carries
`data-chopin-control=""`. It gets Chopin's own scale, focus ring, press and transition and touch
rules back, and the copy's reverts and hit area skip it.

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

Shadows are Tailwind's, tinted: each `rgb(0 0 0 / x)` of Tailwind's shadow values is Chopin's shadow tint
(`--shadow-color`) at the same opacity, so no raw black is drawn. It maps roles only. Chopin's `btn-outline` edge, `btn-secondary` fill and depth shadows are not mapped,
because assistant-ui draws none of them. Chopin is light only, so `.dark` reads the same tokens and
`dark:` classes follow `.dark`, never the system setting. A copy that names a raw palette colour
(`blue-500`) needs a line in that file's `@theme`, mapped to the Chopin token that plays the role:
`red-600`, which a copy writes words in (a file's reason), is the danger text, since the destructive
red does not read as text on a soft fill (a browser spec checks the contrast).

## Drive it from Chopin's state

An element takes props, so the seam is a plain function from Chopin's own types to them, with a
test. [`modelOptions`](../apps/web/src/chat/assistant-ui/model-options.ts) turns a document's model
catalogue into the selector's options and keeps each id and reasoning level exactly as the harness
reported it. The audit plate wires a copy to it, and state stays where it was: in Chat, the room's
socket and the server.

## The tests to add

Every copied element has two specs on the `assistant-ui` plate of the design audit
([`plates/assistant-ui.tsx`](../apps/web/src/design-audit/plates/assistant-ui.tsx)): put the element
there first, every variant and size once. The theme is Chopin's and the proportions are
assistant-ui's, and each has its own spec in `bun run design:behavior`, at both widths.

**The geometry spec**,
[`e2e/design/assistant-ui-geometry.e2e.ts`](../e2e/design/assistant-ui-geometry.e2e.ts): add the
element's roots to `ROOTS` and what a finger aims at to `TARGETS`. It reads each element's own classes
with [`tailwind-geometry.ts`](../e2e/design/tailwind-geometry.ts), which knows Tailwind's pixels and
nothing of Chopin's, and asserts with `getComputedStyle` its height, padding, border width, radius,
gap and font size. It then forces `html[data-plan-coarse-pointer]` and asserts the visible boxes are
identical while only the hit area grows, through the `::after`, which it reaches with
`elementFromPoint`. It fails if a Chopin rule thickens a copy.

**The theme spec**,
[`e2e/design/assistant-ui-theme.e2e.ts`](../e2e/design/assistant-ui-theme.e2e.ts): add the roots to
`ROOTS` and any state that draws a colour of its own (hover, focus, open, checked) to `states`. In
light and in dark, in each state once its transitions have settled, every colour on the roots'
elements (text, fill, border, outline, text decoration, icon fill and stroke, every colour of every
shadow) has to resolve to one of Chopin's colour tokens from `packages/visuals/theme.css`, at that
token's opacity or less, and its text has to be Chopin's typeface. The role variables of
`assistant-ui.css` are not in that set: a role mapped to a raw colour (`blue-500`, `emerald-500`,
`black`) would vouch for itself, so it fails naming the element and the colour instead. Checked by
mapping `--accent` to a green: the spec names the trigger's hover fill.

Add both for every element; a copy without them is not accepted. To keep a spec honest, change a
mapping or a class on purpose once and see it fail.

The copies' utilities, animations, geometry layer and colour roles ship in one separate stylesheet
(`apps/web/src/assistant-ui.css`), excluded from `theme.css` (`@source not "./components"`) and
attached by [`apps/web/vite.config.ts`](../apps/web/vite.config.ts) to each copied `.tsx` module at
transform time so no file on disk changes. A page without a copied element never downloads it,
[`bundle-budget.ts`](../apps/web/bundle-budget.ts) keeps it out of the entry stylesheet, and Vite's
preload helper waits for its `<link>` before resolving the dynamic import that mounts the first copy.

Once a copy mounts, the layer is on that page, so its selectors have to be cheap: every rule's
subject is a tag, a class, an attribute or a pseudo-class the browser can find an element by
(`button`, `.border-t`, `[role="option"]`, `:focus-visible`), the ancestors it asks about are a
handful of `[data-slot|=word]`, and no subject is `*`, `[class*=]`, `:is(...)` or `:where(...)`; a
unit test reads the generated file for it. The first draft put a `*` rule under every copy, which
made the browser test every element's ancestors against some forty selectors on each style
recalculation, and a 100ms assertion of an unrelated workspace spec
(`responsive-workspace.e2e.ts`, content swaps) went from nine passes in ten to none. If a spec that
races a timer starts failing after a layer change, make the layer cheaper rather than the spec
looser.
