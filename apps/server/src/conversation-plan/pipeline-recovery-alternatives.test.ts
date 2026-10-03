import { expect, test } from "bun:test";
import { seeded } from "./interpret.test-fixtures";
import { interpretLowOwnership } from "./pipeline-recovery.test-fixtures";

test.each([
	{
		id: "notification-email-providers",
		text: "Which service should send notification emails: Postmark or Amazon SES?",
		options: ["Postmark", "Amazon SES"],
	},
	{
		id: "authentication-approaches",
		text: "Should we use Auth0, roll our own, or use GitHub auth?",
		options: ["use Auth0", "roll our own", "use GitHub auth"],
	},
	{
		id: "audit-log-storage",
		text: "Should audit logs go in PostgreSQL or object storage?",
		options: ["PostgreSQL", "object storage"],
	},
	{
		id: "background-job-queues",
		text: "Should background jobs use Redis or a PostgreSQL queue?",
		options: ["Redis", "a PostgreSQL queue"],
	},
])("direct alternatives in $id retain exact spans despite low classifier ownership", async ({
	id,
	text,
	options,
}) => {
	let output = await interpretLowOwnership(id, text);
	expect(output.events.map(event => event.type)).toEqual([
		"thread.opened" as const,
		...options.map(() => "option.added" as const),
	]);
	expect(output.events[0]).toMatchObject({
		question: text,
		source: { quote: text, start: 0, end: text.length, role: "question" },
	});
	let optionEvents = output.events.slice(1);
	expect(optionEvents.map(event => event.type === "option.added" ? event.contribution.text : ""))
		.toEqual([...options]);
	expect(optionEvents.map(event =>
		event.type === "option.added"
			? {
				quote: event.source?.quote,
				start: event.source?.start,
				end: event.source?.end,
			}
			: undefined
	))
		.toEqual(options.map(option => {
			let start = text.indexOf(option);
			return { quote: option, start, end: start + option.length };
		}));
});

test("a direct alternatives question opens beside an unrelated existing thread", async () => {
	let text = "Should audit logs go in PostgreSQL or object storage?";
	let options = ["PostgreSQL", "object storage"];
	let output = await interpretLowOwnership("audit-with-unrelated-thread", text, {
		weakFragments: false,
		state: seeded(),
		candidateThreadTarget: "none",
	});
	expect(output.events.map(event => event.type)).toEqual([
		"thread.opened",
		"option.added",
		"option.added",
	]);
	expect(output.events[0]).toMatchObject({
		question: text,
		source: { quote: text, start: 0, end: text.length, role: "question" },
	});
	let optionEvents = output.events.slice(1);
	expect(optionEvents.map(event => event.type === "option.added" ? event.contribution.text : ""))
		.toEqual(options);
	expect(optionEvents.map(event =>
		event.type === "option.added"
			? {
				quote: event.source?.quote,
				start: event.source?.start,
				end: event.source?.end,
			}
			: undefined
	))
		.toEqual(options.map(option => {
			let start = text.indexOf(option);
			return { quote: option, start, end: start + option.length };
		}));
});
