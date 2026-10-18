"""Convert the cloud session's document records (corpus v0) to the decisions-v1 record format.

Usage: python3 -I convert_v0.py PATH/TO/corpus-v0-tagged.jsonl

Keeps only records read from complete files (fidelity.method == "git-file"),
excluding the chopin-v2 collector, whose threads decisions-v1 refetched in full.
Writes documents/decisions.jsonl.
"""

import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent

FLOWS = {"find": "find", "work in place": "work-in-place", "research/spike": "research-or-spike",
	"ask teammate": "ask-teammate", "settle": "settle", "revisit/reopen": "revisit-reopen",
	"build/pr": "build-pr", "reshape": "reshape"}

# v0 tagged every gap; tags that match a decisions-v1 cluster use its name, the rest keep their own.
CLUSTER = {
	"staged": "staged acceptance",
	"coupled": "coupled decisions",
	"venue-split": "off-platform decision",
	"crowd-signal": "votes as evidence",
	"revert": "reversal after shipping",
	"supersede": "superseded or moved to another thread",
	"stale-idle": "dormant or ownerless question",
	"reframe": "reframing",
	"evidence-not-check": "evidence beyond check",
	"delegate": "delegated decider",
	"external-authority": "external authority",
	"nested": "nested follow-ups",
	"consequences": "consequences and obligations",
	"blocking": "blocking dependency",
	"consensus-mechanics": "consensus mechanics",
	"vote": "formal vote",
	"rank": "ranked choice",
	"convention": "convention scope",
	"rejected-content": "rejected options content",
	"conditional": "conditional decision",
	"provisional": "provisional decision",
	"deferred": "deferred",
	"implicit": "implicit decision",
	"moot": "moot question",
	"approve": "approval roster",
	"visual-comparison": "visual comparison",
}
# The same keyword split v0's analysis applied to its catch-all `other` tag.
OTHER = [
	("hidden history", re.compile(r"hidden|deleted|collapsed|unloaded|load more|unaccounted|moderation|locked", re.I)),
	("deadline", re.compile(r"deadline|time pressure|urgency|release schedule|patience|called time|should have come earlier|shipping urgency|edition-boundary", re.I)),
]


# v0 phrases that repeat 8+ consecutive words of their source document; reworded so
# committed records stay paraphrase-only (documents/validate.py checks this).
REWORD = {
	"the current combination of GitHub Actions, ArgoCD and Argo Workflows":
		"today's mix of Argo Workflows, ArgoCD and GitHub Actions",
	"safe to enable in new and upgraded clusters (dry-run, audit)":
		"can be switched on safely for fresh or upgraded clusters (dry-run, audit)",
}


def reword(value):
	if isinstance(value, str):
		for old, new in REWORD.items():
			value = value.replace(old, new)
		return value
	if isinstance(value, list):
		return [reword(v) for v in value]
	if isinstance(value, dict):
		return {k: reword(v) for k, v in value.items()}
	return value


def decider(text):
	t = (text or "").strip()
	for prefix, value in (("consensus", "consensus"), ("vote", "vote"), ("bdfl", "BDFL"),
			("steering council", "vote"), ("named maintainer", "named maintainer"),
			("unclear", "unclear"), ("ecma-402 task group", "team"), ("team", "team")):
		if t.lower().startswith(prefix):
			return value
	raise ValueError(f"Unmapped decider: {t!r}")


def cluster(tag, gap):
	if tag == "other":
		for name, rx in OTHER:
			if rx.search(gap):
				return name
		return "other"
	return CLUSTER[tag]


def convert(r):
	fit = r["chopinFit"]
	if len(r["gapTags"]) != len(fit["gaps"]):
		raise ValueError(f"{r['id']}: gapTags and gaps differ in length")
	flows = []
	for f in fit["fitsFlows"]:
		name = FLOWS[re.sub(r"^F\d+\s+", "", f).strip().lower()]
		if name not in flows:
			flows.append(name)
	participants = dict(r["participants"])
	original = participants["decider"]
	participants["decider"] = decider(original)
	notes = (r.get("notes") or "").strip()
	if original != participants["decider"]:
		notes = (notes + " " if notes else "") + f"Original decider wording (v0): {original}."
	process = dict(r["process"])
	process["reactionsTotal"] = None
	process["decidedOffPlatform"] = bool(r["process"].get("decidedOffPlatform", False))
	ordered_process = {k: process[k] for k in ("research", "spike", "poll", "escalation",
		"subQuestions", "deferred", "reopened", "superseded", "durationDays", "comments",
		"reactionsTotal", "decidedOffPlatform", "notableMoves")}
	return {
		"id": r["id"],
		"caseId": None,
		"collector": "cloud-git",
		"sources": r["sources"],
		"repo": r["repo"],
		"domain": r["domain"],
		"title": r["title"],
		"question": r["question"],
		"questionExplicit": r["questionExplicit"],
		"context": r["context"],
		"options": r["options"],
		"criteria": r["criteria"],
		"participants": participants,
		"process": ordered_process,
		"outcome": r["outcome"],
		"chopinFit": {
			"shape": fit["shape"],
			"shapeWhy": fit["shapeWhy"],
			"secondaryShape": fit.get("secondaryShape"),
			"fitsFlows": flows,
			"gaps": [f"{cluster(t, g)}: {g}" for t, g in zip(r["gapTags"], fit["gaps"])],
		},
		"evalUse": r["evalUse"],
		"fidelity": {"method": "git-file", "truncated": r["fidelity"]["truncated"]},
		"notes": notes,
	}


def main():
	records = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text().splitlines() if l.strip()]
	keep = [r for r in records if r["fidelity"]["method"] == "git-file" and r["collector"] != "chopin-v2"]
	out = [reword(convert(r)) for r in keep]
	(HERE / "decisions.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out))
	print(f"{len(records)} v0 records, {len(out)} converted")


if __name__ == "__main__":
	main()
