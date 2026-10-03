/** Exact development chat excerpts from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2. */
let messages: Record<string, string> = {
	// Source: evals/conversation-shape/fixtures/development/D19.json, input.steps id m1, kind say.
	"D19/m1":
		"Before the repository pilot, we need to choose how people sign in and how the hosted agent gets repository credentials.",
	// Source: evals/conversation-shape/fixtures/development/D19.json, input.steps id m2, kind say.
	"D19/m2":
		"For human sign-in, the options are GitHub OAuth or email magic links. Separately, for the hosted agent's repository credentials, we could pass each user's GitHub token or use a GitHub App installation token. Those are two different calls.",
	// Source: evals/conversation-shape/fixtures/development/D02.json, input.steps id m2, kind say.
	"D02/m2": "a small VPS is enough for this traffic. we'll have to patch it ourselves.",
	// Source: evals/conversation-shape/fixtures/development/D03.json, input.steps id m1, kind say.
	"D03/m1": "what sends transactional notifications? our SMTP relay, Postmark, or SES?",
	// Source: evals/conversation-shape/fixtures/development/D04.json, input.steps id m5, kind say.
	"D04/m5": "worth comparing. R2's egress could matter for thumbnails.",
};

export async function fixtureMessage(caseId: string, stepId: string): Promise<string> {
	let text = messages[`${caseId}/${stepId}`];
	if (text === undefined) throw new Error(`${caseId}/${stepId} is not a message`);
	return text;
}
