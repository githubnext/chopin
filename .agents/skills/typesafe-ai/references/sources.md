# Jev research sources

Research checked **13 October 2026**. This is a public-source catalogue, not a claim
to have recovered every social reply, private Discord discussion, or recording.
Technical guidance comes from current TypeSafe docs; Diogo's talks explain design
intent. Community measurements describe their own workloads, not guarantees.
This package combines TypeSafe guidance with sourced research.

## Start with these

1. [Latent Space interview](https://www.latent.space/p/jev), especially 00:58:28–01:10:28.
2. [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
   and [Confidence](https://docs.typesafe.ai/confidence).
3. [Public coding-agent notes](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg/edit)
   and [the cache essay](https://www.completeskeptic.com/p/kv-cache-rules-everything-around)
   if working on agent architecture.
4. The closest [official cookbook](https://docs.typesafe.ai/cookbooks), then evaluate
   the resulting behavior on the application's own examples.

## Diogo's writing

| Source                                                                                                                               | Date                    | Relevance and access                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)                                | 15 Sep 2026             | Read. Programming model, workflow examples, and caveats behind the launch claims.                                                                                                         |
| [(KV) Cache Rules Everything Around Me](https://www.completeskeptic.com/p/kv-cache-rules-everything-around)                          | 9 Sep 2026              | Read. Context rereads, tool turns, cache hit rates, and model-switching economics.                                                                                                        |
| [The Bitterest Lesson](https://www.completeskeptic.com/p/the-bitterest-lesson)                                                       | 10 Sep 2026             | Read. Choose the task and evidence before optimizing the model. [Company mirror](https://typesafe.ai/blog/bitterest-lesson).                                                              |
| [Lies, Damned Lies, and Benchmarks](https://www.completeskeptic.com/p/lies-damned-lies-and-benchmarks)                               | 11 Sep 2026             | Read. Private evaluations and transparent caveats. [Company mirror](https://typesafe.ai/blog/antibenchmaxxing).                                                                           |
| [[public] thoughts on a typesafe coding agent](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg/edit) | Undated living document | Read through public text export. Explicit state, context relevance, tool discovery, conditional guidance, and background tasks. Speculative notes, not a shipped harness or API contract. |

The [personal archive](https://www.completeskeptic.com/archive) also lists _Scaling
Laws, Honestly_ and _Is it even possible for the Chinese Labs to distill US models?_
These are adjacent research arguments, not instructions for using Jev; no operational
rules were derived from them. The [company blog](https://typesafe.ai/blog) adds news,
a customer case study, and links to the talks below. Mirrors count as one work.

## Diogo's podcasts and talks

| Appearance                                                                                                                                     | Date            | What was accessible                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Jev: System One models for Prod, not God — Latent Space](https://www.latent.space/p/jev)                                                      | 21 Sep 2026     | Primary show notes and relevant transcript sections reviewed. Most useful detailed explanation of question design. Runtime 2:20:52.                                                                                  |
| [AI Can Write Code. Why Isn't Software Better? — a16z](https://a16z.com/podcast/ai-can-write-code-why-isnt-software-better/)                   | 28 Sep 2026     | Primary episode description; [transcript mirror](https://podscripts.co/podcasts/a16z-podcast/ai-can-write-code-why-isnt-software-better) consulted. Embedded intelligence and reliability. Runtime about 43 minutes. |
| [Why Jev Is Changing How We Build With AI — TWIML #779](https://twimlai.com/podcast/twimlai/jev-changing-how-we-build-ai)                      | 6 Oct 2026      | Primary show notes and resource links reviewed. Recording linked; a full readable transcript was not recovered. Covers calibration and model/code/harness boundaries.                                                |
| [What's next after RLHF? — AI Engineer](https://www.youtube.com/watch?v=cJ0EOzey--o)                                                           | Prelaunch, 2026 | Recording linked by Latent Space; contextual accounts found. Recording transcript not independently recovered. Automation thesis, not current product instructions.                                                  |
| [AI: too good to be true, too bad to be useful — AI Council](https://typesafe.ai/blog/ai-too-good-to-be-true-too-bad-to-be-useful-typesafe-ai) | Prelaunch, 2026 | Company page contains a [video embed](https://www.youtube.com/watch?v=o-y1HJ6buGQ), not an essay. Transcript not recovered.                                                                                          |
| [Diogo Almeida — Founders You Should Know](https://typesafe.ai/blog/diogo-almeida---founders-you-should-know)                                  | Prelaunch, 2026 | Company page links the [recording](https://www.youtube.com/watch?v=LE3bGTaAgOE). Transcript not recovered.                                                                                                           |
| [What's Next After RLHF? — Data + AI Summit session](https://www.databricks.com/dataaisummit/session/whats-next-after-rlhf)                    | Date uncertain  | Session abstract located. Live site mixes a 2027 banner with 2026 speaker information; not treated as a verified recording date or separate new technical source.                                                    |

### Latent Space listening guide

Timestamps refer to the episode's transcript. This table indexes sections; the
practical references use current docs for detailed implementation advice.

| Time               | Topic                                                |
| ------------------ | ---------------------------------------------------- |
| 00:17:21           | Public benchmarks and private evaluations            |
| 00:39:55           | Reliability, robustness, and determinism             |
| 00:48:11           | Model versioning and long-term support caveats       |
| 00:54:04–00:58:28  | Primitives and how they map to code                  |
| 01:03:57           | Decompose to the “smallest semantic unit”            |
| 01:04:13           | Structured instructions and explicit references      |
| 01:04:47–01:06:41  | Separate conditions; thresholds and regression cases |
| 01:07:11–01:10:28  | Calibration limitations and fine-tuning discussion   |
| 01:33:21           | Computer use and unstructured data                   |
| 01:38:48; 02:08:00 | Coding-agent architecture and cache constraints      |

### Social posts and unresolved trails

- [Launch thread, @CompleteSkeptic](https://x.com/CompleteSkeptic/status/2099925682726002904):
  found in public indices. Direct X retrieval failed; use the readable launch article
  for claims rather than attributing unseen replies.
- [Cache discussion, @CompleteSkeptic](https://x.com/CompleteSkeptic/status/2097738214589215173):
  linked by Latent Space; direct retrieval failed. The full essay is readable above.
- Launch follow-ups: [Doom](https://x.com/CompleteSkeptic/status/2099925687465570372)
  and [Wikipedia racing](https://x.com/CompleteSkeptic/status/2099925688925184171).
  Found in the public resource index; direct retrieval failed. Both demos are described
  with caveats in Diogo's readable launch article.
- [Diogo's X profile](https://x.com/CompleteSkeptic) and
  [LinkedIn profile](https://www.linkedin.com/in/diogomda) are discovery routes, not
  fully audited timelines. Search did not establish complete reply coverage.
- [Attunex's appearance index](https://attunex.app/p/diogo-almeida) reports a TBPN
  appearance around 22 September. An original matching segment was not verified;
  no advice is attributed to it here. Older ML appearances predate Jev.
- Private Discord AMAs, paywalled portions, and videos without accessible transcripts
  remain coverage gaps. Podcast mirrors and AI-generated recaps were deduplicated.

## TypeSafe team and other builders

| Source                                                                                                                                           | Why it helps                                                                                                   | Evidence limits                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Allie Laabs on ThursdAI, 17 Sep](https://thursdai.news/ep/sep-17-2026)                                                                          | Team explanation at 1:38:48; primitive discussion at 1:53:43. Compound questions are a common support problem. | Show transcript and notes reviewed; distinct from a Diogo appearance.                                                                                     |
| [Ryan Vogel's email-triage test](https://news.ryan.ceo/jev-ai-built-to-make-decisions/)                                                          | Several independent fields per email, consumed by an ordinary workflow.                                        | Builder's own demo; latency and cost depend on the payload and run.                                                                                       |
| [Greg Isenberg and Ryan Vogel — Jev is HERE](https://www.linkedin.com/pulse/jev-here-how-use-startup-ideas-podcast-razcc)                        | Inbox triage and queue-based product ideas. [Recording](https://www.youtube.com/watch?v=4mTLpuQpB80).          | Show's own article reviewed. Its action checklist appears to reverse high/low-confidence routing; follow current docs. Diogo is mentioned, not the guest. |
| [Mike Taylor — Mini-Vibe Check, Every](https://every.to/vibe-check/mini-vibe-check-typesafe-s-jev-judged-everything-i-ve-written-in-0-7-seconds) | Many writing checks; includes reported comments from Diogo.                                                    | Readable test account reviewed. Demo speed is not an accuracy evaluation; the follow-up checker missed a planted defect.                                  |
| [Alex Duffy — Verification is the bottleneck](https://goodstartlabs.com/research/verification-is-the-bottleneck)                                 | Judge intermediate steps against rubrics, not just final answers; inspect disagreements.                       | Original methods reviewed. Agreement with another model is not ground-truth accuracy.                                                                     |
| [Tobias Deußer, Lorenz Sparrenberg, Rafet Sifa — evaluation paper](https://arxiv.org/abs/2609.37647)                                             | Zero-shot evaluations across 37 datasets; threshold placement and selective prediction.                        | Abstract reviewed; independent preprint, model/workload-specific results.                                                                                 |
| [Running-Dolphins/jev-bench](https://github.com/Running-Dolphins/jev-bench)                                                                      | Per-task calibration, no-match, options, language, and repeated-input tests.                                   | Original README/methods reviewed; one reported run on public datasets.                                                                                    |
| [AbdelStark/jev-benchmarks](https://github.com/AbdelStark/jev-benchmarks)                                                                        | Reproducible calibration and selective-risk harness.                                                           | Original repository reviewed; a community pilot, not the TypeSafe API contract.                                                                           |
| [anisselbd/jev-phishing-bench](https://github.com/anisselbd/jev-phishing-bench)                                                                  | Paired comparison, alternative verdict questions, calibration and automation curves.                           | Original methods reviewed; synthetic email benchmark and fixed model/prompt settings.                                                                     |
| [Nish Bhana — Jev and System One Models](https://nishbhana.com/Jev-System-One-Models/)                                                           | Useful synthesis and links to original evidence.                                                               | Commentary, not independent verification of every linked result.                                                                                          |
| [Anil Matcha's use-case playbook](https://github.com/Anil-matcha/awesome-jev-by-typesafe/blob/main/docs/jev-use-case-playbook.md)                | Additional implementation shapes and source links.                                                             | Community synthesis; check its linked originals and live docs.                                                                                            |

## Official implementation sources

The authors of individual docs pages are not identified as Diogo; attribute these
to **TypeSafe**, not personally to him. Pages change independently of this catalogue.

| Branch                     | Read                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input and question design  | [State](https://docs.typesafe.ai/concepts/state), [building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one), [advanced structure](https://docs.typesafe.ai/primitives/advanced)                                      |
| Output meaning             | [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score), [Confidence](https://docs.typesafe.ai/confidence)                               |
| Shared state and branching | [Fan-out](https://docs.typesafe.ai/patterns/fan-out), [parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions)                                                                                                           |
| Reusable dimensions        | [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring), [feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)                                                                            |
| Candidate selection        | [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook), [skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) |
| Verification               | [Extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade), [guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails)                                                                                                       |
| Integration boundary       | [API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models), [coding agents](https://docs.typesafe.ai/introduction/coding-agents)                                                                                        |

These pages were accessed during the research; SDK details and other cookbooks should
be fetched when the task needs them. Useful additional routes include
[function calling](https://docs.typesafe.ai/cookbooks/function_calling),
[structure recovery](https://docs.typesafe.ai/cookbooks/autoformat),
[entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment),
[semantic find](https://docs.typesafe.ai/cookbooks/semantic_find), and
[the customer case study](https://typesafe.ai/blog/jack-jill-jev-case-study).

## Keep attribution and claims precise

- Schema validity and decision accuracy are separate. Interpret launch claims about
  hallucination in the constrained-output sense, not as infallibility.
- Current confidence formulas are public. Older guides calling the formula
  unpublished are stale; a confidence value is distinct from a selected probability.
- Independent question evaluation means answers do not condition on each other;
  it does not prove errors are independent or make composed scores calibrated.
- Pinning a model is useful for evaluation; it does not establish perpetual vendor
  support. Recheck current availability and version policy.
- Real task evaluations remain necessary. Headline speed/cost ratios, cached cookbook
  runs, and agreement with reference LLMs are different kinds of evidence.

Search covered TypeSafe's docs/blog, Diogo's public archive, indexed social posts,
podcast/talk listings, original builder accounts, GitHub, and arXiv. Discovery aids
included [Awesome Jev](https://github.com/Li-Evan/awesome-jev),
[Jev 101's talks index](https://jev.page/talks/), and podcast indices. These are
community directories; their summaries were not treated as primary technical evidence.
The index's full scenario data was also searched for Diogo/@CompleteSkeptic entries;
this added the two launch-demo links above, rather than additional verified guidance.
