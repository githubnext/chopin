import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { z } from "zod";

import type { Investigation } from "@chopin/experiment/records";
import type { BlockContent, ListItem, Nodes, PhrasingContent, Root, RootContent } from "mdast";

/** What a spike's local agent submits; the server turns it into the report and the callout. */
export const spikeSubmissionSchema = z.object({
	headline: z.string().trim().min(1).max(100),
	findings: z.array(z.string().trim().min(1).max(600)).min(1).max(6),
	recommendation: z.string().trim().min(1).max(1200),
	images: z.array(z.string().regex(/^\/images\/[0-9a-f]{64}\.(png|jpg|jpeg|webp|gif)$/)).max(3),
}).strict();
export type SpikeSubmission = z.infer<typeof spikeSubmissionSchema>;

/** Explicit uncertainty, used when Jev cannot judge a passage. */
const UNCERTAIN =
	/\b(unsure|not sure|uncertain|whether|open (question|decision)|need to (know|check|find out|test|confirm)|unclear|tbd|don't know|do not know|might not|risk(y)?)\b/i;

export function uncertain(text: string): boolean {
	return UNCERTAIN.test(text);
}

/** Plain text of an MDAST node. */
export function text(node: Nodes): string {
	if ("value" in node && typeof node.value === "string") return node.value;
	if ("children" in node) return (node.children as Nodes[]).map(text).join(" ");
	return "";
}

/** Prose a spike can start from: paragraphs, lists, quotes. Never headings or components. */
export function eligible(node: RootContent): boolean {
	if (!["paragraph", "list", "blockquote"].includes(node.type)) return false;
	return text(node).replace(/\s+/g, " ").trim().length >= 40;
}

export function spikeBrief(passage: string): string {
	let quoted = passage.trim().split("\n").map(line => `> ${line}`).join("\n");
	return [
		"Spike: build the smallest prototype or proof of concept that answers the open question "
		+ "in this passage. Spend at most about 15 minutes.",
		"",
		quoted,
		"",
		"You are on a throwaway branch in a disposable worktree. Do not push or open a pull request.",
		"Take 1-3 screenshots of the running prototype with Playwright at a 1280x800 viewport, "
		+ "saved as PNG files in this worktree, and upload each with upload_image_file({path}). "
		+ "Then call submit_spike_result with a headline of at most 8 words, at most 3 findings of "
		+ "one short sentence each, a one- or two-sentence recommendation that states the decision, "
		+ "and the uploaded image paths.",
	].join("\n");
}

function paragraph(...children: PhrasingContent[]): BlockContent {
	return { type: "paragraph", children };
}

/** Agents often over-escape quotes in tool arguments; prose never needs a backslash before one. */
function unescaped(value: string): string {
	return value.replace(/\\+(["'“”‘’])/g, "$1");
}

/** Canonical report MDX: bold headline, the recommendation first, findings, then screenshots. */
export function spikeReport(input: SpikeSubmission): string {
	let items: ListItem[] = input.findings.map(finding => ({
		type: "listItem",
		spread: false,
		children: [paragraph({ type: "text", value: unescaped(finding) })],
	}));
	let root: Root = {
		type: "root",
		children: [
			paragraph({ type: "strong", children: [{ type: "text", value: unescaped(input.headline) }] }),
			paragraph(
				{ type: "strong", children: [{ type: "text", value: "Recommendation:" }] },
				{ type: "text", value: ` ${unescaped(input.recommendation)}` },
			),
			{ type: "list", ordered: false, spread: false, children: items },
			...input.images.map((url, index) =>
				paragraph({ type: "image", url, alt: `Prototype screenshot ${index + 1}` })
			),
		],
	};
	return serialize(root);
}

/** Automatic re-dispatches of a spike whose local agent lost its connection. */
export const MAX_SPIKE_RETRIES = 2;

/**
 * Only a lost connection interrupts a spike; dismissal cancels it. An interrupted spike waits
 * for its owner's coding agent to reconnect, a bounded number of times.
 */
export function retryable(value: Investigation): boolean {
	return value.state === "interrupted" && !!value.spike && !value.spike.dismissed
		&& (value.spike.retries ?? 0) < MAX_SPIKE_RETRIES;
}

/** The callout state a spike's record implies; rewritten only when this changes. */
export function renderKey(value: Investigation): string {
	if (value.state === "completed") return "completed";
	if (retryable(value)) return "waiting";
	if (["failed", "interrupted", "cancelled"].includes(value.state)) return "stopped";
	// Spikes run one at a time per local agent; until one claims this run it is only waiting.
	if (value.state === "requested" || value.state === "queued") return "queued";
	return "running";
}

function callout(
	id: string,
	type: string,
	title: string,
	children: RootContent[],
	fold?: number,
): RootContent {
	return {
		type: "mdxJsxFlowElement",
		name: "Callout",
		attributes: [
			{ type: "mdxJsxAttribute", name: "id", value: id },
			{ type: "mdxJsxAttribute", name: "type", value: type },
			{ type: "mdxJsxAttribute", name: "title", value: title.slice(0, 100) },
			...(fold ? [{ type: "mdxJsxAttribute" as const, name: "fold", value: String(fold) }] : []),
		],
		children: children as BlockContent[],
	};
}

/** The Callout projected under a spike's passage for its current state. */
export function spikeCallout(value: Investigation): RootContent {
	let spike = value.spike;
	if (!spike) throw new Error("not a spike");
	let key = renderKey(value);
	if (key === "completed" && value.result) {
		let blocks = parse(value.result.report).children;
		let [first, ...rest] = blocks;
		let headline = first?.type === "paragraph" ? text(first).trim() : "";
		let body = headline ? rest : blocks;
		// Only the recommendation shows; findings and screenshots fold behind a disclosure.
		return callout(
			spike.callout,
			"tip",
			headline || "Prototype result",
			body,
			body.length > 1 ? 1 : undefined,
		);
	}
	if (key === "waiting") {
		return callout(spike.callout, "note", "Prototype paused", [
			paragraph({
				type: "text",
				value: `Waiting for @${spike.login}’s coding agent to reconnect. It will pick the `
					+ "prototype back up then. Delete this callout to cancel.",
			}),
		]);
	}
	if (key === "stopped") {
		return callout(spike.callout, "warning", "Prototype stopped", [
			paragraph({
				type: "text",
				// Interruption copy is written for investigations; a spike says what happened.
				value: value.state === "interrupted"
					? `@${spike.login}’s coding agent kept losing its connection, so this prototype `
						+ "stopped."
					: value.progress.trim() || "The coding agent stopped before reporting.",
			}),
		]);
	}
	if (key === "queued") {
		return callout(spike.callout, "note", "Prototype queued", [
			paragraph({
				type: "text",
				value: `@${spike.login}’s coding agent will prototype the passage above when it’s free. `
					+ "Delete this callout to cancel.",
			}),
		]);
	}
	return callout(spike.callout, "note", "Prototyping…", [
		paragraph({
			type: "text",
			value: `@${spike.login}’s coding agent is testing the passage above with a quick prototype. `
				+ "Delete this callout to stop it.",
		}),
	]);
}

/**
 * The Planner turn that settles a spike's passage once its result lands, so the document stops
 * asking a question its own callout answers. The callout stays as the evidence.
 */
export function resolveInstruction(value: Investigation): { text: string; said: string } {
	let spike = value.spike;
	if (!spike) throw new Error("not a spike");
	let quoted = spike.passage.trim().split("\n").map(line => `> ${line}`).join("\n");
	return {
		text: [
			"A quick prototype answered the open question in this passage:",
			"",
			quoted,
			"",
			`Its result is the tip Callout with id ${spike.callout} directly below the passage. `
			+ "Call read_plan, then rewrite only that passage so it states the decision the "
			+ "callout's recommendation supports, as settled prose of about the same length, with no "
			+ "remaining doubt about the question the prototype answered. Keep the callout where it "
			+ "is and do not edit it. If someone has already settled the passage, or it now says "
			+ "something the result does not answer, change nothing. Do not change anything else.",
		].join("\n"),
		said: "Updating the passage the prototype answered",
	};
}
