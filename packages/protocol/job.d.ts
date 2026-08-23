import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export declare namespace Job {
	export type State =
		| "pending"
		| "paused"
		| "running"
		| "completed"
		| "failed"
		| "cancelled"
		| "superseded";

	export type Origin = "scheduler" | "planner" | "user";
	export type ProgressState = "started" | "completed" | "interrupted";

	export type Progress = {
		revision: number;
		attempt: number;
		stage: string;
		label: string;
		state: ProgressState;
		reason?: string;
		createdAt: string;
	};

	export type View = {
		id: string;
		type: string;
		version: number;
		origin: Origin;
		targetKey: string;
		targetGeneration: number;
		state: State;
		revision: number;
		attempts: number;
		failures: number;
		availableAt: string;
		reason?: string;
		progress: Progress[];
		createdAt: string;
		updatedAt: string;
		subject?: string;
	};

	export type Artifact = {
		revision: number;
		value: Json;
		createdAt: string;
	};

	export type Detail = {
		revision: number;
		currentTargetGeneration: number;
		job: View;
		artifact?: Artifact;
	};

	export type Incoming =
		| Request<List.Ask>
		| Request<Get.Ask>
		| Request<Assign.Ask>
		| Request<Cancel.Ask>;

	export type Outgoing = Changed | List.Reply | Get.Reply | Assign.Reply | Cancel.Reply;

	export type Changed = KIND<"job:changed"> & { revision: number };

	export namespace List {
		export type Ask = KIND<"job:list">;
		export type Reply = KIND<"job:list"> & {
			revision: number;
			jobs: View[];
			truncated: boolean;
		};
	}

	export namespace Get {
		export type Ask = KIND<"job:get"> & { id: string };
		export type Reply = KIND<"job:get"> & { detail?: Detail };
	}

	export namespace Assign {
		export type Ask = KIND<"job:assign"> & {
			type: "research-question";
			questionId: string;
			requestId: string;
		};
		export type Reply = KIND<"job:assign"> & { repeated: boolean; job: View };
	}

	export namespace Cancel {
		export type Ask = KIND<"job:cancel"> & { id: string };
		export type Reply = KIND<"job:cancel"> & { job: View };
	}
}
