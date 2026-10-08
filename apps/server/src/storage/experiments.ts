import type { Investigation } from "@chopin/experiment/records";
import type { Lease } from "./model";

export interface ExperimentStore {
	get(id: string): Promise<Investigation | undefined>;
	list(documentId: string): Promise<Investigation[]>;
	active(): Promise<Investigation[]>;
	/** Revision-checked, writer-fenced replacement. False means the revision changed. */
	save(value: Investigation, expected: number | undefined, lease: Lease): Promise<boolean>;
}
