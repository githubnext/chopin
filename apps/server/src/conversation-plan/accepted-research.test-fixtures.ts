import { researchSocket } from "./accepted-research-socket.test-fixtures";
import { researchStorage } from "./accepted-research-storage.test-fixtures";
import * as Plan from "../plan/service";
import { headingMemory } from "../chat/job-heading-memory.test-fixtures";
import { offerResearch } from "./domain";
import { message, proposal } from "./research-offers.test-fixtures";
import { startAcceptedResearch } from "./accepted-research";
import { handleResearchCommand } from "./research-commands";
import type { AuthorizationResult, Socket } from "../wire";
import type { ConversationPlan, Request as Frame } from "@chopin/protocol";

async function noop() {}

export async function acceptedResearchMemory() {
	let h = await headingMemory();
	let auth = h.context.auth;
	let session = await auth.sessions.issue("U_test", {
		accessToken: "consent-token",
		accessExpiresIn: 28_800,
		refreshToken: "consent-refresh",
		refreshExpiresIn: 15_897_600,
	});
	h.context.claimantSessionId = session.id;
	let { ws, frames, closes, data } = researchSocket(h, session);
	let { research, jobs } = researchStorage(h);
	let entry = message("research-consent-source", "Which public evidence supports this API?");
	await Plan.exclusive(h.plan, async () => {
		h.plan.chat.entries.push(entry);
		h.plan.conversationPlan = offerResearch(h.plan.conversationPlan, proposal(entry), entry);
		await Plan.persistExclusive(h.plan);
	});
	let offerId = h.plan.conversationPlan.researchOffers![0]!.id;
	let access: AuthorizationResult = "allowed";
	let unavailable = false;
	let afterPlace: () => Promise<void> = noop;
	let refreshAccess = async () => access;
	let startDeps = {
		research: () => research,
		auth,
		refreshAccess,
		unavailable: () => unavailable,
		ownerAvailable: async () => {
			let binding = await h.context.activeOwner!();
			if (!binding) throw new Error("active owner unavailable");
			binding.release();
			h.runtime.wake(h.plan);
		},
		placeReference: async (_channelId: string, workspaceId: string) => {
			let placed = await Plan.placeResearchReference(h.plan, workspaceId);
			await afterPlace();
			return placed;
		},
		scheduleRecovery: (_deferred: number) => {},
	};
	let deps = {
		enabled: true,
		runtime: h.runtime,
		research: () => research,
		unavailable: () => unavailable,
		refreshAccess,
		start: (
			room: typeof h.room,
			socket: Socket,
			opened: typeof h.plan,
			offer: ConversationPlan.ResearchOffer,
		) => startAcceptedResearch(room, socket, opened, offer, startDeps),
	};
	async function command(
		frame: Frame<ConversationPlan.ResearchConsent | ConversationPlan.ResearchLink>,
	) {
		await handleResearchCommand(frame, h.room, ws, deps);
		return frames.at(-1)!;
	}
	return {
		...h,
		ws,
		frames,
		closes,
		research,
		researchJobs: jobs,
		offerId,
		deps,
		consent: () =>
			command({
				kind: "conversation-plan:research",
				ts: 0,
				rid: "consent",
				offerId,
				choice: "research",
				actionId: "human-consent",
			}),
		resume: () =>
			command({
				kind: "conversation-plan:research",
				ts: 0,
				rid: "resume",
				offerId,
				choice: "resume",
			}),
		link: () => command({ kind: "conversation-plan:research-link", ts: 0, rid: "lookup", offerId }),
		afterPlace(callback: typeof afterPlace) {
			afterPlace = callback;
		},
		setAccess(value: AuthorizationResult) {
			access = value;
		},
		setUnavailable(value: boolean) {
			unavailable = value;
		},
		async member(userId: string, handle: string) {
			await h.opened.storage.users.put({
				id: userId,
				login: handle,
				avatarUrl: "",
				now: new Date(),
			});
			let issued = await auth.sessions.issue(userId, {
				accessToken: "member-token",
				accessExpiresIn: 28_800,
				refreshToken: "member-refresh",
				refreshExpiresIn: 15_897_600,
			});
			data.handle = handle;
			data.principalId = userId;
			data.sessionId = issued.id;
			data.credential = issued.cookie.split(";")[0]!;
		},
		revokeSession: () =>
			auth.sessions.revoke(
				new Request("https://example.test/", {
					headers: { cookie: data.credential },
				}),
			),
	};
}
