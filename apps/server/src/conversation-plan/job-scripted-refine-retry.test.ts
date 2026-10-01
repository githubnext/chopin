import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";
import { BACKGROUND_TOOL_NAMES } from "../harness/tool-names";
import { scriptedRefine } from "./job-scripted-refine-retry.test-fixtures";

const TITLE = "Which authentication approach should the pilot use?";
const LABEL = "GitHub Apps";
const RATIONALE = "It keeps the pilot small and concrete.";

function script(id: string) {
	return [{
		tool: "refine_decision",
		args: {
			revision: "$revision",
			id,
			title: TITLE,
			add_options: [{ label: LABEL, rationale: RATIONALE }],
		},
	}];
}

test("a failed scripted refine survives reopen and only an explicit corrected-file retry runs it", async () => {
	let dir = await mkdtemp(join(tmpdir(), "scripted-refine-retry-"));
	let opened = await openPlan("Opening prose.\n\nLater prose.\n");
	let plan = opened.plan;
	let current: Awaited<ReturnType<typeof scriptedRefine>> | undefined;
	try {
		let id = await Questions.insertConversationCard(plan, opened.server, opened.channel.id, {
			threadId: "thread-a",
			header: "Authentication",
			question: "What auth system should we use?",
			options: [],
		});
		plan.chat.entries.push({
			id: "m1",
			author: { kind: "member", handle: "ana" },
			text: "We need to choose authentication.",
			ts: 1,
		});
		await Plan.persist(plan);
		await Plan.close(plan);
		plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
		let baseline = structuredClone(plan.records.get(id)!);
		let source = Plan.source(plan);
		let revision = plan.revision;
		let draft = Store.get(plan.questions, id)!;
		let draftRevision = draft.revision;
		await writeFile(join(dir, "refine.json"), JSON.stringify(script("not-this-card")));
		current = await scriptedRefine({ ...opened, plan }, dir, id);
		let first = current;
		expect(first.driver.starts()).toBe(0);
		expect(first.counts()).toEqual({
			setups: 0,
			unexpectedCommands: 0,
			sandboxDestroys: 0,
			credentialReleases: 0,
		});
		await first.jobs.enqueue({ kind: "refine", target: id, trigger: "m1" });
		await first.jobs.idle();
		let failed = structuredClone(plan.conversationPlanJobs[0]!);
		expect(failed).toMatchObject({
			id: `refine:${id}:m1`,
			target: id,
			trigger: "m1",
			status: "failed",
			attempts: 1,
			reason: "The Planner ended without calling refine_decision.",
		});
		expect(first.driver.results).toMatchObject([{
			toolName: "refine_decision",
			output: "Error: This job refines a different decision.",
		}]);
		expect(first.driver.tools).toEqual([[...BACKGROUND_TOOL_NAMES.refine]]);
		expect(first.driver.starts()).toBe(1);
		expect(first.driver.destroyed()).toBe(1);
		expect(first.identity.driver.starts()).toBe(0);
		expect(plan.records.get(id)).toEqual(baseline);
		expect(Plan.source(plan)).toBe(source);
		expect(plan.revision).toBe(revision);
		expect(Store.get(plan.questions, id)?.revision).toBe(draftRevision);
		let failureResult = (await first.results())[0]!;
		expect(failureResult.saved.record).toEqual(baseline);
		expect(failureResult.saved.source).toBe(source);
		expect(failureResult.saved.transcript).toHaveLength(1);
		let failedPublication = first.publications.find(({ frame }) =>
			frame.kind === "conversation-plan:jobs"
			&& (frame.jobs as Array<{ status: string }>)[0]?.status === "failed"
		)!;
		expect(failedPublication.saved.jobs).toEqual([failed]);
		expect(failedPublication.saved.record).toEqual(baseline);
		expect(failedPublication.saved.transcript).toHaveLength(1);
		expect(first.errors).toEqual([]);
		expect(first.counts()).toEqual({
			setups: 1,
			unexpectedCommands: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
		await first.close();
		plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
		current = undefined;
		expect(plan.conversationPlanJobs).toEqual([failed]);
		expect(plan.records.get(id)).toEqual(baseline);
		expect(Plan.source(plan)).toBe(source);
		current = await scriptedRefine({ ...opened, plan }, dir, id, first.identity);
		let retry = current;
		retry.jobs.wake();
		await retry.jobs.idle();
		expect(retry.driver.starts()).toBe(0);
		expect(retry.driver.destroyed()).toBe(0);
		expect(plan.conversationPlanJobs).toEqual([failed]);
		await writeFile(join(dir, "refine.json"), JSON.stringify(script("$target")));
		expect(await retry.jobs.retry(failed.id)).toBe(true);
		await retry.jobs.idle();
		let done = plan.conversationPlanJobs[0]!;
		expect(done).toMatchObject({
			id: failed.id,
			kind: failed.kind,
			target: failed.target,
			trigger: failed.trigger,
			status: "done",
			attempts: 2,
		});
		expect(done.reason).toBeUndefined();
		expect(JSON.parse(done.output!)).toEqual({ title: TITLE, added: 1 });
		let record = structuredClone(plan.records.get(id)!);
		let question = record.definition.questions[0]!;
		expect(question.question).toBe(TITLE);
		expect(question.options).toHaveLength(1);
		let option = question.options[0]!;
		expect(option.id).toBeTruthy();
		expect(option.label).toBe(LABEL);
		expect(record.optionOrigins[option.id]).toEqual({ origin: "planner", rationale: RATIONALE });
		let successfulResult = (await retry.results())[0]!;
		expect(String(successfulResult.output)).toContain('"ok": true');
		expect(successfulResult.saved.record).toEqual(record);
		expect(successfulResult.saved.source).toBe(Plan.source(plan));
		expect(successfulResult.saved.jobs).toMatchObject([{ status: "running", attempts: 1 }]);
		expect(successfulResult.saved.transcript).toHaveLength(1);
		let donePublication = retry.publications.find(({ frame }) =>
			frame.kind === "conversation-plan:jobs"
			&& (frame.jobs as Array<{ status: string }>)[0]?.status === "done"
		)!;
		expect(donePublication.saved.jobs).toEqual([done]);
		expect(donePublication.saved.record).toEqual(record);
		expect(donePublication.saved.source).toBe(Plan.source(plan));
		expect(donePublication.saved.transcript).toMatchObject([
			{ id: "m1", text: "We need to choose authentication." },
			{ author: { kind: "system" }, text: `Chopin refined ${TITLE}` },
		]);
		expect(donePublication.saved.transcript).toHaveLength(2);
		expect(retry.driver.tools).toEqual([[...BACKGROUND_TOOL_NAMES.refine]]);
		expect(retry.driver.calls).toMatchObject([{
			toolName: "refine_decision",
			input: { id, title: TITLE },
		}]);
		expect(retry.driver.starts()).toBe(1);
		expect(retry.driver.destroyed()).toBe(1);
		expect(retry.identity.driver.starts()).toBe(0);
		expect(retry.counts()).toEqual({
			setups: 1,
			unexpectedCommands: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
		expect(retry.errors).toEqual([]);
		expect(plan.chat.job).toBeUndefined();
		expect(plan.chat.turn).toBeUndefined();
		expect(plan.chat.entries.some(entry => entry.tools?.length || entry.streaming)).toBe(false);
		expect(
			opened.broadcasts.some(frame => ["chat:tool", "chat:delta"].includes(String(frame.kind))),
		)
			.toBe(false);
		for (let observation of [...first.publications, ...retry.publications]) {
			if (observation.frame.kind === "question:meta") {
				expect(observation.frame.id).toBe(id);
				expect(observation.frame.meta).toMatchObject({
					status: observation.saved.record!.status,
					origin: observation.saved.record!.origin,
					optionOrigins: observation.saved.record!.optionOrigins,
					refining: observation.saved.jobs.some(job =>
						job.kind === "refine" && ["pending", "running"].includes(job.status)
					),
				});
			}
			if (observation.frame.kind === "question:changed") {
				expect(observation.frame.definition).toEqual(observation.saved.record!.definition);
			}
		}
		let changed = retry.publications.filter(({ frame }) => frame.kind === "question:changed");
		expect(changed).toHaveLength(2);
		expect(changed.at(-1)!.frame.definition).toEqual(record.definition);
		let metas = retry.publications.filter(({ frame }) => frame.kind === "question:meta");
		expect(metas.at(-1)!.frame.meta).toMatchObject({
			refining: false,
			optionOrigins: record.optionOrigins,
		});
		let completedSource = Plan.source(plan);
		await retry.close();
		plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
		current = undefined;
		expect(plan.records.get(id)).toEqual(record);
		expect(plan.conversationPlanJobs).toEqual([done]);
		expect(Plan.source(plan)).toBe(completedSource);
		expect(plan.chat.entries).toHaveLength(2);
		expect(plan.chat.waiting).toEqual([]);
		current = await scriptedRefine({ ...opened, plan }, dir, id, first.identity);
		current.jobs.wake();
		await current.jobs.idle();
		expect(current.driver.starts()).toBe(0);
		expect(current.driver.destroyed()).toBe(0);
		expect(current.counts()).toEqual({
			setups: 0,
			unexpectedCommands: 0,
			sandboxDestroys: 0,
			credentialReleases: 0,
		});
		expect(await current.jobs.retry(done.id)).toBe(false);
	} finally {
		if (current) await current.close();
		else if (!plan.chat.closed) await Plan.close(plan);
		await rm(dir, { recursive: true, force: true });
	}
});
