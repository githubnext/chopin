import { expect, spyOn, test } from "bun:test";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { ulid } from "@chopin/dialect/ulid";

import * as room from "../plan/room";
import { canonical } from "../mcp/create";
import { calloutDigest, callouts, reconcileCallout, withCallout } from "./spike-placement";
import { renderKey, resolveInstruction, spikeCallout, spikeReport, uncertain } from "./spikes";

import type { Investigation } from "@chopin/experiment/records";

const IMAGE = `/images/${"a".repeat(64)}.png`;

function spike(state: Investigation["state"], report?: string): Investigation {
	return {
		id: crypto.randomUUID(),
		documentId: crypto.randomUUID(),
		requester: "U_1",
		brief: "brief",
		revision: 1,
		state,
		generation: 1,
		expiresAt: 0,
		createdAt: 0,
		updatedAt: 0,
		progress: "",
		views: {},
		decisions: [],
		receipts: {},
		spike: {
			digest: "sha256:x",
			passage: "We are unsure whether drag handles work on touch.",
			callout: ulid(),
			login: "maggie",
			placed: true,
		},
		...(report
			? {
				result: {
					schemaVersion: 1 as const,
					report,
					datasets: [],
					views: [],
					evidence: [],
					provenance: { environment: "", checks: [], limitations: [] },
				},
			}
			: {}),
	};
}

test("a submitted spike renders as a titled callout with findings and screenshots", () => {
	let report = spikeReport({
		headline: "Drag handles work on touch with a 44px target",
		findings: ["Pointer events fire on iOS Safari.", "A <div> handle {needs} padding."],
		recommendation: "Keep drag handles; size them to 44px.",
		images: [IMAGE],
	});
	let checked = canonical(report);
	expect("source" in checked).toBe(true);
	let value = spike("completed", "source" in checked ? checked.source : report);
	expect(renderKey(value)).toBe("completed");
	let source = serialize({ type: "root", children: [spikeCallout(value)] });
	expect(source).toContain(`<Callout id="${value.spike!.callout}" type="tip"`);
	expect(source).toContain(`title="Drag handles work on touch with a 44px target" fold="1"`);
	expect(source).toContain("- Pointer events fire on iOS Safari.");
	expect(source).toContain("**Recommendation:** Keep drag handles");
	// The recommendation leads; the findings that support it follow.
	expect(source.indexOf("**Recommendation:**")).toBeLessThan(source.indexOf("- Pointer events"));
	expect(source).toContain(`![Prototype screenshot 1](${IMAGE})`);
	room.validate(source);
	let node = parse(source).children[0];
	expect(node.type === "mdxJsxFlowElement" && node.children.length).toBe(3);
});

test("running and stopped spikes render their own callouts without naming a machine", () => {
	let running = serialize({ type: "root", children: [spikeCallout(spike("running"))] });
	expect(running).toContain(`title="Prototyping…"`);
	expect(running).toContain("@maggie’s coding agent");
	room.validate(running);
	let stopped = spike("failed");
	stopped.progress = "Agent stopped: cancelled";
	let source = serialize({ type: "root", children: [spikeCallout(stopped)] });
	expect(source).toContain(`type="warning"`);
	expect(source).toContain("Agent stopped: cancelled");
	expect(renderKey(spike("running"))).toBe("running");
	expect(renderKey(spike("requested"))).toBe("queued");
	expect(renderKey(spike("queued"))).toBe("queued");
	let queued = serialize({ type: "root", children: [spikeCallout(spike("queued"))] });
	expect(queued).toContain(`title="Prototype queued"`);
	expect(queued).not.toContain("Prototyping");
	room.validate(queued);
	expect(renderKey(spike("interrupted"))).toBe("stopped");
});

test("a callout lands directly under its passage and is later replaced in place", async () => {
	let errors = spyOn(console, "error").mockImplementation(() => {});
	let passage = "We are unsure whether drag handles work on touch screens at all.";
	let document = await room.create(`# Plan\n\n${passage}\n\nAnother paragraph.\n`);
	try {
		let value = spike("running");
		let digest = room.digests(document)[1];
		let first = reconcileCallout(document, {
			callout: value.spike!.callout,
			node: spikeCallout(value),
			after: digest,
		});
		expect(typeof first).toBe("object");
		let source = room.project(document);
		let blocks = parse(source).children;
		expect(blocks.map(node => node.type)).toEqual([
			"heading",
			"paragraph",
			"mdxJsxFlowElement",
			"paragraph",
		]);
		expect(callouts(source).has(value.spike!.callout)).toBe(true);
		expect(
			reconcileCallout(document, { callout: value.spike!.callout, node: spikeCallout(value) }),
		).toBe("unchanged");
		let done = spike(
			"completed",
			spikeReport({
				headline: "It works",
				findings: ["Yes."],
				recommendation: "Ship.",
				images: [],
			}),
		);
		done.spike = value.spike;
		reconcileCallout(document, { callout: value.spike!.callout, node: spikeCallout(done) });
		let after = room.project(document);
		expect(after).toContain(`title="It works"`);
		expect(after).not.toContain("Prototyping");
		expect(parse(after).children).toHaveLength(4);
		expect(
			reconcileCallout(document, {
				callout: ulid(),
				node: spikeCallout(done),
				after: "sha256:none",
			}),
		).toBe("missing");
	} finally {
		document.doc.destroy();
		errors.mockRestore();
	}
});

test("an edited callout keeps its edits and the new state lands in a sibling after it", () => {
	let value = spike("running");
	let running = spikeCallout(value);
	let rendered = calloutDigest(running);
	let passage = parse("Passage that started the spike.\n").children[0];
	let edited = parse(
		serialize({ type: "root", children: [running] }).replace("quick prototype", "tiny prototype"),
	).children[0];
	let done = spike("failed");
	done.spike = value.spike;
	let untouched = withCallout([passage, running], {
		callout: value.spike!.callout,
		node: spikeCallout(done),
		rendered,
	});
	if (typeof untouched === "string") throw new Error("expected a replacement");
	expect(untouched.callout).toBe(value.spike!.callout);
	expect(untouched.children).toHaveLength(2);
	let kept = withCallout([passage, edited], {
		callout: value.spike!.callout,
		node: spikeCallout(done),
		rendered,
	});
	if (typeof kept === "string") throw new Error("expected a sibling");
	expect(kept.callout).not.toBe(value.spike!.callout);
	expect(kept.children).toHaveLength(3);
	let source = serialize({ type: "root", children: kept.children });
	expect(source).toContain("tiny prototype");
	expect(source).toContain(`<Callout id="${kept.callout}" type="warning"`);
	expect(source.indexOf("tiny prototype")).toBeLessThan(source.indexOf(kept.callout));
	room.validate(source);
});

test("explicit uncertainty is the fallback signal", () => {
	expect(uncertain("We need to know whether WebSockets survive the proxy.")).toBe(true);
	expect(uncertain("This is an open decision for the team.")).toBe(true);
	expect(uncertain("The page lists every document in the repository.")).toBe(false);
});

test("a one-block result does not fold, and a landed result names its passage and callout", () => {
	let value = spike(
		"completed",
		spikeReport({ headline: "It works", findings: ["Yes."], recommendation: "Ship.", images: [] }),
	);
	value.result!.report = "**It works**\n\n**Recommendation:** Ship.\n";
	let source = serialize({ type: "root", children: [spikeCallout(value)] });
	expect(source).not.toContain("fold=");
	let { text, said } = resolveInstruction(value);
	expect(text).toContain("> We are unsure whether drag handles work on touch.");
	expect(text).toContain(value.spike!.callout);
	expect(text).toContain("Keep the callout");
	expect(said).toBe("Updating the passage the prototype answered");
});

test("over-escaped quotes from an agent's tool call read as plain quotes", () => {
	let report = spikeReport({
		headline: 'Use \\"No notes yet\\"',
		findings: ["It\\'s clear."],
		recommendation: 'Show \\"No notes yet\\" in a card.',
		images: [],
	});
	expect(report).not.toContain("\\");
	expect(report).toContain('Show "No notes yet" in a card.');
});
