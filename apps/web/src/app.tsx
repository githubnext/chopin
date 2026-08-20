import { useEffect, useState } from "react";

import * as Api from "./api";
import { HostedApp, HostedFailure, HostedLoading, HostedLogin } from "./hosted";
import { clearRepositoryCache } from "./repository-cache";

export function App() {
	let [session, setSession] = useState<Api.Session>();
	let [error, setError] = useState<unknown>();
	let [repositoryCacheReady, setRepositoryCacheReady] = useState(false);

	useEffect(() => {
		let active = true;
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

	if (error) return <HostedFailure error={error} />;
	if (!session || !repositoryCacheReady) return <HostedLoading />;
	if (!session.user) return <HostedLogin />;
	return <HostedApp agent={session.agent} user={session.user} />;
}
