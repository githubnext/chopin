import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResearchOfferCard, shouldShowResearchActionError } from "./research-offer";
import { deferred } from "./research-offer.test-fixtures";
import type { ConversationPlan } from "@chopin/protocol";
import type { OfferLinkView } from "./research-offer";
import type { ResearchRequestStore } from "../research-requests";
import { researchDraftHarness } from "../../../server/src/conversation-plan/research-draft.test-fixtures";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, apps/web/src/chat/research-offer.test.ts.
test("Resume appears only for a verified unresolved link and linked work hides stale errors", () => {
	let offer: ConversationPlan.ResearchOffer = {
		id: "offer-1",
		needId: "need-1",
		contextId: "context-1",
		brief: "Research the hosting options",
		status: "accepted",
		source: {
			messageId: "source-1",
			author: { kind: "member", handle: "ana" },
			quote: "Research hosting",
			start: 0,
			end: 16,
		},
	};
	let store = {
		subscribe: () => () => {},
		get: () => undefined,
		retain: () => () => {},
	} as unknown as ResearchRequestStore;
	let render = (link?: OfferLinkView, canAct = true) =>
		renderToStaticMarkup(createElement(ResearchOfferCard, {
			offer,
			controls: {
				links: link ? { [offer.id]: link } : {},
				busy: new Set<string>(),
				errors: { [offer.id]: "Old Resume error" },
				canAct,
				canCheckLink: true,
				store,
				onAction: () => {},
				onRetryLink: () => {},
			},
		}));
	for (let link of [undefined, { status: "checking" }, { status: "error" }] as const) {
		expect(render(link)).not.toContain(">Resume</button>");
	}
	for (let status of ["pending", "unlinked"] as const) {
		let link: OfferLinkView = status === "unlinked"
			? { status, researchRequestId: "request-1" }
			: { status };
		expect(render(link)).toContain(">Resume</button>");
	}
	let linked = render({ status: "linked", researchRequestId: "request-1" });
	expect(linked).not.toContain(">Resume</button>");
	expect(linked).not.toContain("Old Resume error");

	let failedViewer = render({ status: "error", exhausted: true }, false);
	expect(failedViewer).toContain(">Retry link check</button>");
	expect(failedViewer).not.toContain(">Resume</button>");
	expect(render({ status: "error" }, false)).not.toContain(">Retry link check</button>");
});

test("a deferred Resume failure cannot create an error after the link becomes linked", async () => {
	let reply = deferred<void>();
	let link: OfferLinkView["status"] = "pending";
	let showError = false;
	let completed = reply.promise.catch(() => {
		showError = shouldShowResearchActionError("resume", "accepted", link);
	});
	link = "linked";
	reply.reject(new Error("old Resume failed"));
	await completed;
	expect(showError).toBe(false);
	expect(shouldShowResearchActionError("resume", "accepted", "unlinked")).toBe(true);
	expect(shouldShowResearchActionError("research", "accepted", undefined)).toBe(false);
});

test("a failed brief projection exposes refinement failure and a writer-only retry", () => {
	let offer = researchDraftHarness().offer();
	offer.workflow!.preparation = "failed";
	let render = (canAct: boolean) =>
		renderToStaticMarkup(createElement(ResearchOfferCard, {
			offer,
			controls: {
				links: {},
				busy: new Set<string>(),
				errors: {},
				canAct,
				canCheckLink: false,
				store: {} as ResearchRequestStore,
				onAction() {},
				onRetryLink() {},
			},
		}));
	expect(render(true)).toContain("Brief refinement failed.");
	expect(render(true)).toContain(">Retry refinement</button>");
	expect(render(false)).toContain("Brief refinement failed.");
	expect(render(false)).not.toContain(">Retry refinement</button>");
});
