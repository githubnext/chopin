import * as Service from "./service";

type Dependencies = {
	withDocumentLock: <T>(id: string, action: () => Promise<T>) => Promise<T>;
	opened: (id: string) => Service.Plan | undefined;
	wake: (plan: Service.Plan) => void;
	relink?: (id: string) => Promise<void>;
	refreshSpikes: (id: string) => Promise<unknown> | undefined;
	onError: (message: string, error: unknown) => void;
};

/** The production lock-release callback, independent of optional live-build/spike work. */
export function createEditingUnlocked(deps: Dependencies): (id: string) => void {
	return id => {
		void deps.withDocumentLock(id, async () => {
			let opened = deps.opened(id);
			if (!opened) return;
			await Service.exclusive(opened, () => Service.activateTitles(opened));
			deps.wake(opened);
		}).catch(err => deps.onError("chopin: could not initialize unlocked document title -", err));
		if (deps.relink) {
			void deps.relink(id).catch(err =>
				deps.onError("chopin: could not re-link decisions after a build -", err)
			);
		}
		// Spike callouts the lock deferred land now.
		void deps.refreshSpikes(id);
	};
}
