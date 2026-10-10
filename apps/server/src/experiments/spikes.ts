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
		+ "Then call submit_spike_result with a one-line headline, 3-6 short findings, a "
		+ "recommendation, and the uploaded image paths.",
	].join("\n");
}

function paragraph(...children: PhrasingContent[]): BlockContent {
	return { type: "paragraph", children };
}

/** Canonical report MDX: bold headline, the recommendation first, findings, then screenshots. */
export function spikeReport(input: SpikeSubmission): string {
	let items: ListItem[] = input.findings.map(finding => ({
		type: "listItem",
		spread: false,
		children: [paragraph({ type: "text", value: finding })],
	}));
	let root: Root = {
		type: "root",
		children: [
			paragraph({ type: "strong", children: [{ type: "text", value: input.headline }] }),
			paragraph(
				{ type: "strong", children: [{ type: "text", value: "Recommendation:" }] },
				{ type: "text", value: ` ${input.recommendation}` },
			),
			{ type: "list", ordered: false, spread: false, children: items },
			...input.images.map((url, index) =>
				paragraph({ type: "image", url, alt: `Prototype screenshot ${index + 1}` })
			),
		],
	};
	return serialize(root);
}

/** The callout state a spike's record implies; rewritten only when this changes. */
export function renderKey(value: Investigation): string {
	if (value.state === "completed") return "completed";
	if (["failed", "interrupted", "cancelled"].includes(value.state)) return "stopped";
	// Spikes run one at a time per local agent; until one claims this run it is only waiting.
	if (value.state === "requested" || value.state === "queued") return "queued";
	return "running";
}

function callout(id: string, type: string, title: string, children: RootContent[]): RootContent {
	return {
		type: "mdxJsxFlowElement",
		name: "Callout",
		attributes: [
			{ type: "mdxJsxAttribute", name: "id", value: id },
			{ type: "mdxJsxAttribute", name: "type", value: type },
			{ type: "mdxJsxAttribute", name: "title", value: title.slice(0, 100) },
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
		return callout(spike.callout, "tip", headline || "Prototype result", headline ? rest : blocks);
	}
	if (key === "stopped") {
		return callout(spike.callout, "warning", "Prototype stopped", [
			paragraph({
				type: "text",
				value: value.progress.trim() || "The coding agent stopped before reporting.",
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
