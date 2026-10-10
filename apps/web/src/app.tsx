import { lazy, Suspense, useEffect, useState } from "react";

import * as Api from "./api";
import { HostedApp, HostedFailure, HostedLoading } from "./hosted";
import { clearRepositoryCache } from "./repository-cache";

let loadHostedLogin = () => import("./hosted-login");
let HostedLogin = lazy(() => loadHostedLogin().then(module => ({ default: module.HostedLogin })));
let PairingPage = lazy(() => import("./experiments/pairing"));
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
	}, [session]);

	if (error) {
		return (
			<Suspense fallback={<HostedLoading />}>
				<HostedFailure error={error} />
			</Suspense>
		);
	}
	if (!session || !repositoryCacheReady) return <HostedLoading />;
	if (!session.user) {
		return (
			<Suspense fallback={<HostedLoading />}>
				{session.auth === "local" ? <LocalLogin /> : <HostedLogin />}
			</Suspense>
		);
	}
	if (location.pathname === "/connect") {
		return (
			<Suspense fallback={<HostedLoading />}>
				<PairingPage />
			</Suspense>
		);
	}
	return <HostedApp agent={session.agent} user={session.user} />;
}
