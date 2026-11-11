import { describe, expect, test } from "bun:test";

import {
	CHAT_MIN_WITH_THREAD,
	DOC_MIN_WITH_THREAD,
	THREAD_MAX,
	THREAD_MIN,
	threadSplitSizing,
} from "./split-layout";

describe("threadSplitSizing", () => {
	test("at 1600 viewport (available ~1326 right of sidebar) keeps all three panes open above minimums", () => {
		let result = threadSplitSizing({
			available: 1326,
			preferredChat: 500,
			threadOpen: true,
		});
		expect(result.documentCollapsed).toBe(false);
		expect(result.thread).toBeGreaterThanOrEqual(THREAD_MIN);
		expect(result.thread).toBeLessThanOrEqual(THREAD_MAX);
		expect(result.chat).toBeGreaterThanOrEqual(CHAT_MIN_WITH_THREAD);
		expect(1326 - result.combined).toBeGreaterThanOrEqual(DOC_MIN_WITH_THREAD);
	});

	test("at 1280 viewport (available ~1006 right of sidebar) collapses document and splits Chat ~60% / Thread ~40%", () => {
		let result = threadSplitSizing({
			available: 1006,
			preferredChat: 500,
			threadOpen: true,
		});
		expect(result.documentCollapsed).toBe(true);
		expect(result.combined).toBe(1006);
		expect(result.thread).toBe(402);
		expect(result.chat).toBe(604);
	});

	test("honours a person's saved preferredThread within [360, 560] while protecting Chat's 420 minimum", () => {
		let result = threadSplitSizing({
			available: 1500,
			preferredChat: 500,
			preferredThread: 480,
			threadOpen: true,
		});
		expect(result.documentCollapsed).toBe(false);
		expect(result.thread).toBe(480);
		expect(result.chat).toBeGreaterThanOrEqual(CHAT_MIN_WITH_THREAD);
		expect(1500 - result.combined).toBeGreaterThanOrEqual(DOC_MIN_WITH_THREAD);
	});
});
