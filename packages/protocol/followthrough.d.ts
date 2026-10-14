/** A published result's durable review by its parent document's Planner. */
export declare namespace Followthrough {
	export type Status = "pending" | "running" | "done" | "failed" | "skipped";
	export type Action = "retry" | "dismiss";
	export type View = {
		readonly id: string;
		readonly revision: number;
		readonly status: Status;
		/** Code-owned state reason; clients map known values and never display it verbatim. */
		readonly reason?: string;
	};
}
