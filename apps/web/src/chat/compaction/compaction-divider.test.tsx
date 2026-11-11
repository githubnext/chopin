import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { INTERNAL } from "@chopin/protocol/plain-words";
import {
	CompactingRow,
	CompactionDivider,
	messagesSummarizedLabel,
	tokensSavedLabel,
} from "./compaction-divider";

describe("CompactionDivider and CompactingRow", () => {
	test("renders calm compacting status and expandable Earlier messages were summarized divider in plain words", () => {
		let compactingHtml = renderToStaticMarkup(<CompactingRow />);
		expect(compactingHtml).toContain("Compacting earlier messages");
		expect(INTERNAL.test(compactingHtml)).toBe(false);

		let compactedHtml = renderToStaticMarkup(
			<CompactionDivider
				compaction={{
					id: "c1",
					summary: "Agreed on additive tables and balanced split widths.",
					messagesSummarized: 8,
					tokensBefore: 44_541,
					tokensAfter: 12_100,
					trigger: "auto",
					ts: 1700000000,
				}}
				defaultOpen
			/>,
		);
		expect(compactedHtml).toContain("Earlier messages were summarized");
		expect(compactedHtml).toContain("8 messages");
		expect(compactedHtml).toContain("32,441 tokens saved");
		expect(compactedHtml).toContain("Agreed on additive tables and balanced split widths.");
		expect(INTERNAL.test(compactedHtml)).toBe(false);
	});

	test("omits unreported token deltas and singularizes 1 message", () => {
		expect(messagesSummarizedLabel(1)).toBe("1 message");
		expect(messagesSummarizedLabel(0)).toBeUndefined();
		expect(tokensSavedLabel({})).toBeUndefined();
		expect(tokensSavedLabel({ tokensBefore: 5000, tokensAfter: 6000 })).toBeUndefined();
	});
});
