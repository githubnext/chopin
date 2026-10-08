/** Matches the research composer's own `maxLength`. */
export const MAX_RESEARCH_BRIEF = 4096;

export type ResearchLaunchBlock =
	| "too-long"
	| "drafting"
	| "read-only"
	| "disconnected"
	| "unavailable";

export type ResearchLaunchResult = { ok: true } | { ok: false; reason: ResearchLaunchBlock };

type Launch = {
	check: () => ResearchLaunchResult;
	open: (brief: string) => ResearchLaunchResult;
	reveal: () => boolean;
};

const UNAVAILABLE: ResearchLaunchResult = { ok: false, reason: "unavailable" };

/**
 * Lets a host outside the editor open the document's research composer.
 *
 * The host owns this object; the mounted editor attaches the same draft path
 * the `/` menu uses, so a brief started elsewhere is placed and started there.
 */
export class ResearchLauncher {
	#launch: Launch | undefined;

	attach(launch: Launch): () => void {
		this.#launch = launch;
		return () => {
			if (this.#launch === launch) this.#launch = undefined;
		};
	}

	/** Why a brief could not open now, before the host changes anything. */
	check(brief: string): ResearchLaunchResult {
		if (brief.length > MAX_RESEARCH_BRIEF) return { ok: false, reason: "too-long" };
		return this.#launch?.check() ?? UNAVAILABLE;
	}

	/** Open the composer at the end of the document with `brief` filled in. */
	open(brief: string): ResearchLaunchResult {
		let checked = this.check(brief);
		if (!checked.ok) return checked;
		return this.#launch?.open(brief) ?? UNAVAILABLE;
	}

	/** Focus the research draft that is already open. */
	reveal(): boolean {
		return this.#launch?.reveal() ?? false;
	}
}
