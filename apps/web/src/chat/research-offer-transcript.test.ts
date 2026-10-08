import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "./transcript";
import { researchTranscript } from "./research-transcript";
import type { ConversationPlan } from "@chopin/protocol";
import type { ResearchRequestStore } from "../research-requests";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, apps/web/src/chat/research-offer.test.ts.
// Whole original source-placement and viewer-authority callback.
test("the exact public brief appears under its source message and viewer controls stay absent", () => {
	let brief = "Research VPS costs <without> assuming a provider.";
	let state: ConversationPlan.State = {
		schemaVersion: 1,
		revision: 1,
		events: [],
		threads: [],
		queue: [],
		analysis: [],
		researchOffers: [{
			id: "offer-1",
			needId: "need-1",
			contextId: "context-1",
			brief,
			status: "offered",
			source: {
				messageId: "source-2",
				author: { kind: "member", handle: "ana" },
				quote: "Compare VPS costs",
				start: 0,
				end: 17,
			},
		}],
	};
	let render = (canAct: boolean) =>
		renderToStaticMarkup(createElement(Transcript, {
			active: true,
			entries: [
				{ id: "source-1", author: { kind: "member", handle: "ana" }, text: "Earlier", ts: 1 },
				{
					id: "source-2",
					author: { kind: "member", handle: "ana" },
					text: "Compare VPS costs",
					ts: 2,
				},
			],
			handle: "ana",
			onWithdraw: () => {},
			queued: [],
			conversationPlan: state,
			researchOffers: {
				links: {},
				busy: new Set<string>(),
				errors: {},
				canAct,
				canCheckLink: true,
				store: {} as ResearchRequestStore,
				onAction: () => {},
				onRetryLink: () => {},
			},
		}));
	let writer = render(true);
	let source = writer.indexOf('data-chat-message-id="source-2"');
	let offer = writer.indexOf('data-research-offer="offer-1"');
	expect(source).toBeGreaterThan(0);
	expect(offer).toBeGreaterThan(source);
	expect(writer).toContain("Research VPS costs &lt;without&gt; assuming a provider.");
	expect(writer).toContain(">Start research</button>");
	expect(writer).toContain(">Dismiss</button>");
	let viewer = render(false);
	expect(viewer).toContain('data-research-offer="offer-1"');
	expect(viewer).not.toContain(">Start research</button>");
	expect(viewer).not.toContain(">Dismiss</button>");
});

function offerState(status: "offered" | "accepted"): ConversationPlan.State {
	return {
		schemaVersion: 1,
		revision: 1,
		events: [],
		threads: [],
		queue: [],
		analysis: [],
		researchOffers: [{
			id: "offer-1",
			needId: "need-1",
			contextId: "context-1",
			brief: "Compare VPS costs",
			status,
			source: {
				messageId: "source-1",
				author: { kind: "member", handle: "ana" },
				quote: "Compare VPS costs",
				start: 0,
				end: 17,
			},
		}],
	};
}

let messages = [
	{ id: "source-1", author: { kind: "member" as const, handle: "ana" }, text: "Compare", ts: 1 },
	{ id: "source-2", author: { kind: "member" as const, handle: "ana" }, text: "And more", ts: 2 },
];

test("the speaker's messages after an offer card continue without a repeated header", () => {
	let groups = researchTranscript(
		[{
			kind: "messages",
			author: { kind: "member", handle: "ana" },
			queued: false,
			messages: messages.map(message => ({ ...message, queued: false })),
		}],
		offerState("offered").researchOffers!,
	);
	expect(groups.map(item => item.kind === "messages" ? !!item.continued : item.kind)).toEqual([
		false,
		"research",
		true,
	]);
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: messages,
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
		conversationPlan: offerState("offered"),
		researchOffers: {
			links: {},
			busy: new Set<string>(),
			errors: {},
			canAct: false,
			canCheckLink: true,
			store: {} as ResearchRequestStore,
			onAction: () => {},
			onRetryLink: () => {},
		},
	}));
	expect(markup.match(/>Ana<\/span>/g)).toHaveLength(1);
});

test("a ready request linked from a visible offer card announces itself only on the card", () => {
	let path = "/documents/octo-org/score/parent/children/vps-costs";
	let render = (slug: string) =>
		renderToStaticMarkup(createElement(Transcript, {
			active: true,
			entries: [messages[0]!, {
				id: "ready",
				author: { kind: "system" },
				text: `Research is ready. [Open the research document](${path}).`,
				ts: 3,
			}],
			handle: "ana",
			onWithdraw: () => {},
			queued: [],
			conversationPlan: offerState("accepted"),
			researchOffers: {
				links: { "offer-1": { status: "linked", researchRequestId: "request-1" } },
				busy: new Set<string>(),
				errors: {},
				canAct: false,
				canCheckLink: true,
				store: {
					get: () => ({ stage: "ready", child: { slug } }),
					subscribe: () => () => {},
					retain: () => () => {},
				} as unknown as ResearchRequestStore,
				onAction: () => {},
				onRetryLink: () => {},
			},
		}));
	expect(render("vps-costs")).not.toContain("Open the research document");
	expect(render("other-report")).toContain("Open the research document");
});
