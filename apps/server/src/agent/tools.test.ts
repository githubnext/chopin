import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toolbox } from "./tools";
import * as room from "../plan/room";
import * as Service from "../plan/service";

import type { Server } from "bun";
import type { SocketData } from "../wire";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.

<Questionnaire id="${WIDGET}" by="ana" at="2026-07-28T10:14:00.000Z">
<Question id="${QUESTION}" header="Cache" prompt="How long do we cache?" multiple="false">
<Option id="${OPTION}" label="60 seconds" />
<Answer value="60 seconds" />
</Question>
</Questionnaire>
`;

let directories: string[] = [];
let plans: Awaited<ReturnType<typeof Service.open>>[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
	for (let directory of directories) await rm(directory, { recursive: true, force: true });
	directories = [];
});

test("anchor_plan publishes moving a decision beside the validated prose", async () => {
	let directory = await mkdtemp(join(tmpdir(), "chopin-agent-tools-"));
	directories.push(directory);
	await writeFile(join(directory, "plan.mdx"), SOURCE);
	await writeFile(
		join(directory, "state.json"),
		JSON.stringify({
			revision: 1,
			questions: [{
				id: WIDGET,
				status: "answered",
				resolver: "ana",
				definition: {
					questions: [{
						id: QUESTION,
						header: "Cache",
						question: "How long do we cache?",
						multiple: false,
						options: [{ id: OPTION, label: "60 seconds", description: "" }],
					}],
				},
				answers: { [QUESTION]: "60 seconds" },
			}],
		}),
	);

	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Service.open("test", directory, server);
	plans.push(plan);
	let published: unknown[] = [];
	let anchors = 0;
	let anchorPlan = toolbox({
		plan,
		server,
		room: "test",
		publish: mutation => published.push(mutation),
		anchors: () => anchors++,
		changes() {},
	}).find(tool => tool.name === "anchor_plan");
	if (!anchorPlan) throw new Error("anchor_plan is missing");
	if (!anchorPlan.handler) throw new Error("anchor_plan has no handler");
	let digest = room.digests(plan.document)[1]!;

	let args = {
		revision: plan.revision,
		anchors: [{ widget: WIDGET, question: QUESTION, blocks: [{ index: 1, digest }] }],
	};
	let response = await anchorPlan.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "anchor_plan",
		arguments: args,
	});
	if (typeof response !== "string") throw new Error("anchor_plan returned no text");
	let result = JSON.parse(response);

	expect(result.ok).toBe(true);
	expect(published).toHaveLength(1);
	expect(anchors).toBe(1);
	let source = room.project(plan.document);
	expect(source.indexOf("The renderer caches tiles for 60 seconds."))
		.toBeLessThan(source.indexOf(`<Questionnaire id="${WIDGET}"`));
	expect(source.indexOf(`<Questionnaire id="${WIDGET}"`))
		.toBeLessThan(source.indexOf("The second paragraph."));
});
