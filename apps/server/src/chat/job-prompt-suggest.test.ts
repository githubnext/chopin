import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";
import { BACKGROUND_TOOL_NAMES } from "../harness/tool-names";
import { promptCard } from "./job-prompt-card.test-fixtures";
import type { ConversationPlan } from "@chopin/protocol";

test("a prompt-only suggest model refuses a title change before adding its sourced option", async () => {
	let opened = await openPlan("Opening prose.\n\nLater prose.\n");
	let plan = opened.plan;
	let h: Awaited<ReturnType<typeof promptCard>> | undefined;
	try {
		let id = await Questions.insertConversationCard(plan, opened.server, opened.channel.id, {
			threadId: "suggest-thread",
			header: "Authentication",
			question: "What auth should we use?",
			options: [],
		});
		let source: ConversationPlan.SourceRef = {
			messageId: "m-option",
			author: { kind: "member", handle: "ana" },
			quote: "GitHub Apps",
			start: 0,
			end: 11,
			role: "option",
		};
		plan.chat.entries.push({
			id: source.messageId,
			author: source.author,
			text: source.quote,
			ts: 1,
		});
		await Plan.persist(plan);
		await Plan.close(plan);
		plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
		opened.plan = plan;
		await Plan.persist(plan);
		let baseline = structuredClone(plan.records.get(id)!);
		let initialSource = Plan.source(plan);
		let revision = plan.revision;
		let draft = Store.get(plan.questions, id)!;
		let draftRevision = draft.revision;
		let rationale = "It keeps the pilot small and concrete.";
		h = await promptCard(opened, { kind: "suggest", target: id, trigger: source.messageId }, [
			{
				tool: "refine_decision",
				args: { revision: "$revision", id: "$target", title: "Forbidden title?", add_options: [] },
			},
			{
				tool: "refine_decision",
				args: {
					revision: "$revision",
					id: "$target",
					add_options: [{ label: source.quote, rationale, source }],
				},
			},
		]);
		expect(h.prompt).toStartWith("[Background job: suggest]");
		expect(h.prompt).toContain(`Decision card ${id}:`);
		let outcome = await h.run();
		expect(outcome).toEqual({
			status: "done",
			output: JSON.stringify({ title: baseline.definition.questions[0]!.question, added: 1 }),
		});
		expect(h.driver.tools).toEqual([[...BACKGROUND_TOOL_NAMES.suggest]]);
		expect(h.driver.calls.map(call => call.toolName)).toEqual([
			"read_plan",
			"refine_decision",
			"read_plan",
			"refine_decision",
		]);
		let observations = h.results();
		expect(observations.map(result => result.toolName)).toEqual([
			"read_plan",
			"refine_decision",
			"read_plan",
			"refine_decision",
		]);
		let [firstRead, refused, secondRead, added] = observations;
		expect(refused!.output).toBe("Error: title and place_after are only changed by a refine job.");
		expect(refused!.saved.record).toEqual(baseline);
		expect(refused!.saved.source).toBe(initialSource);
		expect(refused!.revision).toBe(revision);
		expect(refused!.liveRevision).toBe(draftRevision);
		expect(refused!.saved.revision).toBe(revision);
		expect(JSON.parse(String(firstRead!.output)).revision).toBe(revision);
		expect(JSON.parse(String(secondRead!.output)).revision).toBe(revision);
		expect(secondRead!.saved.record).toEqual(baseline);
		expect(secondRead!.saved.source).toBe(initialSource);
		expect(h.driver.calls[1]!.input).toEqual({
			revision,
			id,
			title: "Forbidden title?",
			add_options: [],
		});
		expect(h.driver.calls[3]!.input).toEqual({
			revision,
			id,
			add_options: [{ label: source.quote, rationale, source }],
		});
		let record = structuredClone(plan.records.get(id)!);
		let question = record.definition.questions[0]!;
		expect(question.question).toBe(baseline.definition.questions[0]!.question);
		expect(question.options).toHaveLength(1);
		let option = question.options[0]!;
		expect(option.label).toBe(source.quote);
		expect(option.id).toBeTruthy();
		expect(record.optionOrigins[option.id]).toEqual({ origin: "planner", rationale, source });
		expect(added!.saved.record).toEqual(record);
		expect(added!.saved.source).toBe(Plan.source(plan));
		expect(added!.revision).toBeGreaterThan(revision);
		expect(added!.saved.revision).toBe(added!.revision);
		expect(String(added!.output)).toContain('"ok": true');
		expect(Store.get(plan.questions, id)!.revision).toBe(draftRevision + 1);
		expect(h.driver.starts()).toBe(1);
		expect(h.driver.destroyed()).toBe(1);
		expect(h.identity.driver.starts()).toBe(0);
		expect(h.counts()).toEqual({
			setups: 1,
			unexpectedCommands: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
		expect(plan.chat.job).toBeUndefined();
		expect(plan.chat.turn).toBeUndefined();
		expect(plan.chat.entries).toHaveLength(1);
		expect(plan.chat.entries.some(entry => entry.tools?.length || entry.streaming)).toBe(false);
		expect(
			opened.broadcasts.some(frame => ["chat:tool", "chat:delta"].includes(String(frame.kind))),
		)
			.toBe(false);
		let savedSource = Plan.source(plan);
		await h.close();
		plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
		expect(plan.records.get(id)).toEqual(record);
		expect(Plan.source(plan)).toBe(savedSource);
		expect(plan.chat.entries).toHaveLength(1);
		expect(plan.chat.waiting).toEqual([]);
		expect(h.driver.starts()).toBe(1);
	} finally {
		await h?.close();
		if (!plan.chat.closed) await Plan.close(plan);
	}
});
