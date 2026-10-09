import { content, expect, test, written } from "./room";

import { type DocumentRoom, documentTools } from "../apps/server/src/agent/tools";
import * as Room from "../apps/server/src/plan/room";
import * as Service from "../apps/server/src/plan/service";
import { openPlan } from "../apps/server/src/testing/plan";

import type { JevResult } from "../apps/server/src/conversation-plan/jev";

function answer(answers: JevResult["answers"]): JevResult {
	return {
		model: "fake-jev",
		answers,
		usage: { input_tokens: 1, output_tokens: 1 },
		latencyMs: 1,
	};
}

test("a fake Jev routed tool edit renders after browser save and reopen", async ({ join, room, seed }) => {
	let opened = await openPlan("# Token check\n");
	let passage =
		"A request enters the API. If its token is valid, the API stores the request. Otherwise it rejects the request.";
	let diagram = {
		type: "flowchart",
		title: "Token check",
		nodes: [
			{ id: "request", label: "Request enters API", shape: "terminal", row: 0, col: 1 },
			{ id: "valid", label: "Valid token?", shape: "decision", row: 1, col: 1 },
			{ id: "store", label: "Store request", shape: "terminal", row: 2, col: 0 },
			{ id: "reject", label: "Reject request", shape: "terminal", row: 2, col: 2 },
		],
		edges: [["request", "valid"], ["valid", "store", "yes"], ["valid", "reject", "no"]],
	};
	let source: string;
	try {
		let member = {
			entryId: "member-1",
			userId: "user-1",
			handle: "writer",
			text: "How does the API handle tokens?",
			claimantSessionId: undefined,
			turnId: "turn-1",
			lifecycle: 1,
		};
		let document: DocumentRoom = {
			id: opened.channel.id,
			plan: opened.plan,
			server: opened.server,
			publish: mutation => Service.publish(opened.plan, opened.server, opened.channel.id, mutation),
			persist: async () => {},
			exclusive: action => Service.exclusive(opened.plan, action),
			anchors: () => {},
			changes: () => {},
			currentMemberRequest: () => member,
			visual: {
				ask: async request => {
					let key = Object.keys(request.questions)[0];
					if (key === "p0") return answer({ p0: { type: "noul", noul: 0.9 } });
					if (key === "h0") return answer({ h0: { type: "noul", noul: 0.8 } });
					return answer({
						t0: { type: "choice", choice: "flowchart", confidence: 0.9, probabilities: {} },
					});
				},
			},
		};
		let call = async (name: "assess_visual" | "edit_plan", input: unknown) => {
			let output = await documentTools[name].execute!(input as never, {
				context: { room: document },
				toolCallId: name,
				messages: [],
			} as never);
			if (typeof output !== "string") throw new Error("tool did not return text");
			return JSON.parse(output);
		};
		let revision = document.plan.revision;
		let operation = { op: "insert_root", source: passage };
		let assessed = await call("assess_visual", { revision, operation });
		expect(assessed).toMatchObject({ ok: true, route: { kind: "diagram", type: "flowchart" } });
		let edited = await call("edit_plan", {
			revision,
			operations: [{
				op: "insert_root",
				source: `${passage}\n\n\`\`\`seecode\n${JSON.stringify(diagram)}\n\`\`\``,
			}],
			visual_route: assessed.visual_route,
		});
		expect(edited).toMatchObject({ ok: true });
		source = Room.project(document.plan.document);
	} finally {
		await Service.close(opened.plan);
	}

	await seed(source!);
	let page = await join("ana");
	let preview = content(page).getByRole("region", { name: "Diagram preview", exact: true });
	let rendered = (title: string) =>
		preview.getByRole("group", { name: `${title} Flowchart diagram`, exact: true });
	await expect(rendered("Token check")).toHaveAttribute("data-sc-type", "flowchart");
	await expect(preview.getByRole("button", { name: "Valid token?", exact: true })).toBeVisible();
	await expect(content(page)).toContainText(passage);

	let editable = content(page).locator("[data-plan-source]");
	await expect(editable).toBeHidden();
	await preview.focus();
	await preview.press("Enter");
	await expect(editable).toBeVisible();
	await editable.selectText();
	await page.keyboard.insertText(JSON.stringify({ ...diagram, title: "Revised token check" }));
	await written(page, room, /Revised token check/);
	await page.reload();
	await expect(rendered("Revised token check").locator("title")).toHaveText("Revised token check");
	await expect(content(page)).toContainText(passage);
});
