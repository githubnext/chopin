/**
 * Accepted comment threads, in the prose.
 *
 * Nothing. The card belongs in the sidecar, and what marks the prose is the
 * passage the decision concerns — highlighted in the text itself — rather than
 * a block wedged in beside it. The node stays in the document so `plan.mdx`
 * carries the decision and the agent can read it back.
 */

import type { DecisionNode } from "@chopin/dialect";

export function renderDecision(_node: DecisionNode) {
	return null;
}
