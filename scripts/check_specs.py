#!/usr/bin/env python3
"""Audit the three approved specifications; prose review remains a separate gate.

JSON is written to stdout and a short readable summary to stderr. Only the
selected repository's documented inputs and direct local link targets are read.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

SPECS = {
    "COURSEWEAVE.md": "CW", "COURSEWEAVE-TEACHER-EDITION.md": "TE",
    "COURSEWEAVE-STUDENT-EDITION.md": "SE",
}
PLAN = "docs/superpowers/plans/2026-09-14-courseweave-author-edition.md"
REQUIRED_FACTS = {
    "bundle_id": str, "application_target": str, "student_compatibility_target": str,
    "course_schema_version": int, "author_project_format": int, "author_roles": list,
    "progress_modes": list, "teacher_access_modes": list, "hint_levels": list,
    "share_kinds": list, "surface_types": list, "check_types": list,
    "conversation_memory": str, "mutation_unit": str, "mastery_gating": bool,
    "student_web_retrieval": bool, "student_managed_knowledge_base": bool,
    "author_search_backend": str,
}
REQ = re.compile(r"\b(?:CW|TE|SE)-\d{3}\b")
GATE = re.compile(r"\bV\d{2}\b")


def prose(text: str) -> str:
    return re.sub(r"^```[^\n]*\n.*?^```\s*$", "", text, flags=re.M | re.S)


def anchors(text: str) -> set[str]:
    result: set[str] = set()
    counts: dict[str, int] = {}
    for heading in re.findall(r"^#{1,6}\s+(.+?)(?:\s+#+)?$", prose(text), re.M):
        slug = re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
        count = counts.get(slug, 0)
        result.add(f"{slug}-{count}" if count else slug)
        counts[slug] = count + 1
    result.update(re.findall(r'<a\s+(?:name|id)=[\"\']([^\"\']+)', text))
    return result


def audit(root: Path) -> dict:
    errors: list[str] = []
    documents: dict[str, str] = {}
    paths = [f"docs/specs/{name}" for name in SPECS]
    paths += ["docs/specs/README.md", "docs/specs/CONSISTENCY-REVIEW.md", PLAN,
              "docs/superpowers/specs/2026-09-14-chatgpt-courseweave-feasibility.md"]
    for relative in paths:
        path = root / relative
        try:
            if not path.resolve().is_relative_to(root):
                raise ValueError("document escapes selected root")
            documents[relative] = path.read_text(encoding="utf-8")
        except (OSError, ValueError) as exc:
            errors.append(f"{relative}: {exc}")

    shared = documents.get("docs/specs/COURSEWEAVE.md", "")
    blocks = re.findall(r"^```json\s*\n(.*?)^```", shared, re.M | re.S)
    facts: dict = {}
    try:
        if len(blocks) != 1:
            raise ValueError("expected one shared JSON fact block")
        facts = json.loads(blocks[0])
        if not isinstance(facts, dict):
            raise ValueError("shared facts must be an object")
    except (ValueError, IndexError) as exc:
        errors.append(f"shared facts: {exc}")
        facts = {}
    for name, kind in REQUIRED_FACTS.items():
        if name not in facts or type(facts[name]) is not kind:
            errors.append(f"missing or invalid required fact: {name}")
        elif kind is list and (not facts[name] or any(type(v) is not str for v in facts[name])
                              or len(set(facts[name])) != len(facts[name])):
            errors.append(f"fact {name} must contain unique nonempty strings")

    bundle = facts.get("bundle_id")
    for relative, text in documents.items():
        if relative.endswith("chatgpt-courseweave-feasibility.md"):
            continue  # Supporting research does not own normative bundle facts.
        pattern = r"All belong to bundle `([^`]+)`" if relative == PLAN else r"\*\*Bundle:\*\*\s*`([^`]+)`"
        declared = re.findall(pattern, prose(text))
        if not bundle or declared != [bundle]:
            errors.append(f"{relative}: mismatched or absent bundle ID")

    plan = prose(documents.get(PLAN, ""))
    catalogue = plan.partition("## Verification catalogue")[2]
    gate_rows = re.findall(r"^\| (V\d{2}) \|", catalogue, re.M)
    gates = set(gate_rows)
    if len(gates) != len(gate_rows):
        errors.append("duplicate verification gate definition")
    if not gates:
        errors.append("missing verification catalogue")
    task_chunks = re.split(r"^## Task (\d+):[^\n]*\n", plan, flags=re.M)
    tasks: dict[str, set[int]] = {gate: set() for gate in gates}
    task_ids = [int(value) for value in task_chunks[1::2]]
    if len(set(task_ids)) != len(task_ids):
        errors.append("duplicate implementation task")
    for task, body in zip(task_chunks[1::2], task_chunks[2::2]):
        produces = re.search(r"\*\*Produces:\*\*([^\n]*)", body)
        if produces is None:
            errors.append(f"task {task} has no declared produced verification")
            continue
        for gate in GATE.findall(produces[1]):
            if gate not in tasks:
                errors.append(f"task {task}: unknown verification {gate}")
            else:
                tasks[gate].add(int(task))
    for gate, owners in tasks.items():
        if not owners:
            errors.append(f"verification {gate} has no producing task")

    rows: list[dict] = []
    owned: dict[str, str] = {}
    owner_counts: dict[str, int] = {}
    for filename, prefix in SPECS.items():
        text = documents.get(f"docs/specs/{filename}", "")
        count = 0
        for line in prose(text).splitlines():
            if not re.match(r"^\| (CW|TE|SE)-\d{3} \|", line):
                continue
            columns = [part.strip() for part in line.strip().strip("|").split("|")]
            if len(columns) != 3:
                errors.append(f"{filename}: malformed requirement row {line}")
                continue
            identifier, requirement, verification = columns
            count += 1
            if not identifier.startswith(prefix + "-"):
                errors.append(f"{identifier}: wrong owner {filename}")
            if identifier in owned:
                errors.append(f"duplicate requirement ownership: {identifier}")
            owned[identifier] = filename
            mapped = GATE.findall(verification)
            if not mapped:
                errors.append(f"{identifier}: unmapped requirement")
            if len(mapped) != len(set(mapped)):
                errors.append(f"{identifier}: duplicate verification mapping")
            for gate in mapped:
                if gate not in gates:
                    errors.append(f"{identifier}: unknown verification {gate}")
            task_numbers = sorted({task for gate in mapped for task in tasks.get(gate, ())})
            rows.append(dict(requirement_id=identifier, owner=filename,
                             verification_ids=";".join(mapped),
                             implementation_tasks=";".join(map(str, task_numbers)),
                             requirement=requirement))
        owner_counts[filename] = count
        if not count:
            errors.append(f"{filename}: no owned requirements")

    for relative, text in documents.items():
        for reference in set(REQ.findall(prose(text))):
            if reference not in owned:
                errors.append(f"{relative}: dangling requirement {reference}")
        for reference in set(GATE.findall(prose(text))):
            if reference not in gates:
                errors.append(f"{relative}: dangling verification {reference}")

    trace = root / "docs/specs/traceability.csv"
    try:
        recorded = list(csv.DictReader(io.StringIO(trace.read_text(encoding="utf-8"))))
        by_id = {row["requirement_id"]: row for row in recorded}
        if len(by_id) != len(recorded):
            errors.append("traceability has duplicate requirement IDs")
        for row in rows:
            if by_id.get(row["requirement_id"]) != row:
                errors.append(f"traceability mismatch or missing row: {row['requirement_id']}")
        for identifier in by_id.keys() - owned.keys():
            errors.append(f"traceability references unknown requirement: {identifier}")
    except (OSError, KeyError, csv.Error) as exc:
        errors.append(f"traceability: {exc}")

    links_checked = 0
    for relative, text in documents.items():
        if len(re.findall(r"^```", text, re.M)) % 2:
            errors.append(f"{relative}: unbalanced fenced block")
        for href in re.findall(r"\[[^\]\n]*\]\(([^\s)]+)\)", prose(text)):
            link = urlsplit(href)
            if link.scheme or link.netloc:
                continue
            target = (root / relative).parent / unquote(link.path) if link.path else root / relative
            target = target.resolve()
            links_checked += 1
            if not target.is_relative_to(root) or not target.is_file():
                errors.append(f"{relative}: missing or escaping local link {href}")
            elif link.fragment and target.suffix == ".md" and unquote(link.fragment) not in anchors(target.read_text(encoding="utf-8")):
                errors.append(f"{relative}: missing fragment {href}")

    return dict(bundle_id=bundle, status="fail" if errors else "pass",
                scope="mechanical specification audit; not implementation acceptance",
                semantic_review="required separately", requirements=len(rows), owners=owner_counts,
                verification_gates=len(gates), implementation_tasks=len(task_ids),
                local_links_checked=links_checked, errors=errors,
                files={path: hashlib.sha256(text.encode()).hexdigest() for path, text in documents.items()})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    report = audit(args.root.resolve())
    print(json.dumps(report, indent=2))
    print(f"{report['status'].upper()}: {report['requirements']} requirements, "
          f"{report['verification_gates']} gates, {len(report['errors'])} errors. "
          "Semantic review is required separately.", file=sys.stderr)
    return int(bool(report["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
