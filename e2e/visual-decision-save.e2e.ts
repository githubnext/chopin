import { SQL } from "bun";
import { expect } from "./room";
import {
	card,
	durableState,
	openWire,
	showDecisions,
	state,
	test,
} from "./visual-decision.helpers";

async function rejectSavedCommit(channelId: string) {
	let sql = new SQL(process.env.E2E_DATABASE_URL_0!);
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS visual_e2e_commit_control (
			channel_id uuid PRIMARY KEY
		);
		CREATE OR REPLACE FUNCTION visual_e2e_commit_control_fn() RETURNS trigger AS $$
		DECLARE sidecar jsonb;
		BEGIN
			sidecar := CASE jsonb_typeof(NEW.sidecar)
				WHEN 'string' THEN (NEW.sidecar #>> '{}')::jsonb
				ELSE NEW.sidecar
			END;
			IF EXISTS (SELECT 1 FROM visual_e2e_commit_control c
				WHERE c.channel_id::text = NEW.channel_id)
				AND EXISTS (
					SELECT 1 FROM jsonb_array_elements(
						COALESCE(sidecar->'visualDecisions', '[]'::jsonb)
					) item WHERE item ? 'saved'
				) THEN
				RAISE EXCEPTION 'visual E2E transaction deliberately aborted' USING ERRCODE = '40001';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		DROP TRIGGER IF EXISTS visual_e2e_commit_control_trigger ON channel_state;
		CREATE TRIGGER visual_e2e_commit_control_trigger BEFORE UPDATE ON channel_state
		FOR EACH ROW EXECUTE FUNCTION visual_e2e_commit_control_fn();
	`);
	await sql`INSERT INTO visual_e2e_commit_control VALUES (${channelId})`;
	return {
		async release() {
			await sql`DELETE FROM visual_e2e_commit_control WHERE channel_id = ${channelId}`;
		},
		async close() {
			await sql`DELETE FROM visual_e2e_commit_control WHERE channel_id = ${channelId}`;
			await sql.unsafe(
				"DROP TRIGGER IF EXISTS visual_e2e_commit_control_trigger ON channel_state;"
					+ " DROP FUNCTION IF EXISTS visual_e2e_commit_control_fn();",
			);
			await sql.close();
		},
	};
}

test("a rolled-back Save publishes neither attribution nor values and remains retryable", async ({ join, room }) => {
	let ana = await join("ana");
	await showDecisions(ana);
	let billing = card(ana, "Billing card");
	await expect(billing.locator('[data-visual-preview-state="ready"]')).toBeVisible();
	let id = (await billing.getAttribute("data-visual-decision"))!;
	await openWire(ana, room);
	await billing.getByRole("textbox", { name: "Accent colour", exact: true }).fill("#CCDDEE");
	let save = billing.getByRole("button", { name: "Save decision", exact: true });
	await expect(save).toBeEnabled();
	let before = await state(ana, id);
	let durableBefore = await durableState(room);
	let reject = await rejectSavedCommit(room);
	try {
		await save.click();
		await expect(billing.getByRole("alert")).toBeVisible();
		await expect(save).toBeEnabled();
		expect(await state(ana, id)).toEqual(before);
		expect(await durableState(room)).toEqual(durableBefore);
		await expect(billing).not.toContainText("@ana");
		await reject.release();
		await billing.getByRole("textbox", { name: "Accent colour", exact: true }).fill("#AABBCC");
		await expect(save).toBeEnabled();
		await save.click();
		await expect(billing).toContainText("@ana");
		expect((await state(ana, id)).saved?.values.accentColor).toBe("#AABBCC");
	} finally {
		await reject.close();
	}
});
