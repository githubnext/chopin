import { expect } from "./room";
import {
	card,
	createDecision,
	database,
	openWire,
	showDecisions,
	state,
	test,
} from "./visual-decision.helpers";

async function rejectPaddingEdit(channelId: string, decisionId: string) {
	let sql = database();
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS visual_e2e_retry_control (
			channel_id uuid PRIMARY KEY, decision_id text NOT NULL
		);
		CREATE OR REPLACE FUNCTION visual_e2e_retry_control_fn() RETURNS trigger AS $$
		DECLARE rejected_id text; sidecar jsonb;
		BEGIN
			SELECT c.decision_id INTO rejected_id FROM visual_e2e_retry_control c
			WHERE c.channel_id::text = NEW.channel_id;
			sidecar := CASE jsonb_typeof(NEW.sidecar)
				WHEN 'string' THEN (NEW.sidecar #>> '{}')::jsonb
				ELSE NEW.sidecar
			END;
			IF rejected_id IS NOT NULL AND EXISTS (
				SELECT 1 FROM jsonb_array_elements(COALESCE(sidecar->'visualDecisions', '[]'::jsonb)) item
				WHERE item->>'id' = rejected_id AND NOT (item ? 'saved')
				AND item->'values'->>'optionPadding' = '8'
			) THEN
				RAISE EXCEPTION 'visual E2E draft edit deliberately aborted' USING ERRCODE = '40001';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		DROP TRIGGER IF EXISTS visual_e2e_retry_control_trigger ON channel_state;
		CREATE TRIGGER visual_e2e_retry_control_trigger BEFORE UPDATE ON channel_state
		FOR EACH ROW EXECUTE FUNCTION visual_e2e_retry_control_fn();
	`);
	await sql`INSERT INTO visual_e2e_retry_control VALUES (${channelId}, ${decisionId})`;
	return {
		async clear() {
			await sql`DELETE FROM visual_e2e_retry_control WHERE channel_id = ${channelId}`;
		},
		async close() {
			await sql`DELETE FROM visual_e2e_retry_control WHERE channel_id = ${channelId}`;
			await sql.unsafe(
				"DROP TRIGGER IF EXISTS visual_e2e_retry_control_trigger ON channel_state; DROP FUNCTION IF EXISTS visual_e2e_retry_control_fn();",
			);
			await sql.close();
		},
	};
}

test("a peer edit preserves Retry after a rejected local edit and retry unlocks Save", async ({ join, room }) => {
	let ana = await join("ana");
	let id = await createDecision(ana);
	await openWire(ana, room);
	let ben = await join("ben");
	await showDecisions(ben);
	let save = card(ana).getByRole("button", { name: "Save decision", exact: true });
	let retry = card(ana).getByRole("button", { name: "Try again", exact: true });
	let control = await rejectPaddingEdit(room, id);
	try {
		await card(ana).getByRole("slider", { name: "Option vertical padding", exact: true }).focus();
		await ana.keyboard.press("End");
		await expect(card(ana).getByRole("alert")).toContainText("waiting to sync");
		await expect(retry).toBeEnabled();
		await expect(save).toBeDisabled();
		expect((await state(ana, id)).values.optionPadding).toBe(6);
		await control.clear();
		await card(ben).getByRole("textbox", { name: "Selected-option colour", exact: true }).fill(
			"#CCDDEE",
		);
		let preview = card(ana).frameLocator('iframe[title="Adjusted decision card"]');
		await expect.poll(() =>
			preview.locator("body").evaluate(element =>
				getComputedStyle(element.ownerDocument.documentElement)
					.getPropertyValue("--visual-selected-color").trim()
			)
		).toBe("#CCDDEE");
		await expect(retry).toBeEnabled();
		await expect(save).toBeDisabled();
		await retry.click();
		await expect(retry).toHaveCount(0);
		await expect(save).toBeEnabled();
		expect((await state(ana, id)).values).toEqual({
			optionPadding: 8,
			selectedColor: "#CCDDEE",
		});
		await save.click();
		await expect(card(ana)).toContainText("@ana");
	} finally {
		await control.close();
	}
});
