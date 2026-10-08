# OpenUI composition trial

This bounded trial renders one design-options section inside an ordinary Chopin document. The authored `openui-options` fence composes a gallery, comparison table, and expandable details from the same three option records. A reader's filter and open details live in local React state and never change the document.

## Inspect

Run `bun run dev`, then open `/openui-composition-trial`. The development-only page switches between [gallery first](document-gallery-first.md), [comparison first](document-comparison-first.md), and the [ordinary document](document-ordinary.md). The two OpenUI sources are [gallery first](source-gallery-first.openui) and [comparison first](source-comparison-first.openui). Changing only the seven-line source changes the section order, gallery layout, and option order; the React components are the same.

Run `bun experiments/openui-composition-trial/preview-check.ts` against the local Vite page to exercise filter, disclosure, both arrangements, wide and narrow layouts, and save screenshots under `e2e/test-results/openui-composition-trial/`. The focused Playwright suite in `e2e/openui-composition.e2e.ts` uses a real server, PostgreSQL, and browser for persistence and read-only checks. Its isolated configuration needs `E2E_DATABASE_URL_0` and a migrated database.

## Source and authorship

The example adapts [pandas issue 54154](https://github.com/pandas-dev/pandas/issues/54154) at checkpoint `c1`, cutoff `2023-07-16T12:35:00Z`. The development registry SHA-256 is `5cdc086840041f9b5c2140d90f9baa8355c7604b8b6fa46d991f09c9f3b889cb`; the frozen `real-source/pandas-excel-style/c1.json` SHA-256 is `9b38fbe59a60db9a106ef6cfbaaebf679fae0aae3bf151131fa5ebd0bee2ca39`. The source screenshot shows current output. The three small spreadsheet specimens are illustrative reconstructions. The text describes a proposal, not its later outcome.

Both checked-in document arrangements and their OpenUI source files are manually authored. [Library instructions](library-instructions.md) and [schema](library-schema.json) are generated from the five-component library; [model input](model-input.txt) appends the bounded case prompt. A single GitHub Copilot model-authoring attempt (`gpt-6-luna`) produced [raw output](model-output.raw.openui). It has source-grounded option text but physical line breaks inside quoted strings, so the seven-declaration validator rejected it. The one [repair prompt](model-repair-instructions.txt) returned [the same invalid output](model-repair-output.raw.openui). Neither model result is used by the document. The two calls cost one Copilot premium request each; [initial](model-usage.json) and [repair](model-repair-usage.json) usage records are preserved.

## Boundary and outcome

The code fence remains canonical MDX source and follows the existing document persistence path. The renderer accepts only seven named declarations, five allowlisted components, local literals, and three reused option records. It rejects excess source, missing references, state, queries, mutations, arbitrary JSX, and unsupported components before rendering. Invalid source shows an error while keeping the editable source and surrounding prose.

This second use case makes comparison and exploration materially easier to scan than the ordinary prose and table: one authored record powers the visual card, row, and disclosure, and source rearrangement changes the reading order. The cost is a narrow custom library and validator. The OpenUI `0.3.0` public web entry loads development tools from a CDN; Vite aliases the package's native entry to avoid that request. That private entry is a maintenance risk. The renderer is lazy, but its total chunk size is not an incremental bundle measurement. **Recommendation: adapt the pattern for bounded document components, and keep OpenUI experimental until its package entry and model output reliability improve.** This trial does not add generic app authoring or decision Save.

Building both parent `f1e81673` and this branch with Bun 1.4.2 measured all emitted JavaScript at 16,263,313 → 16,422,392 bytes raw (**+159,079**) and 3,709,183 → 3,758,716 bytes gzip (**+49,533**); CSS grew **3,838 raw / 1,013 gzip** bytes. The initial JavaScript stayed 249,951 bytes raw (Vite budget gzip 78,846 → 78,847 bytes). The **total** lazy `openui-options` chunk is 152,846 raw / 47,165 gzip bytes, which includes runtime and component code and is not the all-bundle delta. The development-only comparison page also adds a chunk.

## Verification

- `bun test packages/editor/src/widgets/openui-options.test.ts packages/dialect/src/nodes/content.test.ts`: 17 passed.
- Focused Playwright suite with an isolated PostgreSQL database: 3 passed, including source edits, reopen, read-only reader, adjacent prose, and invalid-source recovery.
- Preview check: wide and narrow screenshots, keyboard disclosure, filter, arrangement switch, and no narrow page overflow passed.
- `bun run types`, `bun run ci`, and `bun run build` passed. The CSS optimizer's existing `::highlight` warning and existing lint warnings remain.
- Bundle comparison used clean builds of this branch and parent commit `f1e81673` with identical Bun 1.4.2 and gzip settings.
