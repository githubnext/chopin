import { GitHubIcon } from "@chopin/icons";

import { LocalLoginShell } from "./local-login-shell";

export function HostedLogin() {
	let href = githubLoginHref(location.pathname, location.search, location.hash);
	return (
		<LocalLoginShell>
			<p className="mt-2 text-sm text-text-secondary">
				Sign in with GitHub to open your projects and documents.
			</p>
			<a className="btn btn-md btn-primary mt-6 w-full" href={href}>
				<GitHubIcon />
				Continue with GitHub
			</a>
		</LocalLoginShell>
	);
}

export function githubLoginHref(pathname: string, search = "", hash = ""): string {
	let parameters = new URLSearchParams({ return_to: `${pathname}${search}${hash}` });
	return `/auth/github?${parameters}`;
}
