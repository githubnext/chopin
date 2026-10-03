import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test.each([
	{
		id: "uploaded-files",
		text: "Should we store uploaded files in Amazon S3 or on a local disk?",
		options: ["Amazon S3", "on a local disk"],
	},
	{
		id: "notification-emails",
		text: "Which service should send notification emails: Postmark or Amazon SES?",
		options: ["Postmark", "Amazon SES"],
	},
	{
		id: "d03-notification-providers",
		text: "what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		options: ["SMTP relay", "Postmark", "SES"],
	},
])("extracts only the exact alternatives from $id question", async ({ id, text, options }) => {
	let current = message(`explicit-alternatives-${id}`, text, "Jules");
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: initialState(),
		ask: async request => {
			if ("new_question" in request.questions) {
				return mockResult(request.questions, {
					new_question: 0.97,
					act: "question",
					thread_target: "new",
					significance: 2,
				});
			}
			let overrides: Record<string, string | number> = {};
			for (let key of Object.keys(request.questions)) {
				if (!key.startsWith("c")) continue;
				if (key.endsWith("_role")) overrides[key] = "option";
				if (key.endsWith("_thread")) overrides[key] = "new";
				if (/^c\d+_option$/.test(key)) overrides[key] = "new";
				if (key.endsWith("_new_option")) overrides[key] = 0.95;
			}
			return mockResult(request.questions, overrides);
		},
	});

	expect(output.events.map(event => event.type)).toEqual([
		"thread.opened",
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

test("D03's direct option group requires option=new for every candidate", async () => {
	let text = "what sends transactional notifications? our SMTP relay, Postmark, or SES?";
	let current = message("d03-missing-option-target", text, "Jules");
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: initialState(),
		ask: async request => {
			if ("new_question" in request.questions) {
				return mockResult(request.questions, {
					new_question: 0.97,
					act: "question",
					thread_target: "new",
					significance: 2,
				});
			}
			let overrides: Record<string, string | number> = {};
			for (let key of Object.keys(request.questions)) {
				if (!key.startsWith("c")) continue;
				if (key.endsWith("_role")) overrides[key] = "option";
				if (key.endsWith("_thread")) overrides[key] = "new";
				let optionTarget = key.match(/^c(\d+)_option$/);
				if (optionTarget) overrides[key] = optionTarget[1] === "1" ? "none" : "new";
				if (key.endsWith("_new_option")) overrides[key] = 0.95;
			}
			return mockResult(request.questions, overrides);
		},
	});
	expect(output.events.filter(event => event.type === "option.added")).toEqual([]);
});
