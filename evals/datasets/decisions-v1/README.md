# decisions-v1

A corpus of 127 real software decisions debated on public GitHub threads, plus
41 decision records taken from complete documents (ADRs, KEPs, meeting minutes,
PEPs and RFC texts). It has two jobs:

1. **Coverage critique** for Chopin's questions feature. Each decision record
   says which question shape it needed (explore, choice, tune, check), which
   flows it exercised, and what it needed that the design does not offer.
2. **Evals.** Each case file uses the v2 `async-discussion` format from
   [`../v2/discussions`](../v2/discussions/README.md), with 2–4 cutoffs at
   meaningful moments.

| File                                 | Contents                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`cases/*.json`](cases)              | 127 adapted threads, 8,367 paraphrased events                                                |
| [`decisions.jsonl`](decisions.jsonl) | 132 decision records; a thread may hold more than one                                        |
| [`manifest.json`](manifest.json)     | Path, SHA-256, bytes, source URL, retrieval time and cutoff purposes per case                |
| [`stats.json`](stats.json)           | Shape, flow and gap distributions, plus process shares                                       |
| [`candidates.json`](candidates.json) | Every one of the 192 screened candidates and its outcome                                     |
| [`validate.py`](validate.py)         | Schema, enum, identity, manifest and licensing-leak checks                                   |
| [`tools/`](tools)                    | The fetcher, normaliser, assembler, packager and annotation guide                            |
| [`documents/`](documents)            | 41 decision records from complete documents, with no case files ([below](#document-records)) |
| [`analysis/`](analysis)              | The coverage critique, rerun on all 173 records ([below](#analysis))                         |

## Provenance

The 192 candidates came from two sources:

- **24 seeds** from an earlier cloud session's scratch corpus.
- **168 search hits** from `gh search issues`, `gh search prs` and GraphQL
  discussion search, targeted at the six source quotas below.

Every candidate was refetched through the GitHub API (`gh api`) on
2026-10-18; each case records its exact `retrievedAt`:

- **Discussions:** GraphQL, with both comment levels paginated.
- **Issues:** REST issue, comments, timeline and reactions.
- **PRs:** the issue endpoints plus reviews, review comments and the changed-file
  count.

Raw responses live only in the git-ignored `.cache/decisions/`.
`tools/normalise.py` turns each thread into an event skeleton. Every structural
field comes from the API and is never typed by hand: IDs, actors, `actorId`,
`actorType`, times, URLs and reply parents.

Annotation was done by Claude subagents, one per batch of threads, following
[`tools/ANNOTATING.md`](tools/ANNOTATING.md). Each subagent:

- read the digest, screened the thread,
- wrote one paraphrased summary per event,
- placed the cutoffs, and
- filled the decision record.

`tools/assemble.py` merges the summaries into the skeleton.
`tools/check_ann.py` and `validate.py` checked every annotation. Two
cross-references that carried the decision were followed one hop and merged
into their case: a Node.js TSC vote PR and a Home Assistant core PR. Other
followed links are cited in `sources` only.

Of the 192 candidates:

- **127 were kept** (14 of them seeds).
- **20 were discarded**: support Q&A, +1 piles, a single-author memo, or a
  design settled elsewhere.
- **45 were fetched but not screened**, because their quota was already met
  when screening stopped. Six are seeds: the very long Go threads #57001,
  #48429, #49085, #19412 and discussions 58409 and 54763. `candidates.json`
  records every status and reason. The v2 discussion threads were excluded.

## Holdout check

On 2026-10-19 every candidate, case source, related thread, decision-record
source and implementation link, including the 41 document records, was checked against the 8 holdout threads: 5 for
validation from eval-hub partition snapshot
`dda78480888859ae3eec90846c1263cd28552d05`, and 3 sealed for final tests. None
matched, and no kept thread or source document links to any of them. Every
thread URL in that snapshot's conversation corpus was also checked, and none
matched. The holdout URLs are deliberately not recorded here. Rerun
`tools/holdout_check.py <urls-file>` after adding cases.

## Document records

[`documents/decisions.jsonl`](documents/decisions.jsonl) holds 41 decision
records an earlier cloud session wrote from complete files in public
repositories:

| Source                                                    | Records |
| --------------------------------------------------------- | ------: |
| TC39 meeting notes                                        |      15 |
| Engineering ADRs, Kubernetes KEPs and Node.js TSC minutes |      16 |
| Python PEPs                                               |       6 |
| Rust RFC text and lang-team notes                         |       4 |

They are the cloud corpus v0 records whose `fidelity.method` was `git-file`,
excluding its `chopin-v2` collector. Its webfetch and mixed records were
dropped, because this corpus refetched those threads in full. None shares a
source URL with the thread records.

These records come from documents, not threads, so they have no case files and
no cutoffs. [`documents/convert_v0.py`](documents/convert_v0.py) converts them
to this corpus's record format:

- `caseId` is `null`, `collector` is `cloud-git` and `fidelity.method` is `git-file`.
- `fitsFlows` loses v0's `F1`-style prefixes.
- Free-text deciders map onto the `decider` enum. The original wording is kept in
  `notes`.
- `process.reactionsTotal` is `null`. `process.decidedOffPlatform` defaults to
  `false`, because v0 had no such field.
- Each gap becomes `cluster: detail`. The cluster comes from the gap's v0 tag,
  using this corpus's cluster names where they match. v0's extra fields
  (`gapTags`, `personaRelevance`, `contentKind`, `kruchtenKind`, `codingPass`)
  are dropped.
- Counts a document cannot supply (`participants.count`, `durationDays`,
  `comments`) stay `null` where v0 left them `null`.

The records are paraphrases written by the cloud session. They were checked the
same way as the thread records:

- [`documents/fetch_docs.py`](documents/fetch_docs.py) fetches all 72 distinct
  source documents through `gh api` into the git-ignored
  `.cache/decisions/docs/`. PEPs are read from `python/peps`.
- [`documents/validate.py`](documents/validate.py) runs the main validator's
  record checks, allowing only the differences above. It also fails on any run
  of 8 or more words copied from the source documents.

Two v0 phrases failed the leak check and are reworded in `convert_v0.py`.

## Analysis

[`analysis/`](analysis) holds the two critiques the cloud session wrote against
v0, kept unchanged. It also holds a rerun on this corpus:

- [`coverage-critique.md`](analysis/coverage-critique.md): H1–H12 retested, and
  the gaps re-ranked, for the whole corpus, threads only and the small-team quota.
- [`analyse_corpus.py`](analysis/analyse_corpus.py): produces
  [`corpus-metrics.json`](analysis/corpus-metrics.json).
- [`thread-gap-tags.json`](analysis/thread-gap-tags.json): codes each thread gap
  into v0's tag vocabulary, so the two sources count alike.
- [`tag-reliability.json`](analysis/tag-reliability.json): a blind recode of
  60 document gaps against v0's tags (κ = 0.68).

## Licensing approach

GitHub's terms do not clearly permit republishing third-party comments, so
committed files contain **attributed paraphrases only**:

- Each event's `summary` is a new one- or two-sentence description of the
  position taken, with the actor's role made clear.
- Nothing is quoted.
- Logins are public handles.

`validate.py` compares every summary and every free-text record field with that
case's own cached source threads. It fails on any run of 8 or more consecutive
words that also appears in the source. Annotators reworded every hit; the
committed set has none. The check needs the local raw cache. Without it, the
check warns and skips.

A few annotators chose not to include linked threads with abusive comments, and
hidden off-topic comments are summarised only as hidden.

## Counts

Source quotas (target vs kept):

| Quota                                              | Target | Kept |
| -------------------------------------------------- | -----: | ---: |
| Product, UI/UX and behaviour (`product-ui`)        |     30 |   35 |
| Debates inside PR reviews (`pr-debate`)            |     20 |   26 |
| Formal processes (`formal-process`)                |     15 |   24 |
| Engineering-team decisions in issues (`eng-issue`) |     15 |   20 |
| Small teams and solo maintainers (`small-team`)    |     10 |   11 |
| Open choice (`open-choice`)                        |     10 |   11 |

Annotators reassigned a thread's quota when it fitted better. For example, Home
Assistant architecture threads settled by an ADR moved to `formal-process`, and
repos with more than five regular contributors left `small-team`. The overrun
comes from parallel batches finishing after the quotas filled; no kept case
was dropped to hit a target.

| Domain                                     | Decisions |
| ------------------------------------------ | --------: |
| ui-ux                                      |        32 |
| product-behaviour                          |        22 |
| api-design                                 |        22 |
| architecture                               |        11 |
| compatibility, language-design, data-model |    8 each |
| process-governance                         |         6 |
| tooling, naming                            |    5 each |
| security                                   |         3 |
| infra, dependency                          |    1 each |

| Outcome (`how`)     | Decisions |
| ------------------- | --------: |
| maintainer-decision |        78 |
| consensus           |        18 |
| fcp                 |        12 |
| default/no-action   |        10 |
| abandoned           |         7 |
| unclear             |         4 |
| vote                |         3 |

117 of the 132 decisions (89%) reached a decision. The rest are open, abandoned
or postponed.

| Primary shape | Decisions | As secondary shape |
| ------------- | --------: | -----------------: |
| choice        |        93 |                 30 |
| mixed         |        11 |                  — |
| check         |        11 |                 32 |
| explore       |        10 |                 33 |
| tune          |         7 |                 22 |

The median decision involved 18 human participants and took 188 days from
opening to decision. See [`stats.json`](stats.json) for the gap clusters and
process shares.

## Known limits

- **One annotator per thread.** Each case was annotated once by a model, with no
  second annotator and no agreement measure. Shapes, gaps, roles and outcomes
  are judgements. Read the record, not just the label.
- **Gap names are free text.** `stats.json` folds them into clusters using the
  keyword rules in `tools/package.py`. Single-occurrence gaps that match no rule
  appear as `other: …`.
- **Sub-questions are over-reported.** Annotators listed sub-questions for
  nearly every decision (98.5%), so `shareWithSubQuestions` says little. The
  coupling-gap share (38.6%) is the more useful measure.
- **Edits.** Summaries describe each comment's final text. `editedAt` is
  recorded, but no event sets `visibleAt`, so a cutoff may show an edit's
  content before the edit happened.
- **The 150-event cap.** Two cases, `go-try-builtin` (822 source events) and
  `nextjs-app-router-file-conventions` (481), keep the opening, maintainers,
  bots, process events and the most-reacted comments. Their records are marked
  `fidelity.truncated`. `participants.count`, `comments` and `reactionsTotal`
  always count the whole thread.
- **Missing close events.** GitHub's timeline API omitted the close event on
  7 issues and PRs, including Go's `try` proposal. Those cases carry a close
  event built from `closed_at`, with the actor recorded as `unknown`.
- **What `implementedIn` cites.** Go changes cite `go.dev/cl` Gerrit changes,
  and Node.js PRs show as closed rather than merged because they land through
  the commit queue. An open, unmerged PR is never listed as an implementation.
- **Off-platform evidence.** Meetings, Discord, blog posts and private data are
  recorded only as other people reported them in the thread. They were not
  fetched.
- **REST issue comments are flat.** Their `parentId` is the opening. Discussions
  and PR review threads keep their true reply structure.
- **Not a gold set.** As with v2, these are development inputs. A close or merge
  event is evidence of an outcome, not a verified Chopin settlement.

## Reproducing

```bash
python3 -I evals/datasets/decisions-v1/tools/fetch.py <urls…>    # cached, idempotent
python3 -I evals/datasets/decisions-v1/tools/normalise.py
python3 -I evals/datasets/decisions-v1/tools/assemble.py          # needs .cache/decisions/ann/
python3 -I evals/datasets/decisions-v1/tools/package.py
python3 -I evals/datasets/decisions-v1/validate.py
python3 -I evals/datasets/decisions-v1/documents/fetch_docs.py   # cached
python3 -I evals/datasets/decisions-v1/documents/validate.py
python3 -I evals/datasets/decisions-v1/analysis/analyse_corpus.py
bun test evals/datasets                                           # structural checks, no cache needed
```

The annotation files in `.cache/decisions/ann/` are not committed. They contain
only paraphrases, but their content is already fully represented in `cases/`
and `decisions.jsonl`.
