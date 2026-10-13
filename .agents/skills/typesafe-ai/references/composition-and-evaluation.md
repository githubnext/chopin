# Composing and evaluating Jev judgments

## Batch by shared evidence

Questions in one request see the same state and are evaluated independently. Batch
independent questions, including branch-specific questions whose premise can already
be stated. Code ignores irrelevant answers. A question about bug severity can say
“Assuming this describes a bug…” without waiting for the category answer. Another
request is justified when the first result determines new evidence or candidates.
See [fan-out](https://docs.typesafe.ai/patterns/fan-out) and
[parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions).

Batching questions over one state differs from processing unrelated documents. The
re-ranking cookbook evaluates one query–candidate pair per request, then runs those
requests concurrently. This keeps each relevance judgment focused on its own evidence.
See [re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe). Group only when
the question needs relationships among the items; measure concurrency and budgets.

Parallel evaluation does not establish statistically independent errors. Several
judgments can fail on the same misleading input. Treat a product of probabilities as
a modeling assumption requiring validation, not an automatic joint probability.

## Select and compose

For extraction, code finds candidate spans, Jev chooses the role-appropriate value,
and code copies and normalizes the source. Candidate recall bounds success: a missing
answer cannot be selected. Large pools may need retrieval or hierarchical shortlists.
Date parts can be selected and then resolved, compared, and validated in code. Read
[pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook),
[date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook), and
[hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification).

For preferences, normalize each Score by its highest level and combine weights in
code. Keep raw dimensions so weights can change without inference when evidence and
question meanings stay the same. Separate mandatory constraints from compensating
preferences. Weighted sums are policy scores, not calibrated probabilities of success.
See [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring).

For a large tool or skill catalogue, shortlist using compact descriptions, then
recheck actual fit against fuller definitions. Preserve a no-match path. A subject
mention is different from a request to perform an action. The
[skill-suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion) uses
ranking plus intent questions, then a second request for the shortlist. Shortlisting
adds a recall failure mode: measure whether the correct candidate survives.

To verify generated work, check separate claims against evidence and escalate
disagreements or uncertainty. Keep exact checks in code. See
[citation checking](https://docs.typesafe.ai/cookbooks/citation_check) and the
[extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade).

## Uncertainty is not correctness

Choice `confidence` is a normalized top probability; Score confidence additionally
accounts for distance between ordered levels. For three Choice options with
probabilities `(0.6, 0.3, 0.1)`, confidence is `0.4`, not `0.6`.
Noul returns no separate confidence. Neither confidence nor schema validity certifies
an action. Several acceptable options may produce a diffuse distribution even when
any choice would be harmless. Gate only answers the selected branch actually uses.
See the current [confidence definitions](https://docs.typesafe.ai/confidence).

Calibrated probabilities describe frequencies over comparable cases; calibration can
vary by task, input distribution, and version. Distinguish calibration from whether
uncertainty usefully ranks errors. Validate the assembled workflow too: thresholds and
composition can change the error profile. Independent evidence includes
[Deußer et al.](https://arxiv.org/abs/2609.37647) and
[the phishing comparison](https://github.com/anisselbd/jev-phishing-bench);
neither transfers its operating threshold to another application.

## Evaluate the policy people experience

Before deployment or a substantive prompt change, choose representative labelled
examples, including ambiguous, no-match, conflicting, misleading, and paraphrased
inputs. Include missing candidates and context-dependent cases where applicable.
Tune definitions and thresholds on development data; reserve held-out cases for the
decision to deploy. Compare with a simple baseline and the existing application.

Record the resolved model, question/policy version, exact evidence or a recoverable
reference, raw distributions, chosen action, timing, usage, and eventual outcome,
within the application's privacy constraints. Report:

- Errors and coverage at the proposed automation threshold, including false actions
  and missed useful actions; report important categories separately.
- Whether probabilities match observed outcomes, and whether gating concentrates
  errors in the review path. A useful ranker need not be perfectly calibrated.
- Final behavior, including fallback and review load, latency tails, service failures,
  stale results, and cost per successfully handled item.

Pin the model behind evaluated thresholds; log its resolved identity and re-evaluate
before changing it. Aliases can move. Check the current [model guidance](https://docs.typesafe.ai/models).
Cookbook cached outputs illustrate a run, not fresh proof of current performance.
Turn observed failures into retained regression cases. Evaluate meaningful paraphrases
and option-order changes when robustness affects the action.

## Agent economics and experimental ideas

Routing an entire growing conversation to a cheaper model and back may rebuild caches
and cost more. Measure full context reads, writes, hit rates, tool turns, fallbacks,
and quality. Tiny isolated judgments and bounded subtask briefs have different
economics from moving full agent history. See Diogo's
[cache essay](https://www.completeskeptic.com/p/kv-cache-rules-everything-around).

His [coding-agent notes](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg/edit)
suggest query-specific context selection, dynamic tool schemas, conditional guidance,
and read-only background analysis. These are speculative architecture ideas. Treat
them as hypotheses to prototype and measure; preserve user permissions and durable
application state. Jev supplies judgments, not text generation or an agent harness.
