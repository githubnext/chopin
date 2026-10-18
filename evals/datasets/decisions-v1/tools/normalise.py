"""Turn cached raw threads into v2 event skeletons plus a reading digest.

Usage: python3 -I normalise.py [CACHE_KEY ...]   (default: every cached thread)

Writes .cache/decisions/norm/<key>.json (skeleton events with source text) and
<key>.txt (a compact digest for annotators). Both stay in the git-ignored cache
because they carry verbatim source text.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
CACHE = ROOT / ".cache" / "decisions"
NORM = CACHE / "norm"
CAP = 150
BODY_LIMIT = 3000
OPENING_LIMIT = 8000
KNOWN_BOTS = {
	"gopherbot", "rfcbot", "rustbot", "rust-highfive", "bors", "k8s-ci-robot",
	"k8s-triage-robot", "nodejs-github-bot", "github-actions", "dependabot", "codecov",
	"changeset-bot", "vercel", "netlify", "stale", "msftbot", "vscodenpm", "vs-code-engineering",
	"vscode-triage-bot", "linear", "home-assistant", "rust-log-analyzer", "triagebot",
}
MAINTAINER = {"OWNER", "MEMBER", "COLLABORATOR"}
PROCESS = {
	"labeled", "unlabeled", "closed", "reopened", "renamed", "merged", "locked",
	"converted_to_discussion", "ready_for_review", "convert_to_draft", "review_dismissed",
	"cross-referenced",
}


def slug(repo, number):
	return f"{re.sub(r'[^a-z0-9]+', '-', repo.lower()).strip('-')}-{number}"


def actor_type(login, kind=None):
	if not login:
		return "unknown"
	if kind == "Bot" or login.endswith("[bot]") or login.lower() in KNOWN_BOTS:
		return "bot"
	return "human"


def reaction_total(groups):
	return sum(g["reactors"]["totalCount"] for g in groups or [])


def clip(text, limit=BODY_LIMIT):
	text = (text or "").replace("\r\n", "\n").strip()
	return text if len(text) <= limit else text[:limit] + " …[clipped]"


def event(**fields):
	return {k: v for k, v in fields.items() if v is not None}


def from_discussion(raw):
	d = raw["discussion"]
	root = d["id"]

	def who(node):
		author = node.get("author") or {}
		return author.get("login") or "ghost", author.get("id"), actor_type(author.get("login"),
			author.get("__typename"))

	def edited(node):
		return node["lastEditedAt"] if node.get("lastEditedAt") and node["lastEditedAt"] != node["createdAt"] else None

	login, aid, atype = who(d)
	events = [event(id=root, kind="opening", actor=login, actorId=aid, actorType=atype,
		createdAt=d["createdAt"], editedAt=edited(d), url=d["url"], title=d["title"],
		text=clip(d["body"], OPENING_LIMIT), reactions=reaction_total(d["reactionGroups"]) + d["upvoteCount"],
		assoc=d.get("authorAssociation"))]
	for c in raw["comments"]:
		login, aid, atype = who(c)
		events.append(event(id=c["id"], kind="comment", actor=login, actorId=aid, actorType=atype,
			createdAt=c["createdAt"], editedAt=edited(c), url=c["url"], parentId=root,
			text=clip(c["body"]), reactions=reaction_total(c["reactionGroups"]) + c["upvoteCount"],
			assoc=c.get("authorAssociation"), isAnswer=c.get("isAnswer") or None))
		for r in c["replies"]["nodes"]:
			login, aid, atype = who(r)
			events.append(event(id=r["id"], kind="reply", actor=login, actorId=aid, actorType=atype,
				createdAt=r["createdAt"], editedAt=edited(r), url=r["url"], parentId=c["id"],
				text=clip(r["body"]), reactions=reaction_total(r["reactionGroups"]) + r["upvoteCount"],
				assoc=r.get("authorAssociation"), isAnswer=r.get("isAnswer") or None))
	if d.get("answerChosenAt"):
		by = (d.get("answerChosenBy") or {}).get("login")
		events.append(event(id=f"{root}:process:answered:{d['answerChosenAt']}", kind="process",
			actor=by or "unknown", actorType=actor_type(by), createdAt=d["answerChosenAt"],
			url=d["url"], parentId=root, text=f"[marked an answer: {d['answer']['id']}]"))
	if d.get("closed") and d.get("closedAt"):
		events.append(event(id=f"{root}:process:closed:{d['closedAt']}", kind="process",
			actor="unknown", actorType="unknown", createdAt=d["closedAt"], url=d["url"], parentId=root,
			text=f"[discussion closed, reason {d.get('stateReason')}]"))
	meta = {"title": d["title"], "nodeId": root, "category": (d.get("category") or {}).get("name"),
		"labels": [l["name"] for l in d["labels"]["nodes"]], "closed": d["closed"],
		"answered": bool(d.get("answer"))}
	return events, meta


def from_issue(raw, repo, number):
	issue = raw["issue"]
	pr = "pull" in raw
	base = slug(repo, number)
	root = f"{base}:{'pr' if pr else 'issue'}:{number}"

	def user(u):
		u = u or {}
		return u.get("login") or "ghost", u.get("id"), actor_type(u.get("login"), u.get("type"))

	def edited(node):
		return node["updated_at"] if node.get("updated_at") and node["updated_at"] != node["created_at"] else None

	login, aid, atype = user(issue["user"])
	events = [event(id=root, kind="opening", actor=login, actorId=aid, actorType=atype,
		createdAt=issue["created_at"], url=issue["html_url"], title=issue["title"],
		text=clip(issue["body"], OPENING_LIMIT), reactions=issue.get("reactions", {}).get("total_count"),
		assoc=issue.get("author_association"))]
	for c in raw["comments"]:
		login, aid, atype = user(c["user"])
		minimized = (c.get("minimized") or {}).get("reason") if isinstance(c.get("minimized"), dict) else None
		events.append(event(id=f"{base}:comment:{c['id']}", kind="comment", actor=login, actorId=aid,
			actorType=atype, createdAt=c["created_at"], editedAt=edited(c), url=c["html_url"],
			parentId=root, text=clip(c["body"]), reactions=c.get("reactions", {}).get("total_count"),
			assoc=c.get("author_association"), minimized=minimized))
	reviews = {}
	for r in raw.get("reviews", []):
		if not r.get("submitted_at"):
			continue
		login, aid, atype = user(r["user"])
		rid = f"{base}:review:{r['id']}"
		reviews[r["id"]] = rid
		if r["state"] == "COMMENTED" and not (r.get("body") or "").strip():
			continue  # an empty container for inline review comments
		events.append(event(id=rid, kind="review", actor=login, actorId=aid, actorType=atype,
			createdAt=r["submitted_at"], url=r["html_url"], parentId=root,
			text=clip(f"[{r['state']}] {r.get('body') or ''}"), assoc=r.get("author_association")))
	kept = {e["id"] for e in events}
	for c in raw.get("reviewComments", []):
		login, aid, atype = user(c["user"])
		if c.get("in_reply_to_id"):
			parent = f"{base}:review-comment:{c['in_reply_to_id']}"
		elif reviews.get(c.get("pull_request_review_id")) in kept:
			parent = reviews[c["pull_request_review_id"]]
		else:
			parent = root
		events.append(event(id=f"{base}:review-comment:{c['id']}", kind="review-comment", actor=login,
			actorId=aid, actorType=atype, createdAt=c["created_at"], editedAt=edited(c),
			url=c["html_url"], parentId=parent,
			text=clip(f"[on {c.get('path')}] {c.get('body') or ''}"),
			reactions=c.get("reactions", {}).get("total_count"), assoc=c.get("author_association")))
	seen = set()
	for t in raw["timeline"]:
		kind = t.get("event")
		if kind not in PROCESS:
			continue
		at = t.get("created_at")
		login, aid, atype = user(t.get("actor"))
		if kind == "labeled" or kind == "unlabeled":
			detail = t["label"]["name"]
		elif kind == "renamed":
			detail = f"{t['rename']['from']} -> {t['rename']['to']}"
		elif kind == "closed":
			detail = t.get("state_reason") or ""
		elif kind == "cross-referenced":
			source = (t.get("source") or {}).get("issue") or {}
			if not source.get("pull_request"):
				continue  # keep one-hop links to PRs; issue mentions are noise at this scale
			detail = f"{source.get('html_url')} [{source.get('state')}] {source.get('title')}"
			login, aid, atype = user(source.get("user"))
		else:
			detail = ""
		pid = f"{base}:process:{kind}:{at}"
		while pid in seen:
			pid += "+"
		seen.add(pid)
		events.append(event(id=pid, kind="process", actor=login, actorId=aid, actorType=atype,
			createdAt=at, url=issue["html_url"], parentId=root, text=f"[{kind}] {detail}".strip()))
	if issue.get("closed_at") and not any(e["id"].startswith(f"{base}:process:closed:") for e in events):
		# GitHub sometimes omits the close from the timeline API; closed_at is still authoritative.
		merged = (raw.get("pull") or {}).get("merged_at")
		kind = "merged" if merged and merged == issue["closed_at"] else "closed"
		events.append(event(id=f"{base}:process:{kind}:{issue['closed_at']}", kind="process",
			actor="unknown", actorType="unknown", createdAt=issue["closed_at"], url=issue["html_url"],
			parentId=root, text=f"[{kind}] (time from closed_at; actor not returned by the API)",
			default=f"The {'pull request' if pr else 'issue'} is {kind}; the API does not record by whom."))
	pull = raw.get("pull") or {}
	meta = {"title": issue["title"], "state": issue["state"], "stateReason": issue.get("state_reason"),
		"labels": [l["name"] for l in issue["labels"]], "isPr": pr, "merged": pull.get("merged"),
		"fileCount": raw.get("fileCount"), "reactions": issue.get("reactions", {}).get("total_count")}
	return events, meta


def cap(events):
	"""Keep the opening, process, bot and maintainer events, then the most-reacted rest."""
	talk = [e for e in events if e["kind"] != "process"]
	if len(talk) <= CAP:
		return events, 0
	must = {e["id"] for e in talk if e["kind"] == "opening" or e["actorType"] == "bot"
		or e.get("assoc") in MAINTAINER or e.get("isAnswer")}
	rest = sorted((e for e in talk if e["id"] not in must), key=lambda e: -(e.get("reactions") or 0))
	keep = set(must) | {e["id"] for e in rest[:max(0, CAP - len(must))]}
	byid = {e["id"]: e for e in events}
	for eid in list(keep):  # a kept reply keeps its parent so reply structure stays true
		parent = byid[eid].get("parentId")
		while parent and parent in byid and parent not in keep:
			keep.add(parent)
			parent = byid[parent].get("parentId")
	kept = [e for e in events if e["kind"] == "process" or e["id"] in keep]
	return kept, len(events) - len(kept)


def digest(key, meta, events, dropped, total):
	lines = [f"# {key}", json.dumps(meta), f"events kept {len(events)} of {total}; dropped {dropped}", ""]
	for e in events:
		head = f"[{e['id']}] {e['kind']} by {e['actor']} ({e.get('assoc') or e['actorType']})" \
			f" at {e['createdAt']}"
		if e.get("editedAt"):
			head += f" edited {e['editedAt']}"
		if e.get("parentId"):
			head += f" parent={e['parentId']}"
		if e.get("reactions"):
			head += f" reactions={e['reactions']}"
		if e.get("isAnswer"):
			head += " ANSWER"
		if e.get("minimized"):
			head += f" HIDDEN({e['minimized']})"
		lines += [head, e.get("text") or "", ""]
	return "\n".join(lines)


def normalise(path):
	doc = json.loads(path.read_text())
	if doc["kind"] == "discussion":
		events, meta = from_discussion(doc["raw"])
	else:
		events, meta = from_issue(doc["raw"], doc["repo"], doc["number"])
	events.sort(key=lambda e: (e["createdAt"], e["kind"] != "opening"))
	total = len(events)
	talk = [e for e in events if e["kind"] != "process"]
	counts = {"humanParticipants": len({e["actor"] for e in talk if e["actorType"] == "human"}),
		"comments": sum(e["kind"] != "opening" for e in talk),
		"reactionsTotal": sum(e.get("reactions") or 0 for e in talk)}
	events, dropped = cap(events)
	meta.update(url=doc["url"], repo=f"{doc['owner']}/{doc['repo']}", kind=doc["kind"],
		number=doc["number"], retrievedAt=doc["retrievedAt"], slug=slug(doc["repo"], doc["number"]),
		totalEvents=total, droppedEvents=dropped, **counts)
	NORM.mkdir(parents=True, exist_ok=True)
	(NORM / f"{path.stem}.json").write_text(json.dumps({"meta": meta, "events": events}, indent=1))
	(NORM / f"{path.stem}.txt").write_text(digest(path.stem, meta, events, dropped, total))
	return meta


if __name__ == "__main__":
	keys = sys.argv[1:] or [p.stem for p in sorted(CACHE.glob("*__*.json"))]
	for key in keys:
		meta = normalise(CACHE / f"{key}.json")
		print(f"{key}\t{meta['totalEvents']}\tdropped={meta['droppedEvents']}")
