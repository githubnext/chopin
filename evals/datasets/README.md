# Development inputs

Use [v2/manifest.json](v2/manifest.json) and [v2.ts](v2.ts) for the committed,
offline development set. These are inputs for evaluation, not approved gold
answers or model-quality results. The historical [registry](registry.json) is
still byte-identical to eval-hub commit `0c560ea126181bd3c6911a318f9804a029f0c85a`
(SHA-256 `5cdc086840041f9b5c2140d90f9baa8355c7604b8b6fa46d991f09c9f3b889cb`).
Do not edit it to reinterpret or replace an older experiment.

| v2 input                   | Cases | Checkpoints | Material                                            |
| -------------------------- | ----: | ----------: | --------------------------------------------------- |
| Synthetic chat             |    19 |          68 | Input-only copies of generated development fixtures |
| Adapted discussion         |     7 |          27 | Attributed, source-grounded event summaries         |
| Original authored proposal |     1 |           1 | Pinned Rust async/await RFC text                    |

The 19 synthetic files remove `expectations` and other reviewer annotations from
the original fixtures. Their manifest entries retain the original file SHA-256
alongside the committed input SHA-256. The discussion files preserve the seven
original source clusters, event IDs, actors, timestamps and 27 cutoff times.
Each is explicitly marked `adapted`: its `summary` is a paraphrase, not the
contributor's wording. The manifest records source URLs, retrieval times, and
the SHA-256 of each historical checkpoint file. A loader returns only events
visible by the selected cutoff. Links in an input are inert.

The RFC is the original file from Rust RFC commit
`f63ddca7ce5cd8725ec137459ba2a930474a34e7` and matches the original
[proposal manifest](proposals.json) checksum. The Rust RFC repository says
contributions intentionally submitted for inclusion are available under MIT or
Apache 2.0; this copy uses its MIT option and carries the
[license notice](v2/proposals/LICENSE-MIT). The author is credited in the v2
manifest. The ESLint RFC supplement remains registered as historical evidence
in [proposals.json](proposals.json), but is not copied into v2 because the
pinned source repository did not provide a clear license notice for that text.
Likewise, GitHub's [site terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
do not by themselves clearly permit republication of complete third-party
issue and discussion comments outside GitHub, so v2 uses attributed summaries.

## Offline use

```ts
import { listCases, loadCase } from "./evals/datasets/v2";

let cases = listCases();
let input = await loadCase("deno-run-task", "c2");
// input.events contains only the adapted discussion visible by c2.
let proposal = await loadCase("proposal-rust-async-await");
```

Run `bun test evals/datasets/input.test.ts evals/datasets/v2.test.ts`. This reads
only tracked files and makes no network requests. `loadCase` verifies file size
and SHA-256 before parsing. Unknown, validation and reserved IDs fail before
file reads. The original [input.ts](input.ts) and
[offline importer](import-development.py) remain for historical reproduction
from an archived source checkout; they are not required for v2 or its tests.

The original corpus screened 44 public threads across 12 repositories. Its
five validation and three proposed final episodes remain outside this package,
as do twelve unopened synthetic holdouts. The original 7 discussion candidates
and the older RFC supplement are not unqualified gold. REST issue comments lack
reliable nested reply parents, and missing edits or off-platform context may
limit interpretation. A close or merge event is evidence, not an automatic
Chopin Save or verified outcome. Do not follow linked pages when evaluating a
cutoff or add later proposal text to an earlier discussion input.
