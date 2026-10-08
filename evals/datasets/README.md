# Frozen development inputs

This package registers evaluation **inputs**, not scores or approved gold. The
baseline [registry](registry.json) is byte-identical to eval-hub commit
`0c560ea126181bd3c6911a318f9804a029f0c85a` (SHA-256
`5cdc086840041f9b5c2140d90f9baa8355c7604b8b6fa46d991f09c9f3b889cb`).
Its real source files came from corpus commit
`dda78480888859ae3eec90846c1263cd28552d05`; synthetic fixtures came from
`446a9779a937fa5be7cd3eb52fd7f3023d691ed2`. Do not change this registry
when adding source interpretations or supplemental cases.

| Input class                  | Cases |       Checkpoints | Status                                                  |
| ---------------------------- | ----: | ----------------: | ------------------------------------------------------- |
| Real asynchronous discussion |     7 |                27 | Original source wording; candidate interpretations only |
| Real authored RFC            |     2 | 2 pinned versions | Separate development supplement                         |
| Source-grounded adaptation   |     0 |                 0 | None included                                           |
| Synthetic chat               |    19 |                68 | Separate generated fixtures                             |

The original corpus screened 44 public threads across 12 repositories and
proposed 15 episodes / 58 checkpoints. Only its seven development episodes are
loadable here. The five validation and three proposed final episodes remain out
of this package. Twelve synthetic held-out cases remain archived and unopened.
Partition assignments keep whole source clusters together. The focused Vite
reply chain represents only part of its source discussion.

The seven discussion URLs and retrieval times are in [sources.json](sources.json).
The [proposal supplement](proposals.json) pins the first RFC text committed to
[Rust async/await](https://github.com/rust-lang/rfcs/pull/2394) and
[ESLint per-rule autofix](https://github.com/eslint/rfcs/pull/134). Their pinned
commits and byte hashes are recorded separately so the baseline cannot change
silently. ESLint's supplement shares a source cluster with its development
discussion; never append that proposal to an earlier discussion checkpoint.

## Local use

The full inputs and 22 selected source-evidence files are in the ignored
`data/visual-doc-corpus/` directory on this host. No raw or sealed archive is
tracked. To restore the 48 baseline files from a checkout containing the
source commits, run:

```bash
python3 evals/datasets/import-development.py --source-git /path/to/source-checkout
```

The proposal text is separate. Download its two pinned versions, then verify
them against [proposals.json](proposals.json):

```bash
mkdir -p data/visual-doc-corpus/development/proposals
curl -fsSL -o data/visual-doc-corpus/development/proposals/proposal-rust-async-await.md https://raw.githubusercontent.com/rust-lang/rfcs/f63ddca7ce5cd8725ec137459ba2a930474a34e7/text/0000-async_await.md
curl -fsSL -o data/visual-doc-corpus/development/proposals/proposal-eslint-per-rule-autofix.md https://raw.githubusercontent.com/eslint/rfcs/41598f3a0d81f56ae6c75f59273269a54db50085/designs/2024-per-rule-autofix-configuration/README.md
python3 evals/datasets/import-development.py --with-proposals
bun test evals/datasets/input.test.ts
```

The importer itself makes no network request, nor does it fetch linked pages
inside an input. Use `listDevelopment()` and `loadInput(id, checkpointId)` from
[input.ts](input.ts) for the baseline; use `listProposals()` and
`loadProposal(id)` for the supplement. Both loaders verify bytes before
returning text. Unknown, validation, and reserved IDs fail before file reads.
The discussion loader returns only the selected cutoff file and omits
annotations, future events, and later outcomes. All links in returned inputs
are inert: a runner must not follow them. In a clean checkout, four
manifest and access-boundary tests run; six local-fidelity tests skip until
the ignored snapshot is restored.

## Source and reuse limits

The source comments are public research evidence, but their republication was
not cleared. The code repository license does not grant rights to third-party
comment wording. This repository therefore carries URLs, timestamps, hashes,
methods, and access code, without publishing the full comment bodies. The
local inputs preserve speaker identity, wording, reply links where recorded,
process events, and chronological cutoffs for evaluation. REST issue comments
have no recoverable nested reply parents; edited or deleted historical wording
and off-platform discussion may be missing. A close, merge, or participant's
shipping report is evidence, not an automatic Chopin Save or verified outcome.

Candidate annotations stay outside model input. Human review is still needed
for episode boundaries, decision authority, missing context, and any public
release of source text. The source set is not a statistically representative
benchmark and has no approved gold labels or model-quality result.
