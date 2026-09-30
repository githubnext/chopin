import { expect, test } from "bun:test";
import { interpretLowOwnership, stateWithQuestion } from "./pipeline-recovery.test-fixtures";

test("ambiguous exact-question matches do not recover a partial card", async () => {
	let text = "Should audit logs go in PostgreSQL or object storage?";
	let state = stateWithQuestion("thread:first-audit", text, ["PostgreSQL"]);
	state = stateWithQuestion("thread:second-audit", text, [], state);
	let output = await interpretLowOwnership("repeat-audit-ambiguous-state", text, {
		weakFragments: false,
		state,
		triageTarget: "new",
		candidateThreadTargets: { c0_thread: "new", c1_thread: "new" },
		candidateRoles: { c0_role: "question", c1_role: "option" },
		candidateDuplicates: { c0_duplicate: 0.95 },
	});
	expect(output.events).toEqual([]);
});

test.each([
	{
		id: "reported-email-question",
		text: "Mina asked, “Should we use Postmark or Amazon SES for notification emails?”",
	},
	{
		id: "reported-email-provider-question",
		text: "Which service did Alice say we should use: Postmark or SES?",
	},
	{
		id: "negated-email-choice",
		text: "Should we not use Postmark or Amazon SES for notification emails?",
	},
	{
		id: "negated-email-provider-question",
		text: "Which service shouldn't we use: Postmark or SES?",
	},
	{
		id: "curly-negated-email-provider-question",
		text: "Which service shouldn’t we use: Postmark or SES?",
	},
	{
		id: "indirect-email-question",
		text: "Would it make sense to use Postmark or Amazon SES for notification emails?",
	},
	{
		id: "mixed-context-email-question",
		text: "Quick question. Should we use Postmark or Amazon SES?",
	},
])("low ownership keeps $id from opening a sourced choice", async ({ id, text }) => {
	let output = await interpretLowOwnership(id, text, { weakFragments: false });
	expect(output.events).toEqual([]);
});
