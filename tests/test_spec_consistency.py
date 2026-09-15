"""Exercise the spec audit against deliberate contract drift, without network."""

import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


def check(root: Path):
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts/check_specs.py"), "--root", str(root)],
        capture_output=True, text=True,
    )


@pytest.fixture
def spec_root(tmp_path):
    shutil.copytree(ROOT / "docs", tmp_path / "docs")
    return tmp_path


def test_approved_bundle_has_complete_traceability():
    result = check(ROOT)
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["requirements"] == 68
    assert report["verification_gates"] == 11
    assert report["errors"] == []
    assert report["semantic_review"] == "required separately"
    assert "PASS" in result.stderr


def test_spec_checker_rejects_an_unknown_gate(spec_root):
    target = spec_root / "docs/specs/COURSEWEAVE.md"
    target.write_text(target.read_text().replace("| V00, V09 |", "| V99 |"))
    result = check(spec_root)
    assert result.returncode != 0
    assert "V99" in result.stdout + result.stderr


@pytest.mark.parametrize("filename,old,new,diagnostic", [
    ("COURSEWEAVE-TEACHER-EDITION.md", "| TE-002 |", "| TE-001 |", "duplicate"),
    ("COURSEWEAVE-STUDENT-EDITION.md", "| SE-002 |", "| CW-999 |", "owner"),
    ("COURSEWEAVE-STUDENT-EDITION.md", "author-edition-0.3.0-review-1", "other-bundle", "bundle"),
    ("COURSEWEAVE.md", '"conversation_memory": "session_only",', "", "conversation_memory"),
    ("COURSEWEAVE.md", "TE-013", "TE-999", "TE-999"),
    ("COURSEWEAVE.md", "(README.md)", "(missing-spec.md)", "missing-spec.md"),
])
def test_spec_checker_rejects_contract_drift(spec_root, filename, old, new, diagnostic):
    target = spec_root / "docs/specs" / filename
    text = target.read_text()
    if old == "TE-013":
        # A prose reference must resolve, just like references in tables.
        text += "\nSee TE-013 for content edits.\n"
    assert old in text
    target.write_text(text.replace(old, new))
    result = check(spec_root)
    assert result.returncode != 0
    assert diagnostic in result.stdout + result.stderr


def test_traceability_cannot_omit_or_rewrite_a_requirement(spec_root):
    target = spec_root / "docs/specs/traceability.csv"
    lines = target.read_text().splitlines()
    target.write_text("\n".join(lines[:1] + lines[2:]) + "\n")
    result = check(spec_root)
    assert result.returncode != 0
    assert "CW-001" in result.stdout


def test_spec_checker_rejects_invalid_fragment(spec_root):
    target = spec_root / "docs/specs/README.md"
    target.write_text(target.read_text() + "\n[Missing](COURSEWEAVE.md#does-not-exist)\n")
    result = check(spec_root)
    assert result.returncode != 0
    assert "does-not-exist" in result.stdout


def test_a_quoted_bundle_id_cannot_hide_a_mismatched_header(spec_root):
    target = spec_root / "docs/specs/COURSEWEAVE-STUDENT-EDITION.md"
    text = target.read_text().replace("author-edition-0.3.0-review-1", "different-bundle", 1)
    target.write_text(text + "\nPrevious bundle: `author-edition-0.3.0-review-1`.\n")
    result = check(spec_root)
    assert result.returncode != 0
    assert "bundle" in result.stdout


def test_prose_gate_references_must_resolve(spec_root):
    target = spec_root / "docs/specs/COURSEWEAVE-STUDENT-EDITION.md"
    target.write_text(target.read_text() + "\nSee V99 for the release check.\n")
    result = check(spec_root)
    assert result.returncode != 0
    assert "V99" in result.stdout
