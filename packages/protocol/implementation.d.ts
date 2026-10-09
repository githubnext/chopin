import type { Plan } from "./plan";

export type CheckoutContext = { repository: string; branch?: string; commit: string };
export type BuildRequest = {
	id: string;
	user: string;
	connectionId: string;
	repositoryId: string;
	checkout: CheckoutContext;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	createdAt: string;
	expiresAt: number;
	state: "queued" | "starting" | "running" | "stopped" | "failed";
	session?: string;
	error?: string;
};
export type ImplementationSnapshot = {
	planRevision: number;
	graph?: {
		number: number;
		revision: number;
		planRevision: number;
		state: "draft" | "approved" | "locked" | "superseded";
		definition: {
			tasks: Array<{
				id: string;
				title: string;
				context: string;
				goal: string;
				acceptance: string[];
				dependsOn: string[];
			}>;
		};
	};
	build?: BuildRequest;
	workspaces: Array<{ id: string; label: string; checkout: CheckoutContext; available: boolean }>;
	blockers: string[];
	lifecycle: Pick<Plan.Lifecycle, "execution" | "activity" | "history">;
};
