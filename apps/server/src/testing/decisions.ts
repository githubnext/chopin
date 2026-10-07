import * as Question from "@chopin/question";

import { createHumanInput } from "../harness/atomic/human-input";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { MemoryStorage } from "../storage/memory/adapter";

import type { Server } from "bun";
import type { HostInputOptions } from "@bastani/atomic";
import type { DocumentRoom } from "../agent/tools";
import type { Socket, SocketData } from "../wire";

/** A room whose Decisions answer Atomic HostInput requests, with a member to answer them. */
export async function hostInputRoom(
	expiresInMs?: number,
	hold?: (workflowRunId: string, signal: AbortSignal) => Promise<void>,
) {
	let storage = new MemoryStorage();
	let now = new Date();
	await storage.users.put({ id: "user", login: "reader", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_test",
		repositoryOwner: "org",
		repositoryName: "repo",
		title: "Questions",
		createdBy: "user",
		now,
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let frames: any[] = [];
	let server = {
		publish(_topic: string, frame: string) {
			frames.push(JSON.parse(frame));
		},
	} as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, server);
	let room = {
		id: channel.id,
		plan,
		server,
		anchors() {},
	} as DocumentRoom;
	let ws = {
		data: { handle: "reader", room: channel.id, client: "client" },
		send(frame: string) {
			frames.push(JSON.parse(frame));
		},
		publish(_topic: string, frame: string) {
			frames.push(JSON.parse(frame));
		},
	} as unknown as Socket;
	let controller = new AbortController();
	let options: HostInputOptions = {
		requestId: "request",
		sessionId: "session",
		signal: controller.signal,
	};
	let input = createHumanInput(room, expiresInMs, hold);
	async function cards(count: number) {
		for (let deadline = Date.now() + 4_000; Date.now() < deadline; await Bun.sleep(5)) {
			if (Store.outstanding(plan.questions).length === count) {
				return Store.outstanding(plan.questions);
			}
		}
		throw new Error("question did not arrive");
	}
	function refused(rid: string) {
		let frame = frames.findLast(frame => frame.rid === rid);
		if (frame?.accepted === false || frame?.ok === false || frame?.kind === "session:error") {
			throw new Error(frame.message ?? frame.reason);
		}
	}
	/** A member adds an option to the card's first question, the way Decisions offers written answers. */
	async function addOption(id: string, label: string) {
		let question = Store.get(plan.questions, id)!.definition.questions[0]!;
		await Questions.addOption(plan, server, channel.id, ws, {
			kind: "question:option",
			rid: "option",
			ts: 0,
			id,
			question: question.id,
			key: crypto.randomUUID(),
			label,
		});
		refused("option");
		return Store.get(plan.questions, id)!.definition.questions[0]!.options.length - 1;
	}
	async function answer(id: string, value: number[] | string) {
		let opened = Store.snapshot(plan.questions, id);
		if (!opened.open) throw new Error("question closed");
		let definition = Store.get(plan.questions, id)!.definition;
		let model = Question.restore(opened.model, definition);
		let question = definition.questions[0];
		if (typeof value === "string") {
			model.api.val([question.id, "mode"]).set("custom");
			if (value) model.api.str([question.id, "custom"]).ins(0, value);
		} else if (question.multiple) {
			model.api.val([question.id, "mode"]).set("choices");
			let held =
				(model.view() as Record<string, { options?: Record<string, boolean> }>)[question.id]
					?.options ?? {};
			for (let index of value) {
				let option = question.options[index]!.id;
				// An option appended after the draft began has no register yet, as in the client.
				if (Object.hasOwn(held, option)) model.api.val([question.id, "options", option]).set(true);
				else {model.api.obj([question.id, "options"]).set({
						[option]: Question.crdt.schema.val(Question.crdt.schema.con(true)),
					});}
			}
		} else {
			model.api.val([question.id, "mode"]).set("choices");
			model.api.val([question.id, "choice"]).set(question.options[value[0]!]!.id);
		}
		let patch = model.api.flush();
		if (patch) {
			await Questions.edit(plan, ws, {
				kind: "question:edit",
				rid: "edit",
				ts: 0,
				id,
				patch: [...patch.toBinary()],
			});
			refused("edit");
		}
		let current = Store.snapshot(plan.questions, id);
		if (!current.open) throw new Error("question closed");
		await Questions.submit(plan, server, channel.id, ws, {
			kind: "question:submit",
			rid: "submit",
			ts: 0,
			id,
			revision: current.revision,
		});
		refused("submit");
	}
	return {
		input,
		plan,
		storage,
		frames,
		controller,
		options,
		cards,
		answer,
		addOption,
		ws,
		server,
		room,
		close: () => Plan.close(plan),
	};
}
