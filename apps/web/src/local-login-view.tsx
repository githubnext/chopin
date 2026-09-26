import { LocalConsentDialog } from "./local-consent-dialog";
import { manualFallbackMessage, signInErrorMessage } from "./local-sign-in";

import type { LocalSignInState } from "./local-sign-in";

/**
 * Renders one `LocalSignInState` with no side effects. `local-login.tsx`
 * owns the reducer, `Api.*` calls, the poll timer, and clipboard/tab access;
 * this component only presents whatever state it is given.
 */
export function LocalLoginView(
	{
		onCancel,
		onConsentDecision,
		onCopyAndOpen,
		onStart,
		state,
	}: {
		onCancel: () => void;
		onConsentDecision: (accept: boolean) => void;
		onCopyAndOpen: () => void;
		onStart: () => void;
		state: LocalSignInState;
	},
) {
	return (
		<div className="grid h-full bg-ground lg:grid-cols-[1.15fr_0.85fr]" data-hosted="">
			<section className="flex items-end bg-text-primary p-6 text-page sm:p-10 lg:p-16">
				<div className="max-w-xl pb-8">
					<p className="text-sm font-semibold text-brand-wash">chopin</p>
					<h1 className="mt-4 text-2xl font-semibold">
						Plan together, in the context of the code.
					</h1>
					<p className="mt-5 max-w-lg text-base text-gray-300">
						A shared document, a visible chat, and an agent that can read the repository without
						owning the decision.
					</p>
				</div>
			</section>
			<section className="flex items-center justify-center p-6 sm:p-8">
				<div className="w-full max-w-sm">
					<h2 className="text-xl font-semibold">Open your workspace</h2>
					{state.status === "idle" && (
						<>
							<p className="mt-2 text-sm text-text-secondary">
								Sign in with GitHub to choose a repository and its planning channels.
							</p>
							<button
								className="btn btn-md btn-primary mt-6 w-full"
								onClick={onStart}
								type="button"
							>
								Sign in with GitHub
							</button>
						</>
					)}
					{state.status === "requesting" && (
						<p className="mt-6 text-sm text-text-secondary" role="status">
							Waiting for device code...
						</p>
					)}
					{state.status === "waiting" && (
						<div className="mt-6 space-y-3">
							<p className="text-sm text-text-secondary" role="status">
								Waiting for authorization...
							</p>
							<p className="text-sm">
								Enter one-time code: <strong>{state.userCode}</strong> at{" "}
								<a href={state.verificationUri} rel="noopener noreferrer" target="_blank">
									{state.verificationUri}
								</a>
							</p>
							<button
								className="btn btn-md btn-primary w-full"
								onClick={onCopyAndOpen}
								type="button"
							>
								Copy code and open GitHub
							</button>
							{state.presentationFailure && (
								<p className="text-sm text-warning-ink" role="alert">
									{manualFallbackMessage(
										state.presentationFailure,
										state.verificationUri,
										state.userCode,
									)}
								</p>
							)}
							<button
								className="btn btn-md btn-secondary w-full"
								onClick={onCancel}
								type="button"
							>
								Cancel
							</button>
						</div>
					)}
					{state.status === "consent" && (
						<LocalConsentDialog onDecision={onConsentDecision} path={state.path} />
					)}
					{state.status === "complete" && (
						<p className="mt-6 text-sm text-text-secondary" role="status">
							Signing in...
						</p>
					)}
					{state.status === "cancelled" && (
						<>
							<p className="mt-2 text-sm text-text-secondary">Sign-in was cancelled.</p>
							<button
								className="btn btn-md btn-primary mt-6 w-full"
								onClick={onStart}
								type="button"
							>
								Sign in with GitHub
							</button>
						</>
					)}
					{state.status === "error" && (
						<>
							<p className="mt-2 text-sm text-destructive-ink" role="alert">
								{signInErrorMessage(state.message)}
							</p>
							<div className="mt-6 flex gap-2">
								<button
									className="btn btn-md btn-primary flex-1"
									onClick={onStart}
									type="button"
								>
									Retry
								</button>
								<button
									className="btn btn-md btn-secondary flex-1"
									onClick={onCancel}
									type="button"
								>
									Cancel
								</button>
							</div>
						</>
					)}
				</div>
			</section>
		</div>
	);
}
