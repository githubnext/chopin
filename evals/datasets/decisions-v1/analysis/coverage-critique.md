# Coverage critique, rerun on decisions-v1

This reruns the dataset pass from [critique-coverage-data.md](critique-coverage-data.md)
on the combined decisions-v1 corpus. It tests the hypotheses H1–H12 from
[critique-coverage-theory.md](critique-coverage-theory.md) §5 again and re-ranks
the gaps.

[`analyse_corpus.py`](analyse_corpus.py) produced every number below, and they
are all recorded in [`corpus-metrics.json`](corpus-metrics.json). Brackets are
Wilson 95% intervals.

| Stratum     |   n | What it is                                                                                                                                  |
| ----------- | --: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **All**     | 173 | 132 thread records plus 41 document records                                                                                                 |
| **Threads** | 132 | [`../decisions.jsonl`](../decisions.jsonl), refetched in full through the GitHub API                                                        |
| **Small**   |  11 | Thread records in the small-team quota                                                                                                      |
| Documents   |  41 | [`../documents/decisions.jsonl`](../documents/decisions.jsonl): ADRs, KEPs, TSC minutes, TC39 notes, PEPs and Rust texts, shown for context |

## Executive summary

- **Verdicts:**
  - **Supported:** H2, H5, H6, H7, H9, H10.
  - **Refuted:** H1, narrowly, and H3 on the options half.
  - **Inconclusive:** H8 in substance and H11.
  - **Untestable:** H4.
  - **Partly supported:** H12. Its vote half holds; its single-decider half is
    supported only through the small-team proxy.

  Compared with v0, H1 moves from inconclusive to refuted and H11 from refuted to
  inconclusive. Everything else keeps its verdict.
- **The end state is still the main gap, now with less noise.** Across all records:
  - 61% [54–68] end in a composite answer: two or more options chosen, or one
    adopted only in part.
  - 50% [43–58] leave follow-up structure behind: child questions, "accepted in
    principle", or obligations.
  - 24% [18–31] are parked or idle without a verdict.

  The small-team stratum shows the same pattern, more strongly for the first: 73%,
  46% and 36%. The design has one answer and an Open/Settled binary.
- **"Decided elsewhere" is now the second most common gap: 53% [45–60].** In v0 it
  ranked fifth, at 45%. Most of it is a meeting, call or chat, or a PR review that
  decided while the thread waited, followed by what got built drifting from what
  was agreed. In the small-team stratum it falls to 27%: solo maintainers decide
  in the thread.
- **Crowd signal is real, not a fetch artefact.** v0 couldn't separate it from
  webfetch summaries: 95% of its hits were non-git. On fully fetched threads it is
  36% [28–44], and 2% in documents. It is a product-thread pattern.
- **Shapes: keep four, and add no fifth.**
  - Choice is 72% of records; tune 4%; mixed or none 9%.
  - 82% of records carry a secondary shape, so mixing is coded as primary +
    secondary.
  - Check is primary in 7% of records, but primary or secondary in 32%.
- **For a solo builder, the small stratum points at a different order.** The top
  gaps there are:
  - composite answers (73%)
  - follow-ups (46%)
  - supersede or revert (46%)
  - parked (36%)

  Delegation (0%), consensus mechanics (0%) and votes (0%) are absent. But the
  stratum is only 11 records, with a median of 17 participants and 1,187 days per
  decision. These are solo _maintainers_ fielding many users, not small groups.

## 1. Method and biases

**Records.** The 41 document records are the cloud session's v0 records that were
read from complete files (`git-file`). They are converted unchanged in substance,
and their provenance is in the [README](../README.md#document-records). Two
phrases that repeated eight or more words of their source were reworded.

**Gap tags.** v0's hypotheses count gaps through a controlled tag vocabulary: one
tag per gap, from the theory pass §6 plus v0's additions. Document gaps keep the
v0 coder's tag. The 538 thread gaps had been named freely by their annotators, so
they were coded afterwards into the same vocabulary by two coders, one per half,
using a written brief with one calibration example per tag. The tags are in
[`thread-gap-tags.json`](thread-gap-tags.json).

**Reliability.** A third coder blind-recoded 60 randomly sampled document gaps,
using a calibration set that excluded them. Agreement with the v0 coder was 70%,
Cohen's κ = 0.68 across 29 categories (chance agreement 0.07), which is
substantial. The disagreements are scattered single confusions, such as
provisional→conditional and blocking→delegate, not a systematic drift. The data
is in [`tag-reliability.json`](tag-reliability.json).

| Bias                                           | Evidence                                                                                                                                                                                                                                                                                                              | Handling                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Genre effect on some tags                      | `consequences` 37% in documents vs 4% in threads; `rejected-content` 24% vs 2%; `convention` 22% vs 2%. The blind recode reproduced these tags at the v0 coder's rate, so this isn't coder drift. ADRs and PEPs have Consequences and Rejected Alternatives sections; thread annotators rarely wrote gaps about them. | Reported per stratum. Read thread rates for these tags as lower bounds.                                              |
| Thread coders saw the annotator's cluster name | Each thread gap begins with its annotator's free cluster name; the document recode had no prefix.                                                                                                                                                                                                                     | The blind recode measures the coding, not the hint. The hint can only pull thread tags towards the annotator's view. |
| Small-team ≠ small group                       | Small: median 17 participants, median 1,187 days, 9/11 with a single named decider. `participants.count` counts every human commenter, so only 3 records in the whole corpus have ≤3 participants.                                                                                                                    | The small stratum stands in for the persona. H12's ≤3 test is untestable.                                            |
| Debated-only selection                         | Every thread was screened for a genuine debate. The PR-debate quota is PR-review threads by construction.                                                                                                                                                                                                             | Direction, not size. H11 is reported per stratum.                                                                    |
| Saturated fields                               | `process.subQuestions` non-empty in 99%; `criteria` non-empty in 100% of choice records.                                                                                                                                                                                                                              | Neither is used as a signal. H6 uses tags; H3's criteria half is untestable.                                         |
| Inconsistent coding                            | `confidence: stated` is 73% in threads vs 45% in documents. Neither annotation guide defined "stated".                                                                                                                                                                                                                | H8's confidence half isn't used for the verdict.                                                                     |
| Option order                                   | Neither guide asked for options in proposal order.                                                                                                                                                                                                                                                                    | H4 is untestable.                                                                                                    |
| Defaulted field                                | v0 had no `decidedOffPlatform`, so document records default to `false`.                                                                                                                                                                                                                                               | Not used. "Decided elsewhere" is measured through the `venue-split` tag instead.                                     |
| One annotator per record                       | Shapes and outcomes were coded once. v0's shape κ was 0.62 on its own sample; it wasn't re-estimated for threads.                                                                                                                                                                                                     | Shape-based results carry moderate confidence.                                                                       |

## 2. Hypotheses

The thresholds come from theory §5. "Small" has n = 11, so its intervals are wide.

| H   | Prediction                                                                  | All                                                                | Threads         | Small                                    | Verdict                                                                    | Conf.               | v0                 |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------- | ---------------------------------------- | -------------------------------------------------------------------------- | ------------------- | ------------------ |
| H1  | mixed or none ≥15%; falsified <10%                                          | 16/173 **9%** [6–14]                                               | 8% [5–14]       | 0/11 [0–26]                              | **REFUTED** (narrowly)                                                     | Low                 | Inconclusive (11%) |
| H2  | choice modal; tune ≤10%                                                     | choice **72%**, tune **4%** [2–8]                                  | 70% / 5%        | 73% / 9%                                 | **SUPPORTED**                                                              | High for the corpus | Supported          |
| H3  | median options ≤3; criteria ≤50%                                            | median **5**; criteria 100%                                        | median 6        | median 5.5                               | **REFUTED** (options); criteria untestable                                 | Moderate            | Refuted            |
| H4  | options[0] wins ≥60%                                                        | 57/148 **38%** [31–46]                                             | 36%             | 5/10                                     | **UNTESTABLE**                                                             | —                   | Untestable         |
| H5  | parked ≥15%; deferred ≥ abandoned                                           | **24%** [18–31]; 23 deferred vs 3 abandoned                        | 23%; 13 vs 3    | 36%; 0 vs 0                              | **SUPPORTED**                                                              | Moderate            | Supported          |
| H6  | structure ≥20%; rfc or proposal ≥40%                                        | **65%** [58–72]; rfc or proposal **84%** [67–93]                   | 61%; 82%        | 46%; n/a                                 | **SUPPORTED**                                                              | High for direction  | Supported          |
| H7  | non-check uses research or a spike ≥30%                                     | strict **70%** [62–76]; without implementation PRs **35%** [28–42] | 79%; 35%        | 90%; 40%                                 | **SUPPORTED**                                                              | Moderate            | Supported          |
| H8  | reversibility stated ≥25%; confidence ≤15%                                  | reversibility **40%** [33–49]; confidence **67%** [59–74]          | 44% / 73%       | 20% / 50%                                | **REFUTED as specified; inconclusive in substance**                        | Low                 | Inconclusive       |
| H9  | dissent survives ≥25% (decided, ≥3 participants)                            | 116/132 **88%** [81–92]                                            | 89%             | 6/10 **60%** [31–83]                     | **SUPPORTED**                                                              | Moderate            | Supported          |
| H10 | reopened or superseded ≥10%; ≥30% of those tagged                           | **29%** [23–36]; **70%** of those                                  | 26%; 74%        | 46%; 5/5                                 | **SUPPORTED**                                                              | Moderate            | Supported          |
| H11 | PR source ∧ implementation PR ≥20%                                          | 29/173 **17%** [12–23]                                             | **22%** [16–30] | 1/11 **9%**                              | **INCONCLUSIVE**                                                           | Low                 | Refuted (0/82)     |
| H12 | ≤3 participants: single decider ≥75%; votes or polls ≤10% outside standards | ≤3: n = 3 (2/3); votes or polls **10%** [6–15] (non-formal 7%)     | 3 (2/3); 8%     | single decider **82%** [52–95]; votes 0% | **Votes half SUPPORTED; ≤3 half untestable, supported by the small proxy** | Moderate            | Inconclusive       |

Notes on each hypothesis:

- **H1.** The point estimate is under the 10% falsification line, but the interval
  reaches 14%, so this is a narrow refutation. 82% of records carry a secondary
  shape. Every mixed record is a bundle of coupled sub-choices: a
  parent-and-children structure problem, as v0 found.
- **H2.** Tune is 13% [6–24] of UI and product records as a primary shape, and 44%
  [32–58] as primary or secondary. Documents contain no tune records.
- **H3.** Public debate piles up variants: threads have a median of 6 options. In
  55% [46–63] of choice records more than one option is chosen or one is adopted in
  part, and 56% list at least one option deferred.
- **H4.** Point estimates would refute it, but option order is not chronological.
- **H5.** The raw `deferred` flag (38%) overstates it, because 43 decided records
  deferred only part of the question. The test uses undecided ∧ deferred, or a
  `deferred` or `stale-idle` tag. Small's 36% comes entirely from tags: stale and
  idle threads.
- **H6.** `follow_up_structure` (nested, staged or consequences tags) is 50% [43–58]
  for all records, 45% for threads, 46% for small and 68% for documents.
- **H7.** Thread spikes are dominated by `implementation-pr` (59 of 121), so the
  second figure excludes it. It still clears 30% in every stratum, but its interval
  dips below. Spike mix across all records: implementation PR 64, none 53, prototype
  35, feature flag 5, experiment 4.
- **H8.** Confidence is coded as "the decision was stated firmly", not as a
  calibrated confidence. Reversibility is stated in 40% of records, which is the
  part the design can use.
- **H9.** Debated-only selection inflates dissent. The direction is safe, and in the
  small stratum dissent still survives in 6 of 10 decisions.
- **H10.** The collection sought reversals, so the size is inflated, but small
  maintainers revisit most often.
- **H11.** Threads pass only because PR-review debates were a quota. Documents have
  0/41 and small has 1/11. An implementation PR from any source appears in 41%
  [34–48] of all records. This still doesn't bear on G3, which concerns undebated
  agent calls.
- **H12.** Single named decider: 33% of all records, 41% of threads, 7% of
  documents. Team or consensus decides 51% of all records.

## 3. Gaps re-ranked

The share is the proportion of records with at least one gap in the group. Groups
follow theory §3 (G-ids) and v0's added groups (N, P, C). Examples are decision
IDs. "Formal" is the share of hits from formal processes: Rust, Go and Python
proposals, TC39 and thread cases in the formal-process quota.

| #  | Gap (tags)                                                         | All             | Threads         | Small           | Documents | Formal share | Examples                                                                                           | Solo builder?                                                                              |
| -- | ------------------------------------------------------------------ | --------------- | --------------- | --------------- | --------- | ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1  | **Composite answer** (≥2 chosen or partly/merged)                  | **61%** [54–68] | 63% [54–71]     | **73%** [43–90] | 56%       | 24%          | `bat-builtin-pager-approach`, `delta-light-dark-detection`, `fzf-preview-window`                   | **Yes**                                                                                    |
| 2  | **Decided elsewhere** (`venue-split`, `implicit`, `ratify`)        | **53%** [45–60] | 55% [47–64]     | 27% [10–57]     | 44%       | 29%          | `bat-builtin-pager-approach`, `fzf-default-opts-file`, `vite-node-worker-api`                      | **Partly.** For a solo builder it's Chat, an agent in code, or another document.           |
| 3  | **Follow-ups** (`nested`, `staged`, `consequences`)                | **50%** [43–58] | 45% [36–53]     | 46% [21–72]     | 68%       | 38%          | `delta-light-dark-detection`, `fzf-default-opts-file`, `rfcs-derive-from-direction`                | **Yes**                                                                                    |
| 4  | **Coupled / blocking** (`coupled`, `blocking`)                     | **38%** [31–46] | 39% [32–48]     | 18% [5–48]      | 34%       | 30%          | `just-f-string-syntax`, `ripgrep-long-line-handling`, `go-loopvar-per-iteration`                   | Yes, but #3 covers the parent/child cases                                                  |
| 5  | **Supersede / revert** (`supersede`, `revert`)                     | **32%** [25–39] | 33% [25–41]     | **46%** [21–72] | 29%       | 29%          | `ripgrep-hyperlink-support`, `pnpm-pre-post-scripts`, `zoxide-fish-cd-call`                        | **Yes**, once code has shipped on the old answer                                           |
| 6  | **Delegate / approve** (`delegate`, `approve`)                     | 32% [26–40]     | 33% [26–42]     | **0%** [0–26]   | 29%       | 39%          | `vite-eager-browserhash-merge`, `deno-config-permissions`                                          | **Teams only**                                                                             |
| 7  | **Evidence beyond check** (`evidence-not-check`)                   | 28% [22–36]     | 30% [23–39]     | 27% [10–57]     | 22%       | 20%          | `just-parallel-mechanism`, `go-loopvar-per-iteration`, `excalidraw-binding-default`                | **Yes**                                                                                    |
| 8  | **Crowd signal** (`crowd-signal`)                                  | 28% [22–35]     | **36%** [28–44] | 27% [10–57]     | 2%        | 12%          | `pnpm-pm-strict-default`, `just-telemetry-mechanism`, `go-try-builtin`                             | **Partly:** builders with users                                                            |
| 9  | **Parked / idle** (`deferred`, `stale-idle`, undecided ∧ deferred) | 24% [18–31]     | 23% [16–31]     | **36%** [15–65] | 29%       | 26%          | `just-parallel-mechanism`, `delta-light-dark-detection`, `home-assistant-last-changed-persistence` | **Yes**                                                                                    |
| 10 | Team settle / open objection (`consensus-mechanics`)               | 18% [13–25]     | 12%             | 0%              | 39%       | **66%**      | `crystal-io-first`, `eslint-native-ts-config-flag`                                                 | Teams only                                                                                 |
| 11 | Provisional / conditional (`provisional`, `conditional`)           | 14% [10–20]     | 8%              | 9%              | 34%       | 33%          | `bat-debian-batcat-name`, `eslint-native-ts-config-flag`, backstage ADR014                         | Yes; thread rate is a lower bound (genre)                                                  |
| 12 | Reframe (`reframe`)                                                | 12% [8–17]      | 11%             | 9%              | 15%       | 35%          | `go-try-builtin`, `excalidraw-handwritten-font`                                                    | Yes, when research disproves the premise                                                   |
| 12 | Consequences, as a tag                                             | 12% [8–17]      | 4%              | 9%              | 37%       | 20%          | ADR records                                                                                        | Yes; genre effect                                                                          |
| 14 | External authority (`external-authority`)                          | 10% [6–15]      | 6%              | 18%             | 22%       | 24%          | `ripgrep-hyperlink-support`, `bat-debian-batcat-name`                                              | Yes                                                                                        |
| 15 | Rejected-option content (`rejected-content`)                       | 8% [4–12]       | 2%              | 0%              | 24%       | 54%          | PEP and ADR records                                                                                | Partly; genre effect                                                                       |
| 16 | Convention / scope (`convention`)                                  | 7% [4–12]       | 2%              | 0%              | 22%       | 42%          | `prettier-final-newline`, MoJ ADR019                                                               | Yes for agents; the corpus can't measure it                                                |
| 17 | Rank / partition (`rank`, `partition`)                             | 6% [3–10]       | 6%              | **18%**         | 5%        | 50%          | `fzf-preview-window`, `delta-light-dark-detection`                                                 | Partly; covered by #1                                                                      |
| 17 | Formal vote (`vote`)                                               | 6% [3–10]       | 2%              | 0%              | 17%       | 70%          | `node-yarn-vs-corepack`, PEP 8016                                                                  | No                                                                                         |
| 19 | Visual comparison                                                  | 3% [1–7]        | 3%              | 9%              | 2%        | 20%          | `excalidraw-handwritten-font`                                                                      | Partly: UI work                                                                            |
| 20 | Moot, deadline, hidden history                                     | 2% each         | ≤2%             | 0%              | ≤7%       | —            | —                                                                                                  | Rare. Hidden history falls from v0's 12% to 2%, which confirms it was a webfetch artefact. |

**What changed from v0's ranking:**

- Decided elsewhere rises from #5 to #2.
- Supersede/revert rises from #8 to #5, and to joint #2 in the small stratum.
- Crowd signal becomes credible.
- Delegate/approve and consensus mechanics are confirmed as team gaps, absent from
  the small stratum.
- Provisional/conditional falls from #7 to #11 overall. It stays high in documents,
  where ADRs and PEPs state revisit conditions.

## 4. What to do

This follows v0's three-way split, updated with the new evidence.

**(a) Make now.** The evidence is strong and holds in the small stratum.

1. **Each choice row takes a fate:** chosen, partly, later or not this. The settled
   sentence is composed from the chosen and partly rows. Composite answers are #1
   overall and 73% of small.
2. **Follow-ups on Settle, and "settled in principle":** child questions linked to
   the parent, plus stated obligations (#3).
3. **Record a decision made elsewhere,** with a source link and captured evidence
   (#2). For a solo builder this is the decision taken in Chat or by an agent in
   code.
4. **Reopen keeps the old answer as Superseded,** and Built into shows revert PRs
   (#5).
5. **A Parked state with a revisit trigger** (#9, 36% of small).
6. **Research and Spike on every shape,** per option on choice (#7).

**(b) Design for, but defer:**

- coupled and blocking links (#4)
- user-signal evidence, meaning reaction counts as evidence rather than a vote (#8)
- a "Driven by" field for outside authority (#14)
- reframe history (#12)
- convention scope (#16)
- image options (#19)

**(c) Out of scope for this persona:**

- votes and tallies
- unanimity and objection mechanics
- delegation rosters

None appears in the small stratum, and 66–70% of their hits are formal processes.

## 5. What this corpus still can't tell us

- **G1 (ratify) and G3 (undebated agent calls).** Every record was selected for
  debate.
- **A small _group_.** The small stratum is solo maintainers with many users. The
  persona needs Chopin's own planning sessions, or private repos.
- **Proposal order and calibrated confidence (H4, H8).** Both need an annotation
  rule before the next collection.
- **Shape reliability on threads.** A double-coded sample, as v0 did for its
  records, would settle H1's narrow margin.
