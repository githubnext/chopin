import { lazy, Suspense, useEffect, useState } from "react";

import * as Api from "./api";
import { actorResolutionNeeded } from "./active-actor";
import { HostedApp, HostedFailure, HostedLoading, hostedRoute } from "./hosted";
import { clearRepositoryCache } from "./repository-cache";

let loadHostedLogin = () => import("./hosted-login");
let HostedLogin = lazy(() => loadHostedLogin().then(module => ({ default: module.HostedLogin })));
let LocalLogin = lazy(() =>
	import("./local-login").then(module => ({ default: module.LocalLogin }))
);

export function App() {
	let [session, setSession] = useState<Api.Session>();
	let [error, setError] = useState<unknown>();
	let [repositoryCacheReady, setRepositoryCacheReady] = useState(false);

	useEffect(() => {
		let active = true;
		// Fetch the sign-in page beside the session so a signed-out visit does not wait on
		// a second round trip; it stays out of the initial bundle.
		void loadHostedLogin().catch(() => {});
		Api.session().then(value => {
			if (active) setSession(value);
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (!session) return;
		let active = true;
		let roster = session.user ? session.demo?.actors ?? [] : [];
		(async () => {
			if (actorResolutionNeeded(location.search, roster.length, sessionStorage)) {
				(await import("./demo-actor")).adoptActor(roster);
			}
			if (!active) return;
			let parameters = new URLSearchParams(location.search);
			let accessChanged = parameters.get("repository_access") === "changed";
			if (!session.user) clearRepositoryCache();
			else if (accessChanged) clearRepositoryCache(session.user.id);
			if (accessChanged) {
				parameters.delete("repository_access");
				let query = parameters.toString();
				history.replaceState(
					null,
					"",
					`${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
				);
			}
			setRepositoryCacheReady(true);
		})().catch(setError);
		return () => {
			active = false;
		};
	}, [session]);

	if (error) {
		return (
			<Suspense fallback={<HostedLoading />}>
				<HostedFailure error={error} />
			</Suspense>
		);
	}
	if (!session || !repositoryCacheReady) {
		let page = hostedRoute(location.pathname).page;
		return (
			<HostedLoading document={page === "document" || page === "child" || page === "channel"} />
		);
	}
	if (!session.user) {
		return (
			<Suspense fallback={<HostedLoading />}>
				{session.auth === "local" ? <LocalLogin /> : <HostedLogin />}
			</Suspense>
		);
	}
	// Signed in, /machines is a page inside the navigation like any other (hosted.tsx).
	return <HostedApp agent={session.agent} user={session.user} />;
}
