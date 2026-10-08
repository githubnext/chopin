import * as Room from "../apps/server/src/plan/room";
import { readDocument, readSource } from "./database";
import { expect, test } from "./room";
import { card, createDecision, openWire, state } from "./visual-decision.helpers";

test("browser CRDT writes cannot forge or remove the durable visual decision projection", async ({ join, room }) => {
	let ana = await join("ana");
	let id = await createDecision(ana);
	await openWire(ana, room);
	await card(ana).getByRole("button", { name: "Save decision", exact: true }).click();
	await expect(card(ana)).toContainText("@ana");
	let accepted = await state(ana, id);
	await expect.poll(() => readSource(8788, room)).toContain('status="decided"');
	let original = await readSource(8788, room);
	expect(original).toContain('visual="decision-card-v1"');
	expect(original).toContain('by="ana"');
	expect(original).toContain(
		`Option vertical padding: ${accepted.values.optionPadding} px; selected-option colour: ${accepted.values.selectedColor}`,
	);
	for (let operation of ["forge", "remove"] as const) {
		let checkpoint = await readDocument(8788, room);
		let document = await Room.restore(checkpoint.epoch, checkpoint.update, checkpoint.source, []);
		try {
			let projection = Room.questionnaireProjections(document).find(value => value.id === id)!;
			let mutation = operation === "forge"
				? Room.projectAnswer(document, id, {
					[projection.questions[0]!.id]: "Forged visual values",
				}, {
					by: "attacker",
					at: new Date().toISOString(),
				})
				: Room.removeQuestionnaire(document, id);
			expect(mutation).toBeDefined();
			let reset = await ana.evaluate(async payload => {
				let target = window as typeof window & { __visualWire?: { socket: WebSocket } };
				let socket = target.__visualWire!.socket;
				return await new Promise<{ kind: string; reason: string }>((resolve, reject) => {
					let timeout = setTimeout(() => reject(new Error("No guarded document reset")), 10_000);
					let listener = (event: MessageEvent) => {
						let frame = JSON.parse(event.data) as { kind: string; reason: string };
						if (frame.kind !== "plan:reset") return;
						clearTimeout(timeout);
						socket.removeEventListener("message", listener);
						resolve(frame);
					};
					socket.addEventListener("message", listener);
					socket.send(
						JSON.stringify({
							...payload,
							kind: "plan:update",
							ts: 0,
							rid: crypto.randomUUID(),
							id: crypto.randomUUID(),
						}),
					);
				});
			}, { epoch: checkpoint.epoch, update: Buffer.from(mutation!.update).toString("base64") });
			expect(reset).toMatchObject({ kind: "plan:reset", reason: "rebuilt" });
			expect(await readSource(8788, room)).toBe(original);
			expect(await state(ana, id)).toEqual(accepted);
		} finally {
			document.doc.destroy();
		}
	}
});
