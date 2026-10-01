import { expect, test } from "./room";

/** Long enough to be marked: the injector wants twenty characters. */
const PROSE = "Room state lives on disk as MDX beside the transcript.\n";

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

test("a mounted decision card joins the fresh draft after another person saves and it reopens", async ({ join, page, seed }) => {
	await seed(PROSE);
	let questionId: string | undefined;
	let holdPlanUpdates = false;
	let heldUpdates: string[] = [];
	let heldDecidedMeta: string | undefined;
	let sendReopen: ((id: string, rid: string) => void) | undefined;
	let reopenRid: string | undefined;
	let didHoldUpdate!: () => void;
	let updateHeld = new Promise<void>(resolve => didHoldUpdate = resolve);
	let didResolve!: () => void;
	let resolved = new Promise<void>(resolve => didResolve = resolve);
	let didDecide!: () => void;
	let decided = new Promise<void>(resolve => didDecide = resolve);
	let didReopen!: () => void;
	let reopened = new Promise<void>(resolve => didReopen = resolve);
	let didAsk!: () => void;
	let asked = new Promise<void>(resolve => didAsk = resolve);
	let didReply!: () => void;
	let replied = new Promise<void>(resolve => didReply = resolve);

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		sendReopen = (id, rid) =>
			server.send(JSON.stringify({
				kind: "question:reopen",
				id,
				rid,
				ts: Math.floor(Date.now() / 1000),
			}));
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as {
				kind?: string;
				id?: string;
				rid?: string;
				ok?: boolean;
				meta?: { status?: string };
			};
			if (holdPlanUpdates && frame.kind === "plan:update") {
				heldUpdates.push(message);
				didHoldUpdate();
				return;
			}
			if (frame.id === questionId) {
				if (frame.kind === "question:resolved") didResolve();
				if (frame.kind === "question:meta" && frame.meta?.status === "decided") {
					heldDecidedMeta = message;
					didDecide();
					return;
				}
				if (frame.kind === "question:meta" && frame.meta?.status === "reopened") {
					didReopen();
				}
				if (frame.kind === "question:asked") didAsk();
			}
			if (frame.kind === "question:reopen" && frame.rid === reopenRid) {
				expect(frame.ok).toBe(true);
				didReply();
			}
			route.send(message);
		});
	});

	let ben = await join("ben");
	let ana = await join("ana");
	await ben.getByRole("button", { name: /^Decisions/ }).click();
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	let benCard = questionnaire(ben).filter({
		has: ben.getByRole("heading", { name: "Where should room state live?" }),
	});
	let anaCard = questionnaire(ana).filter({
		has: ana.getByRole("heading", { name: "Where should room state live?" }),
	});
	questionId = await benCard.getAttribute("data-plan-sidecar-questionnaire") ?? undefined;
	if (!questionId) throw new Error("questionnaire id missing");
	await benCard.evaluate(element => Reflect.set(window, "__mountedCard", element));
	await expect(benCard.getByRole("radio", { name: /On disk as MDX/ })).not.toBeChecked();

	holdPlanUpdates = true;
	await anaCard.getByText("On disk as MDX", { exact: true }).click();
	await anaCard.getByRole("button", { name: "Save", exact: true }).click();
	await Promise.all([updateHeld, resolved, decided]);
	await expect(benCard).toBeVisible();
	expect(await benCard.evaluate(element => element === Reflect.get(window, "__mountedCard")))
		.toBe(true);

	reopenRid = crypto.randomUUID();
	if (!sendReopen) throw new Error("questionnaire socket missing");
	sendReopen(questionId, reopenRid);
	await Promise.all([replied, reopened, asked]);
	await expect(benCard.getByRole("radio", { name: /On disk as MDX/ })).toBeEnabled();
	expect(await benCard.evaluate(element => element === Reflect.get(window, "__mountedCard")))
		.toBe(true);
	await benCard.getByText("On disk as MDX", { exact: true }).click();
	await expect(benCard.getByRole("radio", { name: /On disk as MDX/ })).toBeChecked();
	await expect(anaCard.getByRole("radio", { name: /On disk as MDX/ })).toBeChecked();
	expect(heldUpdates.length).toBeGreaterThan(0);
	expect(heldDecidedMeta).toBeDefined();
});
