import type { Investigation } from "@chopin/experiment/records";
import type { InitialChannel, Lease } from "./model";

/** The child document a completed investigation is published as. */
export type InvestigationChildInput = {
	title: string;
	initial: InitialChannel;
	now: Date;
};

export interface ExperimentStore {
	get(id: string): Promise<Investigation | undefined>;
	list(documentId: string): Promise<Investigation[]>;
	active(): Promise<Investigation[]>;
	/** The investigation a child document was published from. */
	published(childId: string): Promise<Investigation | undefined>;
	/** Revision-checked, writer-fenced replacement. False means the revision changed. */
	save(value: Investigation, expected: number | undefined, lease: Lease): Promise<boolean>;
	/**
	 * Save a completed investigation and create its child document in one fenced commit. A record
	 * that already links a child is returned unchanged; false means the revision changed. A spike
	 * lands only as its callout and is refused.
	 */
	publish(
		value: Investigation,
		expected: number,
		child: InvestigationChildInput,
		lease: Lease,
	): Promise<Investigation | false>;
}
