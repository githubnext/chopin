import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";
import type { DeferredTurnOutcome, Lease, NewDeferredTurn } from "./model";
import type { StorageAdapter } from "./port";

const AT = new Date("2026-01-04T03:04:05.000Z");

function later(seconds: number): Date {
	return new Date(AT.getTime() + seconds * 1_000);
}

function turn(documentId: string, overrides: Partial<NewDeferredTurn> = {}): NewDeferredTurn {
	return {
		id: id("turn"),
		documentId,
		requestId: id("request"),
		kind: "composer",
		handle: "mona",
		userId: id("user"),
		text: "@chopin please tighten the introduction",
		references: [],
		createdAt: AT,
		...overrides,
	};
}

async function failure(attempt: Promise<unknown>) {
	let error = await attempt.then(() => undefined, err => err);
	expect(error).toBeInstanceOf(StorageError);
	return (error as StorageError).failure;
}

/** Two processes of one deployment: the second takes the named lease after the first lets go. */
async function successor(storage: StorageAdapter) {
	let name = id("writer");
	let first = (await storage.leases.acquire(name, "first", 60_000))!;
	return {
		first,
		async takeOver(): Promise<Lease> {
			await storage.leases.release(first);
			return (await storage.leases.acquire(name, "second", 60_000))!;
		},
	};
}

function inserted(outcome: DeferredTurnOutcome) {
	expect(outcome).toMatchObject({ action: "insert", status: "inserted" });
	return (outcome as Extract<DeferredTurnOutcome, { action: "insert" }>).turn;
}

export function deferredTurnContract(name: string, factory: StorageFactory) {
	describe(`${name} deferred Planner turns`, () => {
		test("keeps an acknowledged request as a waiting row with everything its turn needs", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let input = turn(channelId, {
					kind: "comment",
					text: "",
					references: [{ path: "docs/design.md", ranges: [[1, 4]] }],
					delivery: { destination: "planner", requestFingerprint: "sha256:abc" },
					focusChannelId: id("child"),
					focusTitle: "A research child",
					threadId: id("thread"),
					threadChannelId: id("child"),
					planRevision: 7,
					claimantSessionId: id("session"),
					ownerSessionIdAtAccept: id("owner-session"),
				});
				let saved = inserted(await storage.deferredTurns.insert(lease, input));
				expect(saved).toEqual({ ...input, state: "waiting", fencing: lease.fencing });
				expect(await storage.deferredTurns.get(channelId, input.requestId)).toEqual(saved);
				expect(await storage.deferredTurns.list(channelId)).toEqual([saved]);

				let bare = turn(channelId, { createdAt: later(1) });
				let plain = inserted(await storage.deferredTurns.insert(lease, bare));
				expect(plain).toEqual({ ...bare, state: "waiting", fencing: lease.fencing });
				expect("delivery" in plain).toBe(false);
				expect("resolvedAt" in plain).toBe(false);

				let copy = (await storage.deferredTurns.get(channelId, input.requestId))!;
				copy.references.push("changed");
				copy.createdAt.setTime(0);
				expect(await storage.deferredTurns.get(channelId, input.requestId)).toEqual(saved);
			} finally {
				await storage.close();
			}
		});

		test("answers a request it already has with the first row, and scopes request ids to a document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let other = (await userAndChannel(storage)).channelId;
				let first = turn(channelId);
				let saved = inserted(await storage.deferredTurns.insert(lease, first));
				let again = await storage.deferredTurns.insert(
					lease,
					turn(channelId, {
						requestId: first.requestId,
						text: "a different retry",
						createdAt: later(5),
					}),
				);
				expect(again).toEqual({ action: "insert", status: "repeated", turn: saved });
				expect(await storage.deferredTurns.list(channelId)).toEqual([saved]);

				let elsewhere = await storage.deferredTurns.insert(
					lease,
					turn(other, { requestId: first.requestId }),
				);
				expect(elsewhere).toMatchObject({ action: "insert", status: "inserted" });
				expect(await storage.deferredTurns.list(other)).toHaveLength(1);
			} finally {
				await storage.close();
			}
		});

		test("lists a document's rows in the order they were accepted, by state, and finds documents with open ones", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let quiet = (await userAndChannel(storage)).channelId;
				let rows = [
					turn(channelId, { createdAt: later(2) }),
					turn(channelId, { createdAt: later(1), kind: "draft" }),
					turn(channelId, { createdAt: later(1), kind: "invoke_system" }),
					turn(channelId, { createdAt: later(1), kind: "invoke_planner" }),
				];
				for (let row of rows) await storage.deferredTurns.insert(lease, row);
				expect((await storage.deferredTurns.list(channelId)).map(row => row.id)).toEqual([
					rows[1]!.id,
					rows[2]!.id,
					rows[3]!.id,
					rows[0]!.id,
				]);

				await storage.deferredTurns.transition(lease, {
					id: rows[2]!.id,
					from: "waiting",
					to: "started",
					at: later(3),
				});
				await storage.deferredTurns.transition(lease, {
					id: rows[3]!.id,
					from: "waiting",
					to: "cancelled",
					at: later(3),
				});
				let ids = async (states?: Parameters<typeof storage.deferredTurns.list>[1]) =>
					(await storage.deferredTurns.list(channelId, states)).map(row => row.id);
				expect(await ids(["waiting"])).toEqual([rows[1]!.id, rows[0]!.id]);
				expect(await ids(["started", "cancelled"])).toEqual([rows[2]!.id, rows[3]!.id]);
				expect(await ids([])).toEqual([]);
				expect(await ids(["ended"])).toEqual([]);

				let open = await storage.deferredTurns.documents(["waiting", "started"]);
				expect(open).toContain(channelId);
				expect(open).not.toContain(quiet);
				expect(await storage.deferredTurns.documents([])).toEqual([]);
				expect(await storage.deferredTurns.documents(["cancelled"])).toContain(channelId);
			} finally {
				await storage.close();
			}
		});

		test("refuses a request for a document that does not exist", async () => {
			let storage = await openedStorage(factory);
			try {
				let { lease } = await userAndChannel(storage);
				expect(await failure(storage.deferredTurns.insert(lease, turn(id("nowhere"))))).toBe(
					"missing",
				);
			} finally {
				await storage.close();
			}
		});

		test("moves a row only along the legal transitions, recording where and when", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let started = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				let move = (row: { id: string }, from: string, to: string, at = later(10)) =>
					storage.deferredTurns.transition(lease, { id: row.id, from, to, at } as never);

				let running = await move(started, "waiting", "started");
				expect(running).toMatchObject({
					action: "transition",
					changed: true,
					turn: { state: "started", fencing: lease.fencing },
				});
				expect("resolvedAt" in (running as { turn: object }).turn).toBe(false);
				let done = await move(started, "started", "ended", later(11));
				expect(done).toMatchObject({
					changed: true,
					turn: { state: "ended", resolvedAt: later(11) },
				});

				let interrupted = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				await move(interrupted, "waiting", "started");
				expect(await move(interrupted, "started", "interrupted", later(12))).toMatchObject({
					changed: true,
					turn: { state: "interrupted", resolvedAt: later(12) },
				});

				let cancelled = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				expect(await move(cancelled, "waiting", "cancelled", later(13))).toMatchObject({
					changed: true,
					turn: { state: "cancelled", resolvedAt: later(13) },
				});
				// Cancelled by Chopin, it keeps why; one cancelled by its sender, or any other move, none.
				let reasoned = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				let outcome = await storage.deferredTurns.transition(lease, {
					id: reasoned.id,
					from: "waiting",
					to: "cancelled",
					at: later(14),
					reason: "unavailable",
				});
				expect(outcome).toMatchObject({ changed: true, turn: { cancelReason: "unavailable" } });
				expect((await storage.deferredTurns.get(channelId, reasoned.requestId))?.cancelReason)
					.toBe("unavailable");
				expect((await storage.deferredTurns.get(channelId, cancelled.requestId))?.cancelReason)
					.toBeUndefined();
				let reasonless = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				await storage.deferredTurns.transition(lease, {
					id: reasonless.id,
					from: "waiting",
					to: "started",
					at: later(15),
					reason: "agent",
				});
				expect((await storage.deferredTurns.get(channelId, reasonless.requestId))?.cancelReason)
					.toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("changes nothing for an illegal pair, a row in another state, or a row that is not there", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let waiting = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				let started = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				await storage.deferredTurns.transition(lease, {
					id: started.id,
					from: "waiting",
					to: "started",
					at: later(1),
				});
				let finished = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				await storage.deferredTurns.transition(lease, {
					id: finished.id,
					from: "waiting",
					to: "cancelled",
					at: later(1),
				});
				let before = await storage.deferredTurns.list(channelId);
				let attempt = (row: { id: string }, from: string, to: string) =>
					storage.deferredTurns.transition(lease, { id: row.id, from, to, at: later(20) } as never);

				for (
					let [from, to] of [["waiting", "ended"], ["waiting", "interrupted"], [
						"waiting",
						"waiting",
					]]
				) {
					expect(await attempt(waiting, from!, to!)).toMatchObject({
						changed: false,
						reason: "illegal",
						turn: { id: waiting.id, state: "waiting" },
					});
				}
				for (
					let [from, to] of [["started", "cancelled"], ["started", "waiting"], [
						"started",
						"started",
					]]
				) {
					expect(await attempt(started, from!, to!)).toMatchObject({
						changed: false,
						reason: "illegal",
					});
				}
				for (let to of ["waiting", "started", "ended", "interrupted"]) {
					expect(await attempt(finished, "cancelled", to)).toMatchObject({
						changed: false,
						reason: "illegal",
					});
				}
				// A legal pair that names the wrong current state.
				expect(await attempt(waiting, "started", "ended")).toMatchObject({
					changed: false,
					reason: "state",
					turn: { state: "waiting" },
				});
				expect(await attempt(started, "waiting", "started")).toMatchObject({
					changed: false,
					reason: "state",
					turn: { state: "started" },
				});
				expect(await attempt(finished, "waiting", "started")).toMatchObject({
					changed: false,
					reason: "state",
					turn: { state: "cancelled" },
				});
				expect(await attempt({ id: id("none") }, "waiting", "started")).toEqual({
					action: "transition",
					changed: false,
					reason: "missing",
				});
				expect(await storage.deferredTurns.list(channelId)).toEqual(before);
			} finally {
				await storage.close();
			}
		});

		test("lets a row start only once however many processes try", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let row = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				let results = await Promise.all(
					Array.from({ length: 5 }, () =>
						storage.deferredTurns.transition(lease, {
							id: row.id,
							from: "waiting",
							to: "started",
							at: later(1),
						})),
				);
				expect(results.filter(result => "changed" in result && result.changed)).toHaveLength(1);
				expect(results.filter(result => "reason" in result && result.reason === "state"))
					.toHaveLength(4);
			} finally {
				await storage.close();
			}
		});

		test("is written only under the writer lease", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let stale = { ...lease, fencing: lease.fencing + 1 };
				let row = inserted(await storage.deferredTurns.insert(lease, turn(channelId)));
				expect(await failure(storage.deferredTurns.insert(stale, turn(channelId)))).toBe(
					"conflict",
				);
				expect(
					await failure(storage.deferredTurns.transition(stale, {
						id: row.id,
						from: "waiting",
						to: "started",
						at: later(1),
					})),
				).toBe("conflict");
				expect(await failure(storage.deferredTurns.interruptStale(stale, later(1)))).toBe(
					"conflict",
				);
				expect(await storage.deferredTurns.list(channelId)).toEqual([row]);
			} finally {
				await storage.close();
			}
		});

		test("lets the next lease holder interrupt what the last one started, and never end it", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId } = await userAndChannel(storage);
				let other = (await userAndChannel(storage)).channelId;
				let processes = await successor(storage);
				let old = processes.first;
				let running = inserted(await storage.deferredTurns.insert(old, turn(channelId)));
				let elsewhere = inserted(await storage.deferredTurns.insert(old, turn(other)));
				let waiting = inserted(
					await storage.deferredTurns.insert(old, turn(channelId, { createdAt: later(1) })),
				);
				let finished = inserted(await storage.deferredTurns.insert(old, turn(channelId)));
				for (let row of [running, elsewhere, finished]) {
					await storage.deferredTurns.transition(old, {
						id: row.id,
						from: "waiting",
						to: "started",
						at: later(2),
					});
				}
				await storage.deferredTurns.transition(old, {
					id: finished.id,
					from: "started",
					to: "ended",
					at: later(3),
				});

				let next = await processes.takeOver();
				expect(next.fencing).toBe(old.fencing + 1);
				// The old process can no longer write at all.
				expect(
					await failure(storage.deferredTurns.transition(old, {
						id: running.id,
						from: "started",
						to: "ended",
						at: later(4),
					})),
				).toBe("conflict");
				// The new one did not start the turn, so it cannot say that it ended.
				expect(
					await storage.deferredTurns.transition(next, {
						id: running.id,
						from: "started",
						to: "ended",
						at: later(4),
					}),
				).toMatchObject({ changed: false, reason: "state", turn: { state: "started" } });

				let moved = await storage.deferredTurns.interruptStale(next, later(5), channelId);
				expect(moved).toEqual([{
					...running,
					state: "interrupted",
					fencing: next.fencing,
					resolvedAt: later(5),
				}]);
				expect(await storage.deferredTurns.get(other, elsewhere.requestId)).toMatchObject({
					state: "started",
					fencing: old.fencing,
				});
				expect(await storage.deferredTurns.get(channelId, waiting.requestId)).toMatchObject({
					state: "waiting",
				});
				expect(await storage.deferredTurns.get(channelId, finished.requestId)).toMatchObject({
					state: "ended",
				});

				// Across documents it also takes rows other tests left started under their own leases.
				let rest = await storage.deferredTurns.interruptStale(next, later(6));
				expect(rest.map(row => row.id)).toContain(elsewhere.id);
				expect(rest.map(row => row.id)).not.toContain(finished.id);
				expect(await storage.deferredTurns.interruptStale(next, later(7))).toEqual([]);

				// What the new holder starts is its own to end.
				let fresh = inserted(await storage.deferredTurns.insert(next, turn(channelId)));
				await storage.deferredTurns.transition(next, {
					id: fresh.id,
					from: "waiting",
					to: "started",
					at: later(8),
				});
				expect(await storage.deferredTurns.interruptStale(next, later(9), channelId)).toEqual([]);
				expect(
					await storage.deferredTurns.transition(next, {
						id: fresh.id,
						from: "started",
						to: "ended",
						at: later(9),
					}),
				).toMatchObject({ changed: true, turn: { state: "ended" } });
			} finally {
				await storage.close();
			}
		});

		test("keeps at most one waiting row for each comment thread", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let thread = id("thread");
				let note = (overrides: Partial<NewDeferredTurn> = {}) =>
					turn(channelId, { kind: "comment", text: "", threadId: thread, ...overrides });
				let first = inserted(await storage.deferredTurns.insert(lease, note()));

				let folded = await storage.deferredTurns.insert(lease, note({ createdAt: later(1) }));
				expect(folded).toEqual({ action: "insert", status: "thread-waiting", turn: first });
				expect(await storage.deferredTurns.list(channelId)).toEqual([first]);

				// The same thread id in another child, and another thread, each get a row.
				let child = id("child");
				expect(await storage.deferredTurns.insert(lease, note({ threadChannelId: child })))
					.toMatchObject({
						status: "inserted",
					});
				expect(await storage.deferredTurns.insert(lease, note({ threadId: id("thread") })))
					.toMatchObject({
						status: "inserted",
					});
				// A turn that is not a comment note is not held to it.
				expect(
					await storage.deferredTurns.insert(lease, turn(channelId, { threadId: thread })),
				).toMatchObject({ status: "inserted" });

				// Once the row has started or ended, the thread may wait again.
				await storage.deferredTurns.transition(lease, {
					id: first.id,
					from: "waiting",
					to: "started",
					at: later(2),
				});
				expect(await storage.deferredTurns.insert(lease, note({ createdAt: later(3) })))
					.toMatchObject({
						status: "inserted",
					});
			} finally {
				await storage.close();
			}
		});

		test("goes with its document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let row = turn(channelId);
				await storage.deferredTurns.insert(lease, row);
				await storage.channels.archive({ id: channelId, now: AT });
				expect(await storage.channels.delete(channelId)).toBe(true);
				expect(await storage.deferredTurns.get(channelId, row.requestId)).toBeUndefined();
				expect(await storage.deferredTurns.documents(["waiting"])).not.toContain(channelId);
			} finally {
				await storage.close();
			}
		});
	});

	describe(`${name} deferred Planner turns in a commit`, () => {
		function commit(
			storage: StorageAdapter,
			lease: Lease,
			channelId: string,
			input: Partial<Parameters<StorageAdapter["collaboration"]["commit"]>[0]> = {},
		) {
			return storage.collaboration.commit({
				channelId,
				lease,
				expectedRevision: 0,
				operationId: id("operation"),
				epoch: "epoch",
				events: [],
				now: AT,
				...input,
			});
		}

		test("is durable with the entry that acknowledges it, and reports what each change did", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let row = turn(channelId);
				let result = await commit(storage, lease, channelId, {
					sidecar: { acknowledged: row.requestId },
					events: [{ id: id("event"), kind: "chat:entry", payload: {}, createdAt: AT }],
					deferredTurns: [{ action: "insert", turn: row }],
				});
				expect(result).toMatchObject({ revision: 1, repeated: false });
				expect(result.deferredTurns).toEqual([{
					action: "insert",
					status: "inserted",
					turn: { ...row, state: "waiting", fencing: lease.fencing },
				}]);
				expect(await storage.deferredTurns.get(channelId, row.requestId)).toMatchObject({
					state: "waiting",
				});

				let start = await commit(storage, lease, channelId, {
					expectedRevision: 1,
					deferredTurns: [
						{ action: "transition", id: row.id, from: "waiting", to: "started", at: later(1) },
						{ action: "transition", id: row.id, from: "waiting", to: "started", at: later(1) },
						{ action: "transition", id: id("none"), from: "waiting", to: "started", at: later(1) },
					],
				});
				expect(
					start.deferredTurns!.map(outcome =>
						outcome.action === "transition" && outcome.changed ? "moved" : "unchanged"
					),
				).toEqual(["moved", "unchanged", "unchanged"]);
				expect(await storage.deferredTurns.get(channelId, row.requestId)).toMatchObject({
					state: "started",
				});

				let plain = await commit(storage, lease, channelId, { expectedRevision: 2 });
				expect(plain.deferredTurns).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("can belong to another document than the one the commit writes", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId: root, lease } = await userAndChannel(storage);
				let child = (await userAndChannel(storage)).channelId;
				let row = turn(root, {
					kind: "comment",
					text: "",
					threadId: id("thread"),
					threadChannelId: child,
				});
				await commit(storage, lease, child, { deferredTurns: [{ action: "insert", turn: row }] });
				expect(await storage.deferredTurns.list(root)).toHaveLength(1);
				expect(await storage.deferredTurns.list(child)).toEqual([]);
			} finally {
				await storage.close();
			}
		});

		test("is not kept when the commit is refused, whichever part refuses it", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let row = turn(channelId);
				let late = await failure(
					commit(storage, lease, channelId, {
						expectedRevision: 5,
						deferredTurns: [{ action: "insert", turn: row }],
					}),
				);
				expect(late).toBe("conflict");
				let nowhere = await failure(
					commit(storage, lease, channelId, {
						deferredTurns: [{ action: "insert", turn: row }, {
							action: "insert",
							turn: turn(id("nowhere")),
						}],
					}),
				);
				expect(nowhere).toBe("missing");
				let stale = await failure(
					commit(storage, { ...lease, fencing: lease.fencing + 1 }, channelId, {
						deferredTurns: [{ action: "insert", turn: row }],
					}),
				);
				expect(stale).toBe("conflict");
				expect(await storage.deferredTurns.list(channelId)).toEqual([]);
				// Nothing was consumed: the same commit goes through once it is valid.
				expect(
					(await commit(storage, lease, channelId, {
						deferredTurns: [{ action: "insert", turn: row }],
					})).revision,
				).toBe(1);
			} finally {
				await storage.close();
			}
		});

		test("is applied once when the same operation is sent again", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let row = turn(channelId);
				let operationId = id("operation");
				let input = {
					operationId,
					deferredTurns: [{ action: "insert" as const, turn: row }],
				};
				let first = await commit(storage, lease, channelId, input);
				expect(first.deferredTurns).toHaveLength(1);
				let again = await commit(storage, lease, channelId, input);
				expect(again).toMatchObject({ repeated: true, revision: first.revision });
				expect(again.deferredTurns).toBeUndefined();
				expect(await storage.deferredTurns.list(channelId)).toHaveLength(1);

				// A turn the first send moved is not moved a second time by its repeat.
				let start = {
					operationId: id("operation"),
					expectedRevision: 1,
					deferredTurns: [{
						action: "transition" as const,
						id: row.id,
						from: "waiting" as const,
						to: "started" as const,
						at: later(1),
					}],
				};
				await commit(storage, lease, channelId, start);
				let repeat = await commit(storage, lease, channelId, start);
				expect(repeat.repeated).toBe(true);
				expect(await storage.deferredTurns.get(channelId, row.requestId)).toMatchObject({
					state: "started",
					fencing: lease.fencing,
				});
			} finally {
				await storage.close();
			}
		});
	});
}
