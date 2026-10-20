import { expect, test } from "bun:test";
import { requestedActions } from "./revise-requests";

test("context can precede a separate explicit option instruction", () => {
	expect(requestedActions("These are the proposals. Please add these options to Authentication."))
		.toMatchObject([{ kind: "option" }]);
});

test("quoted context retains the following command's target", () => {
	expect(requestedActions('"A prior proposal."\nAdd options to the "Authentication" decision.'))
		.toEqual([{ kind: "option", clause: ' options to the "authentication" decision' }]);
});

test.each([
	"What options should we add to Authentication?",
	"We might add options to Authentication.",
	"If we proceed, add options to Authentication.",
	"If we decide to proceed later:\nAdd these options to the decision.",
	"The instruction I am considering is:\nAdd these options to the decision.",
	"Example:\nAdd these options to the decision.",
	'Example:\n"Add options to Authentication.\nAdd options to Billing."',
	"Example:\n```\nAdd options to Authentication.\n```",
	"Example:\n~~~\nAdd options to Authentication.\n~~~",
	"Someone said:\n> Add options to Authentication.",
	"Someone said: ‘Add options to Authentication.\nAdd options to Billing.’",
	"Add options to Authentication. Actually, cancel that request.",
	"Add these options to the decision. But wait until Idan responds.",
	"Here are ideas.\n\nDon't add these options to the decision.",
	"If Idan agrees:\nAdd options to Authentication.\nAdd options to Authentication.",
	"The following is an example:\nAdd options to Authentication.\nAdd options to Authentication.",
	"Someone said:\nAdd options to Authentication.\nAdd options to Authentication.",
	"Example: Add options to Authentication. Add options to Authentication.",
	"Example:\n\nAdd options to Authentication.\n\nAdd options to Authentication.",
	"The following is an example: Add options to Authentication.\n\nAdd options to Authentication.",
	"If Idan agrees: Add options to Authentication.\n\nAdd options to Authentication.",
	"Add these options to the decision. Only if Idan agrees.",
])("discussion, quotation or withdrawal cannot authorize edits: %s", text => {
	expect(requestedActions(text)).toEqual([]);
});
