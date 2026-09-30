import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Chat from "./service";
import * as Service from "../plan/service";
import { hosted } from "./notice.test-fixtures";

test("an activity can refer to the document heading", async () => {
	let context = await hosted();
	let entry = await Chat.notice(context.announcer, {
		text: "Chopin drafted the title and goal",
		decision: { questionnaireId: "document", kind: "activity" },
	});
	await Service.close(context.plan);
	let restored = await Service.open(context.channel.id, {
		storage: context.storage,
		lease: () => context.lease,
		fatal: () => {},
	}, context.server);
	expect(restored.chat.entries.at(-1)?.decision).toEqual(entry.decision);
	await Service.close(restored);
});

test("a notice broadcasts the decision metadata that was committed", async () => {
	let context = await hosted();
	let entered: (() => void) | undefined;
	let started = new Promise<void>(resolve => entered = resolve);
	let release: (() => void) | undefined;
	let blocked = new Promise<void>(resolve => release = resolve);
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async input => {
		entered!();
		await blocked;
		return original(input);
	};
	let decision = { questionnaireId: ulid(), kind: "activity" as const, label: "Original" };
	let pending = Chat.notice(context.announcer, { text: "Refined Original", decision });
	await started;
	decision.label = "Changed before broadcast";
	release!();
	let entry = await pending;
	expect(entry.decision?.label).toBe("Original");
	expect(context.frames.findLast(frame => frame.kind === "chat:message")?.entry?.decision)
		.toEqual(entry.decision);
	let loaded = await context.storage.collaboration.load(context.channel.id, context.now);
	let sidecar = loaded?.sidecar ?? loaded?.snapshot?.sidecar;
	expect(JSON.stringify(sidecar)).toContain('"label":"Original"');
	expect(JSON.stringify(sidecar)).not.toContain("Changed before broadcast");
	await Service.close(context.plan);
});

test("concurrent notices broadcast in commit order", async () => {
	let context = await hosted();
	let first = Chat.notice(context.announcer, "first");
	let second = Chat.notice(context.announcer, "second");
	await Promise.all([first, second]);
	expect(context.order).toEqual(["broadcast:first", "broadcast:second"]);
	expect(context.plan.chat.entries.map(entry => entry.text)).toEqual(["first", "second"]);
	await Service.close(context.plan);
});
