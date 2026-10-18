"""Fetch GitHub threads at full fidelity into the git-ignored raw cache.

Usage: python3 -I fetch.py URL [URL ...]

Each thread is cached under .cache/decisions/<owner>__<repo>__<kind>__<n>.json.
Reruns skip threads already cached, so the fetch is idempotent.
"""

import json
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[4]
CACHE = ROOT / ".cache" / "decisions"

USER = "author { login ... on User { databaseId id } ... on Bot { databaseId id } __typename }"
COMMENT_FIELDS = f"""
	id databaseId url createdAt lastEditedAt body upvoteCount isAnswer authorAssociation
	{USER}
	reactionGroups {{ content reactors {{ totalCount }} }}
"""
DISCUSSION_QUERY = f"""
query($owner: String!, $repo: String!, $number: Int!, $after: String) {{
	repository(owner: $owner, name: $repo) {{
		discussion(number: $number) {{
			id url title body createdAt lastEditedAt upvoteCount closed closedAt
			stateReason locked authorAssociation {USER}
			category {{ name }} labels(first: 20) {{ nodes {{ name }} }}
			answer {{ id }} answerChosenAt answerChosenBy {{ login }}
			reactionGroups {{ content reactors {{ totalCount }} }}
			comments(first: 50, after: $after) {{
				pageInfo {{ hasNextPage endCursor }}
				nodes {{
					{COMMENT_FIELDS}
					replies(first: 100) {{
						pageInfo {{ hasNextPage endCursor }}
						nodes {{ {COMMENT_FIELDS} }}
					}}
				}}
			}}
		}}
	}}
}}
"""
REPLIES_QUERY = f"""
query($id: ID!, $after: String) {{
	node(id: $id) {{
		... on DiscussionComment {{
			replies(first: 100, after: $after) {{
				pageInfo {{ hasNextPage endCursor }}
				nodes {{ {COMMENT_FIELDS} }}
			}}
		}}
	}}
}}
"""


def gh(*args):
	out = subprocess.run(["gh", "api", *args], capture_output=True, text=True)
	if out.returncode != 0:
		raise RuntimeError(f"gh api {' '.join(args[:3])}: {out.stderr.strip()}")
	return json.loads(out.stdout) if out.stdout.strip() else None


def graphql(query, **variables):
	args = ["graphql", "-f", f"query={query}"]
	for key, value in variables.items():
		if value is None:
			continue
		args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
	data = gh(*args)
	if data.get("errors"):
		raise RuntimeError(json.dumps(data["errors"])[:500])
	return data["data"]


def paged(path):
	"""REST pagination with --slurp so every page lands in one list."""
	path += ("&" if "?" in path else "?") + "per_page=100"
	pages = gh(path, "--paginate", "--slurp", "-H", "Accept: application/vnd.github+json")
	return [item for page in pages for item in page]


def parse(url):
	m = re.match(r"https://github\.com/([^/]+)/([^/]+)/(issues|pull|discussions)/(\d+)", url)
	if not m:
		raise ValueError(f"Unsupported URL: {url}")
	owner, repo, kind, number = m.groups()
	return owner, repo, {"pull": "pr", "issues": "issue", "discussions": "discussion"}[kind], int(number)


def cache_path(owner, repo, kind, number):
	return CACHE / f"{owner}__{repo}__{kind}__{number}.json"


def fetch_discussion(owner, repo, number):
	comments, after, head = [], None, None
	while True:
		data = graphql(DISCUSSION_QUERY, owner=owner, repo=repo, number=number, after=after)
		discussion = data["repository"]["discussion"]
		page = discussion.pop("comments")
		head = head or discussion
		for comment in page["nodes"]:
			replies = comment["replies"]
			while replies["pageInfo"]["hasNextPage"]:
				more = graphql(REPLIES_QUERY, id=comment["id"], after=replies["pageInfo"]["endCursor"])
				nxt = more["node"]["replies"]
				replies["nodes"] += nxt["nodes"]
				replies["pageInfo"] = nxt["pageInfo"]
		comments += page["nodes"]
		if not page["pageInfo"]["hasNextPage"]:
			break
		after = page["pageInfo"]["endCursor"]
	return {"discussion": head, "comments": comments}


def fetch_issue(owner, repo, number, pr):
	base = f"repos/{owner}/{repo}"
	issue = gh(f"{base}/issues/{number}")
	thread = {
		"issue": issue,
		"comments": paged(f"{base}/issues/{number}/comments"),
		"timeline": paged(f"{base}/issues/{number}/timeline"),
		"reactions": paged(f"{base}/issues/{number}/reactions"),
	}
	if pr or issue.get("pull_request"):
		pull = gh(f"{base}/pulls/{number}")
		thread["pull"] = pull
		thread["reviews"] = paged(f"{base}/pulls/{number}/reviews")
		thread["reviewComments"] = paged(f"{base}/pulls/{number}/comments")
		thread["fileCount"] = pull.get("changed_files")
	return thread


def fetch(url, force=False):
	owner, repo, kind, number = parse(url)
	path = cache_path(owner, repo, kind, number)
	if path.exists() and not force:
		return path, "cached"
	CACHE.mkdir(parents=True, exist_ok=True)
	retrieved = datetime.now(timezone.utc).isoformat()
	if kind == "discussion":
		raw = fetch_discussion(owner, repo, number)
	else:
		raw = fetch_issue(owner, repo, number, kind == "pr")
	body = {"url": url, "owner": owner, "repo": repo, "kind": kind, "number": number,
		"retrievedAt": retrieved, "raw": raw}
	tmp = path.with_suffix(".tmp")
	tmp.write_text(json.dumps(body))
	tmp.replace(path)
	return path, "fetched"


if __name__ == "__main__":
	force = "--force" in sys.argv
	failed = 0
	for url in [a for a in sys.argv[1:] if a != "--force"]:
		try:
			path, state = fetch(url, force)
			print(f"{state}\t{url}")
		except Exception as error:  # report every failure and keep going
			failed += 1
			print(f"FAILED\t{url}\t{error}", file=sys.stderr)
	sys.exit(1 if failed else 0)
