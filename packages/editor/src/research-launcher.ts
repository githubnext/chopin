type Launch = {
	available: () => boolean;
	open: (brief: string) => boolean;
};

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

	/** Whether a draft could open now: an editable, connected editor with no draft already open. */
	available(): boolean {
		return this.#launch?.available() ?? false;
	}

	/** Open the composer at the end of the document with `brief` filled in. */
	open(brief: string): boolean {
		return this.#launch?.open(brief) ?? false;
	}
}
