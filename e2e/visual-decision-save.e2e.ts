import { expect } from "./room";
import {
	card,
	createDecision,
	database,
	durableProjection,
	durableState,
	openWire,
	request,
	showDecisions,
	state,
	test,
} from "./visual-decision.helpers";

async function interceptCommit(channelId: string, mode: "fail" | "hold") {
	let sql = database();
	let [channel] = await sql<{ channelId: string }[]>`
		SELECT channel_id AS "channelId" FROM channel_state WHERE channel_id = ${channelId}
	`;
	expect(channel?.channelId, "commit interception must use the application's database").toBe(
		channelId,
	);
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS visual_e2e_commit_control (
			channel_id uuid PRIMARY KEY, mode text NOT NULL
		);
		CREATE OR REPLACE FUNCTION visual_e2e_commit_control_fn() RETURNS trigger AS $$
		DECLARE mode text; sidecar jsonb;
		BEGIN
			SELECT c.mode INTO mode FROM visual_e2e_commit_control c
			WHERE c.channel_id::text = NEW.channel_id;
			sidecar := CASE jsonb_typeof(NEW.sidecar)
				WHEN 'string' THEN (NEW.sidecar #>> '{}')::jsonb
				ELSE NEW.sidecar
			END;
			IF mode IS NOT NULL AND EXISTS (
				SELECT 1 FROM jsonb_array_elements(COALESCE(sidecar->'visualDecisions', '[]'::jsonb)) item
				WHERE item ? 'saved'
			) THEN
				IF mode = 'fail' THEN
					RAISE EXCEPTION 'visual E2E transaction deliberately aborted' USING ERRCODE = '40001';
				ELSE
					PERFORM pg_advisory_xact_lock(176831, hashtext(NEW.channel_id::text));
				END IF;
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		DROP TRIGGER IF EXISTS visual_e2e_commit_control_trigger ON channel_state;
		CREATE TRIGGER visual_e2e_commit_control_trigger BEFORE UPDATE ON channel_state
		FOR EACH ROW EXECUTE FUNCTION visual_e2e_commit_control_fn();
	`);
	await sql`INSERT INTO visual_e2e_commit_control VALUES (${channelId}, ${mode})`;
	return {
		sql,
		async clear() {
			await sql`DELETE FROM visual_e2e_commit_control WHERE channel_id = ${channelId}`;
		},
		async close() {
			await sql`DELETE FROM visual_e2e_commit_control WHERE channel_id = ${channelId}`;
			await sql.unsafe(
				"DROP TRIGGER IF EXISTS visual_e2e_commit_control_trigger ON channel_state; DROP FUNCTION IF EXISTS visual_e2e_commit_control_fn();",
			);
			await sql.close();
		},
	};
}

test("a real rolled-back PostgreSQL Save leaves draft, attribution and projection unpublished and retries", async ({ join, room }) => {
	let ana = await join("ana");
	let id = await createDecision(ana);
	await openWire(ana, room);
	await card(ana).getByRole("textbox", { name: "Selected-option colour", exact: true }).fill(
		"#CCDDEE",
	);
	let save = card(ana).getByRole("button", { name: "Save decision", exact: true });
	await expect(save).toBeEnabled();
	let before = await state(ana, id);
	let durableBefore = await durableState(room);
	let projectionBefore = await durableProjection(room);
	expect(durableBefore).toMatchObject({
		visualDecisions: [expect.objectContaining({ id, revision: before.revision })],
	});
	let control = await interceptCommit(room, "fail");
	try {
		await save.click();
		await expect(card(ana).getByRole("alert")).toBeVisible();
		await expect(save).toBeEnabled();
		expect(await state(ana, id)).toEqual(before);
		expect(await durableState(room)).toEqual(durableBefore);
		expect(await durableProjection(room)).toBe(projectionBefore);
		await expect(card(ana)).not.toContainText("Saved by");
		await control.clear();
		await card(ana).getByRole("textbox", { name: "Selected-option colour", exact: true }).fill(
			"#BBCCDD",
		);
		await expect(save).toBeEnabled();
		await save.click();
		await expect(card(ana)).toContainText("@ana");
		expect((await state(ana, id)).saved?.values.selectedColor).toBe("#BBCCDD");
	} finally {
		await control.close();
	}
});

test("Save claims one revision and pauses edits until its durable commit", async ({ join, room }) => {
	let ana = await join("ana");
	let id = await createDecision(ana);
	let ben = await join("ben");
	await showDecisions(ben);
	await openWire(ben, room);
	let before = await state(ben, id);
	let control = await interceptCommit(room, "hold");
	let release!: () => void;
	let acquired!: () => void;
	let locked = new Promise<void>(resolve => acquired = resolve);
	let unlocked = new Promise<void>(resolve => release = resolve);
	let transaction = control.sql.begin(async sql => {
		await sql`SELECT pg_advisory_xact_lock(176831, hashtext(${room}))`;
		acquired();
		await unlocked;
	});
	try {
		await locked;
		await card(ana).getByRole("button", { name: "Save decision", exact: true }).click();
		await expect(card(ana).getByRole("button", { name: /Saving/ })).toBeDisabled();
		await expect.poll(async () => {
			let result = await control.sql<{ count: number }[]>`
				SELECT count(*)::int AS count FROM pg_locks
				WHERE locktype = 'advisory' AND NOT granted AND classid = 176831
				AND objid::bigint = (hashtext(${room})::bigint & 4294967295)
			`;
			return result[0]?.count ?? 0;
		}).toBeGreaterThan(0);
		expect(await request(ben, { kind: "visual-decision:save", id, revision: before.revision }))
			.toMatchObject({ ok: false, reason: "saving" });
		let edit = await request(ben, {
			kind: "visual-decision:edit",
			id,
			key: `${crypto.randomUUID()}:1`,
			patch: { optionPadding: 8 },
		});
		expect(edit).toMatchObject({ ok: false, reason: "saving" });
		expect(await durableState(room)).toMatchObject({
			visualDecisions: [expect.objectContaining({ revision: before.revision })],
		});
		await expect(card(ben)).not.toContainText("Saved by");
		release();
		await transaction;
		await expect(card(ana)).toContainText("@ana");
		await expect(card(ben)).toContainText("@ana");
		expect((await state(ben, id)).saved).toMatchObject({
			revision: before.revision,
			values: before.values,
		});
	} finally {
		release();
		await transaction;
		await control.close();
	}
});
