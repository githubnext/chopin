"""Data pass for the coverage critique on the combined decisions-v1 corpus.

Usage: python3 -I evals/datasets/decisions-v1/analysis/analyse_corpus.py

Adapted from the cloud session's v0 script (critique-coverage-data.md). Tests
H1–H12 from critique-coverage-theory.md §5 and re-ranks gaps over:
  all        132 thread records + 41 document records
  threads    the 132 thread records (decisions.jsonl)
  documents  the 41 document records (documents/decisions.jsonl)
  small      thread records whose case is in the small-team quota
Writes analysis/corpus-metrics.json. Brackets are Wilson 95% intervals.

Every gap carries one tag from v0's controlled vocabulary. Document gaps keep
the v0 coder's tag, recovered from the cluster name convert_v0.py gave it. Thread
gaps were coded into the same vocabulary afterwards (thread-gap-tags.json;
see coverage-critique.md for the method and the agreement check, tag-reliability.json).
"""

import importlib.util
import json
import math
import pathlib
import re
import statistics
from collections import Counter

HERE = pathlib.Path(__file__).resolve().parent
DATASET = HERE.parent
_spec = importlib.util.spec_from_file_location("package", DATASET / "tools" / "package.py")
package = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(package)


def load(path):
	return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


threads = load(DATASET / "decisions.jsonl")
documents = load(DATASET / "documents" / "decisions.jsonl")
quota = {c["id"]: c["sourceCluster"] for c in json.loads((DATASET / "manifest.json").read_text())["cases"]}

# ---------------------------------------------------------------- gap tags

_conv = importlib.util.spec_from_file_location("convert_v0", DATASET / "documents" / "convert_v0.py")
convert_v0 = importlib.util.module_from_spec(_conv)
_conv.loader.exec_module(convert_v0)
# Cluster name -> v0 tag. The convert_v0 mapping is one-to-one apart from v0's `other` split.
DOC_TAG = {v: k for k, v in convert_v0.CLUSTER.items()}
DOC_TAG.update({"hidden history": "other:hidden-history", "deadline": "other:deadline", "other": "other:misc"})
THREAD_TAGS = json.loads((HERE / "thread-gap-tags.json").read_text())
OTHER_RULES = convert_v0.OTHER


def thread_tag(tag, gap):
	if tag != "other":
		return tag
	for name, rx in OTHER_RULES:
		if rx.search(gap):
			return "other:" + name.replace(" ", "-")
	return "other:misc"


def tags_of(r):
	gaps = r["chopinFit"]["gaps"]
	if r["_source"] == "document":
		return [DOC_TAG[g.split(":", 1)[0]] for g in gaps]
	tags = THREAD_TAGS[r["id"]]
	if len(tags) != len(gaps):
		raise ValueError(f"{r['id']}: {len(tags)} tags for {len(gaps)} gaps")
	return [thread_tag(t, g) for t, g in zip(tags, gaps)]


FORMAL_REPOS = re.compile(r"^(tc39|rust-lang|python|golang)/", re.I)
for r in threads:
	r["_source"] = "thread"
	r["_quota"] = quota.get(r["caseId"])
	r["_formal"] = r["_quota"] == "formal-process"
	r["_standards"] = r["repo"].lower().startswith("tc39/")
for r in documents:
	r["_source"] = "document"
	r["_quota"] = None
	r["_formal"] = bool(FORMAL_REPOS.match(r["repo"])) or "peps.python.org" in r["sources"][0]["url"]
	r["_standards"] = r["repo"].lower().startswith("tc39/")
recs = threads + documents
for r in recs:
	r["_taglist"] = tags_of(r)
	r["_tags"] = set(r["_taglist"])
	r["_kinds"] = {s["kind"] for s in r["sources"]}

STRATA = {
	"all": recs,
	"threads": threads,
	"documents": documents,
	"small": [r for r in threads if r["_quota"] == "small-team"],
}

# ---------------------------------------------------------------- helpers (from v0)


def wilson(k, n, z=1.96):
	if n == 0:
		return None
	p = k / n
	d = 1 + z * z / n
	c = (p + z * z / (2 * n)) / d
	h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
	return [round(max(0, c - h), 3), round(min(1, c + h), 3)]


def prop(k, n):
	return {"k": k, "n": n, "p": round(k / n, 3) if n else None, "ci95": wilson(k, n)}


def frac(rs, pred):
	return prop(sum(1 for r in rs if pred(r)), len(rs))


def shape(r):
	return r["chopinFit"]["shape"]


def describe(rs):
	pc = [r["participants"]["count"] for r in rs if r["participants"]["count"] is not None]
	dur = [r["process"]["durationDays"] for r in rs if r["process"]["durationDays"] is not None]
	return {
		"n": len(rs),
		"quota": dict(Counter(r["_quota"] or "document" for r in rs).most_common()),
		"domain": dict(Counter(r["domain"] for r in rs).most_common()),
		"participants_known": len(pc),
		"participants_median": statistics.median(pc) if pc else None,
		"participants_le3": sum(1 for c in pc if c <= 3),
		"duration_median_days": statistics.median(dur) if dur else None,
		"decided": frac(rs, lambda r: r["outcome"]["decided"]),
		"how": dict(Counter(r["outcome"]["how"] for r in rs).most_common()),
		"decider": dict(Counter(r["participants"]["decider"] for r in rs).most_common()),
		"formal_share": frac(rs, lambda r: r["_formal"]),
		"truncated": frac(rs, lambda r: r["fidelity"]["truncated"]),
	}

# ---------------------------------------------------------------- hypotheses (v0 definitions)


def h1(rs):
	return {
		"mixed_or_none": frac(rs, lambda r: shape(r) in ("mixed", "none")),
		"has_secondaryShape": frac(rs, lambda r: r["chopinFit"].get("secondaryShape")),
		"shape_dist": dict(Counter(shape(r) for r in rs).most_common()),
		"primary_secondary_pairs": dict(Counter(f'{shape(r)}+{r["chopinFit"].get("secondaryShape")}' for r in rs).most_common(8)),
	}


def h2(rs):
	uix = [r for r in rs if r["domain"] in ("ui-ux", "product-behaviour")]
	c = Counter(shape(r) for r in rs)
	return {
		"choice": frac(rs, lambda r: shape(r) == "choice"),
		"tune": frac(rs, lambda r: shape(r) == "tune"),
		"choice_is_modal": bool(c) and c.most_common(1)[0][0] == "choice",
		"uiux_product_n": len(uix),
		"uiux_product_tune": frac(uix, lambda r: shape(r) == "tune"),
		"uiux_product_tune_primary_or_secondary": frac(uix, lambda r: "tune" in (shape(r), r["chopinFit"].get("secondaryShape"))),
		"tune_primary_or_secondary": frac(rs, lambda r: "tune" in (shape(r), r["chopinFit"].get("secondaryShape"))),
		"check_primary_or_secondary": frac(rs, lambda r: "check" in (shape(r), r["chopinFit"].get("secondaryShape"))),
		"explore_primary_or_secondary": frac(rs, lambda r: "explore" in (shape(r), r["chopinFit"].get("secondaryShape"))),
	}


def h3(rs):
	ch = [r for r in rs if shape(r) == "choice"]
	lens = [len(r["options"]) for r in ch]
	return {
		"n_choice": len(ch),
		"options_median": statistics.median(lens) if lens else None,
		"options_ge4": frac(ch, lambda r: len(r["options"]) >= 4),
		"criteria_nonempty": frac(ch, lambda r: bool(r["criteria"])),
		"composite_answer": frac(ch, lambda r: sum(o.get("fate") == "chosen" for o in r["options"]) >= 2 or any(o.get("fate") in ("partly", "merged") for o in r["options"])),
		"has_deferred_option": frac(ch, lambda r: any(o.get("fate") == "deferred" for o in r["options"])),
	}


def h4(rs):
	d = [r for r in rs if r["outcome"]["decided"] and len(r["options"]) >= 2]
	return {
		"order_guaranteed": False,
		"first_option_chosen": frac(d, lambda r: r["options"][0].get("fate") == "chosen"),
		"first_option_chosen_by_source": {s: frac([r for r in d if r["_source"] == s], lambda r: r["options"][0].get("fate") == "chosen") for s in ("thread", "document")},
	}


def h5(rs):
	und = [r for r in rs if not r["outcome"]["decided"]]
	return {
		"deferred_flag": frac(rs, lambda r: r["process"]["deferred"]),
		"undecided_and_deferred": frac(rs, lambda r: (not r["outcome"]["decided"]) and r["process"]["deferred"]),
		"parked_any": frac(rs, lambda r: ((not r["outcome"]["decided"]) and r["process"]["deferred"]) or bool(r["_tags"] & {"deferred", "stale-idle"})),
		"undecided_n": len(und),
		"undecided_deferred": sum(1 for r in und if r["process"]["deferred"]),
		"undecided_abandoned": sum(1 for r in und if r["outcome"]["how"] == "abandoned"),
		"decided_but_deferred_flag": sum(1 for r in rs if r["outcome"]["decided"] and r["process"]["deferred"]),
	}


STRUCT = {"coupled", "blocking", "staged"}


def h6(rs):
	rp = [r for r in rs if r["_kinds"] & {"rfc", "proposal"}]
	return {
		"subq_nonempty": frac(rs, lambda r: bool(r["process"]["subQuestions"])),
		"struct_tag": frac(rs, lambda r: bool(r["_tags"] & (STRUCT | {"nested"}))),
		"rfc_or_proposal_n": len(rp),
		"rfc_or_proposal_struct_tag": frac(rp, lambda r: bool(r["_tags"] & (STRUCT | {"nested"}))),
		"follow_up_structure": frac(rs, lambda r: bool(r["_tags"] & {"nested", "staged", "consequences"})),
	}


def h7(rs):
	nc = [r for r in rs if shape(r) != "check"]
	return {
		"n_noncheck": len(nc),
		"research_or_spike": frac(nc, lambda r: r["process"]["research"] != "none" or r["process"]["spike"] != "none"),
		"strict_(research_beyond_links_or_spike)": frac(nc, lambda r: r["process"]["research"] not in ("none", "links") or r["process"]["spike"] != "none"),
		"spike_any": frac(nc, lambda r: r["process"]["spike"] != "none"),
		"strict_excluding_implementation_pr": frac(nc, lambda r: r["process"]["research"] not in ("none", "links") or r["process"]["spike"] not in ("none", "implementation-pr")),
		"spike_dist": dict(Counter(r["process"]["spike"] for r in nc).most_common()),
		"evidence_tag": frac(nc, lambda r: "evidence-not-check" in r["_tags"]),
		"check_secondary": frac(nc, lambda r: r["chopinFit"].get("secondaryShape") == "check"),
	}


def h8(rs):
	d = [r for r in rs if r["outcome"]["decided"]]
	return {
		"n_decided": len(d),
		"reversibility_stated": frac(d, lambda r: r["outcome"]["reversibility"] in ("stated-easy", "stated-hard")),
		"confidence_stated": frac(d, lambda r: r["outcome"]["confidence"] == "stated"),
		"confidence_stated_by_source": {s: frac([r for r in d if r["_source"] == s], lambda r: r["outcome"]["confidence"] == "stated") for s in ("thread", "document")},
		"provisional_or_conditional_tag": frac(rs, lambda r: bool(r["_tags"] & {"provisional", "conditional"})),
	}


def h9(rs):
	d3 = [r for r in rs if r["outcome"]["decided"] and (r["participants"]["count"] or 0) >= 3]
	d = [r for r in rs if r["outcome"]["decided"]]
	return {
		"decided_ge3_n": len(d3),
		"dissent_decided_ge3": frac(d3, lambda r: r["outcome"]["dissent"]),
		"dissent_all_decided": frac(d, lambda r: r["outcome"]["dissent"]),
	}


def h10(rs):
	rv = [r for r in rs if r["process"]["reopened"] or r["process"]["superseded"]]
	return {
		"reopened_or_superseded": frac(rs, lambda r: r["process"]["reopened"] or r["process"]["superseded"]),
		"reopened": frac(rs, lambda r: r["process"]["reopened"]),
		"superseded": frac(rs, lambda r: r["process"]["superseded"]),
		"of_those_supersede_or_revert_tag": frac(rv, lambda r: bool(r["_tags"] & {"supersede", "revert"})),
		"supersede_or_revert_tag_any": frac(rs, lambda r: bool(r["_tags"] & {"supersede", "revert"})),
	}


def h11(rs):
	return {
		"pr_source_and_impl_pr": frac(rs, lambda r: "pr" in r["_kinds"] and r["process"]["spike"] == "implementation-pr"),
		"impl_pr_any_source": frac(rs, lambda r: r["process"]["spike"] == "implementation-pr"),
		"pr_source": frac(rs, lambda r: "pr" in r["_kinds"]),
		"implicit_tag": frac(rs, lambda r: "implicit" in r["_tags"]),
		"implementedIn_nonempty": frac(rs, lambda r: bool(r["outcome"]["implementedIn"])),
	}


SINGLE = {"named maintainer", "BDFL"}


def h12(rs):
	le3 = [r for r in rs if r["participants"]["count"] is not None and r["participants"]["count"] <= 3]
	nonstd = [r for r in rs if not r["_standards"]]
	nonformal = [r for r in rs if not r["_formal"]]
	vp = lambda r: r["process"]["poll"] or r["outcome"]["how"] == "vote"
	return {
		"le3_n": len(le3),
		"le3_ids": [r["id"] for r in le3],
		"le3_single_decider": frac(le3, lambda r: r["participants"]["decider"] in SINGLE),
		"single_decider": frac(rs, lambda r: r["participants"]["decider"] in SINGLE),
		"maintainer_decision_how": frac(rs, lambda r: r["outcome"]["how"] == "maintainer-decision"),
		"team_or_consensus_decider": frac(rs, lambda r: r["participants"]["decider"] in ("team", "consensus")),
		"decider_unclear": frac(rs, lambda r: r["participants"]["decider"] == "unclear"),
		"vote_or_poll_nonstandards": frac(nonstd, vp),
		"vote_or_poll_nonformal": frac(nonformal, vp),
		"vote_or_poll_all": frac(rs, vp),
	}


HYP = {"H1": h1, "H2": h2, "H3": h3, "H4": h4, "H5": h5, "H6": h6,
	"H7": h7, "H8": h8, "H9": h9, "H10": h10, "H11": h11, "H12": h12}

# ---------------------------------------------------------------- gaps


def tag_table():
	names = Counter(t for r in recs for t in r["_tags"])
	out = {}
	for name, _ in names.most_common():
		row = {s: frac(rs, lambda r, n=name: n in r["_tags"]) for s, rs in STRATA.items()}
		row["entries_total"] = sum(r["_taglist"].count(name) for r in recs)
		hits = [r for r in recs if name in r["_tags"]]
		row["formal_share_of_hits"] = frac(hits, lambda r: r["_formal"])
		row["examples"] = [{"id": r["id"], "source": r["_source"], "url": r["sources"][0]["url"],
			"gap": next(g for t, g in zip(r["_taglist"], r["chopinFit"]["gaps"]) if t == name)[:200]}
			for r in sorted(hits, key=lambda r: (r["_quota"] != "small-team", r["_source"] != "thread", r["id"]))[:4]]
		out[name] = row
	return out


def reliability():
	"""Blind recoding of 60 document gaps against the v0 coder's tags (Cohen's kappa)."""
	data = json.loads((HERE / "tag-reliability.json").read_text())
	a = [x["v0"] for x in data["items"]]
	b = [x["recoded"] for x in data["items"]]
	n = len(a)
	po = sum(x == y for x, y in zip(a, b)) / n
	ca, cb = Counter(a), Counter(b)
	pe = sum(ca[k] * cb[k] for k in set(a) | set(b)) / (n * n)
	return {"n": n, "agree": sum(x == y for x, y in zip(a, b)), "po": round(po, 3), "pe": round(pe, 3),
		"kappa": round((po - pe) / (1 - pe), 3),
		"confusions": dict(Counter(f"{x}->{y}" for x, y in zip(a, b) if x != y).most_common(10))}


# The theory pass's gap groups (critique-coverage-theory.md §3), as concept sets.
GROUPS = {
	"G7 follow-ups: nested|staged|consequences": lambda r, t: bool(t & {"nested", "staged", "consequences"}),
	"G9' composite answer (>=2 chosen or partly/merged)": lambda r, t: sum(o.get("fate") == "chosen" for o in r["options"]) >= 2 or any(o.get("fate") in ("partly", "merged") for o in r["options"]),
	"G2 parked: deferred|stale-idle or undecided+deferred": lambda r, t: bool(t & {"deferred", "stale-idle"}) or ((not r["outcome"]["decided"]) and r["process"]["deferred"]),
	"G6 evidence beyond check": lambda r, t: "evidence-not-check" in t,
	"G3 decided elsewhere: venue-split|implicit|ratify": lambda r, t: bool(t & {"venue-split", "implicit", "ratify"}),
	"P8 external authority": lambda r, t: "external-authority" in t,
	"G5 provisional|conditional": lambda r, t: bool(t & {"provisional", "conditional"}),
	"G10 supersede|revert": lambda r, t: bool(t & {"supersede", "revert"}),
	"G4 coupled|blocking": lambda r, t: bool(t & {"coupled", "blocking"}),
	"P10 crowd signal (votes as evidence)": lambda r, t: "crowd-signal" in t,
	"G12 delegate|approve": lambda r, t: bool(t & {"delegate", "approve"}),
	"P6 consensus mechanics": lambda r, t: "consensus-mechanics" in t,
	"N reframe": lambda r, t: "reframe" in t,
	"G8 convention": lambda r, t: "convention" in t,
	"N visual comparison": lambda r, t: "visual-comparison" in t,
	"N rejected-content": lambda r, t: "rejected-content" in t,
	"N consequences": lambda r, t: "consequences" in t,
	"G9 rank|partition": lambda r, t: bool(t & {"rank", "partition"}),
	"G11 moot": lambda r, t: "moot" in t,
	"C deadline": lambda r, t: "other:deadline" in t,
	"X hidden history (corpus artefact)": lambda r, t: "other:hidden-history" in t,
	"P7 formal vote": lambda r, t: "vote" in t,
}


def group_table():
	out = {}
	for g, pred in GROUPS.items():
		row = {s: frac(rs, lambda r: pred(r, r["_tags"])) for s, rs in STRATA.items()}
		hits = [r for r in recs if pred(r, r["_tags"])]
		row["formal_share_of_hits"] = frac(hits, lambda r: r["_formal"])
		row["examples"] = [r["id"] for r in sorted(hits, key=lambda r: (r["_quota"] != "small-team", r["_source"] != "thread", r["id"]))[:4]]
		out[g] = row
	return out


def flows():
	return {s: {k: prop(v, len(rs)) for k, v in sorted(Counter(f for r in rs for f in r["chopinFit"]["fitsFlows"]).items())}
		for s, rs in STRATA.items()}


metrics = {
	"meta": {
		"n": len(recs),
		"strata": {s: len(rs) for s, rs in STRATA.items()},
		"ci": "Wilson 95% interval",
	},
	"describe": {s: describe(rs) for s, rs in STRATA.items()},
	"hypotheses": {h: {s: f(rs) for s, rs in STRATA.items()} for h, f in HYP.items()},
	"tags": tag_table(),
	"tag_reliability": reliability(),
	"gap_groups": group_table(),
	"flows": flows(),
}
(HERE / "corpus-metrics.json").write_text(json.dumps(metrics, indent="\t", ensure_ascii=False) + "\n")


def p(x):
	return f'{x["k"]}/{x["n"]}={x["p"]}' if x and x["n"] else "n/a"


if __name__ == "__main__":
	print({s: len(rs) for s, rs in STRATA.items()})
	for s in STRATA:
		d = metrics["describe"][s]
		print(s, {k: (p(v) if isinstance(v, dict) and "k" in v else v) for k, v in d.items() if k not in ("domain",)})
	for h, by in metrics["hypotheses"].items():
		print("==", h)
		for s in STRATA:
			print("  ", s, {k: (p(v) if isinstance(v, dict) and "k" in v else v) for k, v in by[s].items()
				if not (isinstance(v, dict) and "k" not in v) or k in ("shape_dist", "primary_secondary_pairs")})
	print("== groups")
	for g, row in metrics["gap_groups"].items():
		print(f'  {g:52s}', " ".join(f'{s} {p(row[s]):12s}' for s in STRATA), "| formal", p(row["formal_share_of_hits"]))
	print("== reliability", {k: v for k, v in metrics["tag_reliability"].items()})
	print("== tags")
	for c, row in metrics["tags"].items():
		print(f'  {c:42s}', " ".join(f'{s} {p(row[s]):12s}' for s in STRATA))
