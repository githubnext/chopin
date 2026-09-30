import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "./transcript";
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
				store: {} as ResearchRequestStore,
				onAction: () => {},
			},
		}));
	let writer = render(true);
	let source = writer.indexOf('data-chat-message-id="source-2"');
	let offer = writer.indexOf('data-research-offer="offer-1"');
	expect(source).toBeGreaterThan(0);
	expect(offer).toBeGreaterThan(source);
	expect(writer).toContain("Research VPS costs &lt;without&gt; assuming a provider.");
	expect(writer).toContain(">Research</button>");
	expect(writer).toContain(">Dismiss</button>");
	let viewer = render(false);
	expect(viewer).toContain('data-research-offer="offer-1"');
	expect(viewer).not.toContain(">Research</button>");
	expect(viewer).not.toContain(">Dismiss</button>");
});
