import { expect, test } from "bun:test";
import { researchRequest } from "./research-interpreter";
import { researchQuoteSupportsPair } from "./service";
import { seeded, withOption } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test("research selection shows effective relabeled options and exact quote choices", () => {
	let state = withOption(seeded());
	let option = state.threads[0]!.contributions[0]!;
	option.text = "R2";
	option.displayLabel = "Backblaze B2";
	state.threads[0]!.contributions.push({
		...option,
		id: "other-option",
		text: "Amazon S3",
		displayLabel: undefined,
	});
	let current = message("cost-request", "Compare current provider prices.");
	let { request, context, spans } = researchRequest({ message: current, recent: [], state });
	expect(context.decisions[0]!.options.find(item => item.id === option.id)?.label).toBe(
		"Backblaze B2",
	);
	expect(spans[0]).toEqual({
		quote: current.text,
		start: 0,
		end: current.text.length,
	});
	expect(request.questions.owned?.type).toBe("noul");
});

test("research quote rejects explicit alternatives outside the current pair", () => {
	let options = [{ text: "Amazon S3" }, { text: "Cloudflare R2" }];
	expect(researchQuoteSupportsPair("Compare Amazon S3 and Redis costs.", options)).toBe(false);
	expect(researchQuoteSupportsPair("Amazon S3 or Redis costs?", options)).toBe(false);
	expect(researchQuoteSupportsPair("How do Amazon S3 and Redis costs compare?", options))
		.toBe(false);
	expect(researchQuoteSupportsPair("Amazon S3 is cheaper than Redis at current prices.", options))
		.toBe(false);
	expect(
		researchQuoteSupportsPair("Compare Amazon S3 and Cloudflare R2 and Redis costs.", options),
	)
		.toBe(false);
	expect(researchQuoteSupportsPair("Compare Amazon S3 and Cloudflare R2 costs.", options))
		.toBe(true);
	expect(researchQuoteSupportsPair("R2's egress could matter for thumbnails.", options))
		.toBe(true);
	expect(researchQuoteSupportsPair("I don't know current provider prices.", options))
		.toBe(true);
	expect(researchQuoteSupportsPair("Compare Amazon S3 and Cloudflare R2 costs.", [
		options[0]!,
		{ text: "Cloudflare R2", displayLabel: "Backblaze B2" },
	])).toBe(false);
});
