export function HostedLogin() {
	let href = githubLoginHref(location.pathname, location.search, location.hash);
	return (
		<div className="grid h-full bg-ground lg:grid-cols-[1.15fr_0.85fr]" data-hosted="">
			<section className="flex items-end bg-text-primary p-6 text-page sm:p-10 lg:p-16">
				<div className="max-w-xl pb-8">
					<p className="text-sm font-semibold text-brand-wash">Chopin</p>
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
					<p className="mt-2 text-sm text-text-secondary">
						Sign in with GitHub to open your projects and documents.
					</p>
					<a className="btn btn-md btn-primary mt-6 w-full" href={href}>
						Continue with GitHub
					</a>
				</div>
			</section>
		</div>
	);
}

export function githubLoginHref(pathname: string, search = "", hash = ""): string {
	let parameters = new URLSearchParams({ return_to: `${pathname}${search}${hash}` });
	return `/auth/github?${parameters}`;
}
