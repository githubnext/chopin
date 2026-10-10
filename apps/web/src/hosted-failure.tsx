import { documentsPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { WorkspaceNotice } from "./workspace-notice";

function repositoryHref(repository: { owner: string; name: string }): string {
	return documentsPath(repository.owner, repository.name);
}

function failureCopy(
	error: unknown,
	channel: { title?: string; slug?: string } | undefined,
	repository: Pick<Api.Repository, "fullName"> | undefined,
): { body: string; title: string } {
	let status = error instanceof Api.ApiError ? error.status : undefined;
	let where = repository ? ` in ${repository.fullName}` : "";
	if (status === 404) {
		let name = channel?.title ?? channel?.slug;
		return {
			title: "Document not found",
			body: `We couldn't find ${name ? `"${name}"` : "this document"}${where}. `
				+ "It may have been renamed or deleted.",
		};
	}
	if (status === 401 || status === 403) {
		return {
			title: repository ? `You don't have access to ${repository.fullName}` : "No access",
			body: "Ask a repository admin to give you access.",
		};
	}
	return {
		title: "Couldn't open this document",
		body: "Check your connection and try again.",
	};
}

export default function Failure(
	{
		channel,
		error,
		onRetry,
		repository,
	}: {
		channel?: { title?: string; slug?: string };
		error: unknown;
		onRetry?: () => void;
		repository?: Pick<Api.Repository, "owner" | "name" | "fullName">;
	},
) {
	let { body, title } = failureCopy(error, channel, repository);
	let denied = error instanceof Api.ApiError && (error.status === 401 || error.status === 403);
	return (
		<WorkspaceNotice
			actions={
				<>
					{onRetry && (
						<button className="btn btn-md btn-primary" onClick={onRetry} type="button">
							Try again
						</button>
					)}
					{repository && !denied && (
						<a
							className={`btn btn-md ${onRetry ? "btn-ghost" : "btn-primary"}`}
							href={repositoryHref(repository)}
						>
							Open {repository.fullName}
						</a>
					)}
					{(!repository || denied) && !onRetry && (
						<a className="btn btn-md btn-primary" href="/">Go to Chopin</a>
					)}
				</>
			}
			body={body}
			title={title}
		/>
	);
}
