/**
 * Opens a stored document sidecar with whichever server this file is run under, and prints what
 * that server restored: `{ ok: true, entries }`, or `{ ok: false, error }` for a sidecar it
 * refuses. `rollback.test.ts` runs it with this checkout and with an older one, so a transcript
 * this server wrote is proved readable by the server it would be rolled back to.
 *
 * It imports only what every version has: the plan service and its test plan.
 */
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

let [path] = process.argv.slice(2);
let stored = JSON.parse(await Bun.file(path!).text());
let context = await openPlan();
await Service.close(context.plan);
let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
let current = (loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<string, unknown>;
await context.storage.collaboration.commit({
	channelId: context.channel.id,
	lease: context.lease,
	expectedRevision: loaded.channel.revision,
	operationId: crypto.randomUUID(),
	epoch: loaded.snapshot!.epoch,
	sidecar: { ...stored, revision: current.revision, documentSeq: current.documentSeq },
	events: [],
	now: context.now,
});
try {
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	console.log(JSON.stringify({ ok: true, entries: restored.chat.entries }));
	await Service.close(restored);
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String((error as Error).message) }));
}
process.exit(0);
