import type { Job, JobOutcome } from "./jobs";
import type { Plan } from "../plan/service";

export type PlannerJobRunner = (
	job: Job,
	prompt: string,
	signal?: AbortSignal,
) => Promise<JobOutcome>;

export type PlannerJobDeps = {
	plan:
		& Pick<
			Plan,
			| "conversationPlanJobs"
			| "conversationPlanPendingEffects"
			| "conversationPlanEffects"
			| "records"
			| "chat"
			| "conversationPlan"
		>
		& Partial<Plan>;
	exclusive: <T>(action: () => Promise<T>) => Promise<T>;
	persist: () => Promise<void>;
	runner: PlannerJobRunner;
	prompt: (job: Job) => string | undefined;
	publishJobs: (jobs: Job[]) => void;
	publishMeta: (questionnaireId: string) => void;
	/** Called under exclusive; must commit the whole plan without acquiring the lock again. */
	activity: (text: string, questionnaireId: string, label?: string) => Promise<void>;
	/** Feature eligibility must not let gated analysis jobs block independent naming. */
	eligible?: (job: Job) => boolean;
	/** Unavailable work stays pending until an actual availability change wakes it. */
	ready?: (job: Job) => Promise<boolean>;
	/** Wake the durable effects outbox after terminal work makes queue space available. */
	onCapacityAvailable?: () => void;
	onError?: (error: unknown) => void;
	now?: () => string;
};
