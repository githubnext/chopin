import { content, expect, ready, test } from "./room";
import { openJevWire, sendChat, wireFrames } from "./jev-wire";
import { resetPlannerJobs, scriptJob } from "./planner-jobs";

test.beforeEach(resetPlannerJobs);
test.afterEach(resetPlannerJobs);

test("a successful heading job preserves its decision card for both collaborators and reload", async ({ join, room }) => {
	await scriptJob("heading", [{
		tool: "draft_heading",
		args: {
			revision: "$revision",
			title: "Pilot release",
			goal: "Evaluate a small pilot before a wider release.",
		},
	}]);
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await sendChat(ana, "Should we ship a small pilot?");
	await expect.poll(async () => {
		let frame = (await wireFrames(ana)).findLast(frame =>
			frame.kind === "conversation-plan:jobs" || frame.kind === "conversation-plan:snapshot"
		);
		return (frame?.jobs as Array<{ kind: string; status: string }> | undefined)
			?.find(job => job.kind === "heading")?.status;
	}).toBe("done");
	for (let page of [ana, bo]) {
		await expect(content(page).getByRole("heading", { name: "Pilot release", exact: true }))
			.toBeVisible();
		await expect(content(page)).toContainText("Evaluate a small pilot before a wider release.");
		await expect(page.getByRole("heading", { name: "Should we ship a small pilot?", exact: true }))
			.toBeVisible();
	}
	await bo.reload();
	await ready(bo);
	await expect(content(bo).getByRole("heading", { name: "Pilot release", exact: true }))
		.toBeVisible();
	await expect(content(bo).getByRole("heading", { name: "Pilot release", exact: true }))
		.toHaveCount(1);
	await expect(content(bo)).toContainText("Evaluate a small pilot before a wider release.");
	await expect(bo.getByRole("heading", { name: "Should we ship a small pilot?", exact: true }))
		.toBeVisible();
});
