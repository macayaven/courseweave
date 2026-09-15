"""Explicit, reproducible course snapshots through the canonical author lock.

Structural checks never run imported code, install dependencies or fetch URLs.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import tarfile
import tempfile
import tomllib
from urllib.parse import unquote, urlsplit
from uuid import uuid4
from typing import Literal
from email.parser import BytesParser
import zipfile

import mistune
from pydantic import Field

from ..contracts.models import ArtifactExistsRequirement, ClosedModel
from ..contracts.primitives import LocalPath, local_path
from ..engine.manifest import _local_sources, parse_manifest_data
from .content import _imported_file_sources, _lock, _recover, output_free_notebook
from .contracts import ExportReceipt, InventoryFile, Revision, Sha256, StudentProfile, ValidationIssue
from .project import (
    ProjectError, _copy_selected, atomic_bytes, checked_local_path, excluded_path,
    inspect_source, local_directory, open_project, read_private, read_sources, source_file,
)
from .quality import check_manifest, student_profile

MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_LINKS = 10_000
MAX_EXPORTS = 200
PACKAGE_METADATA = "COURSEWEAVE-PACKAGE.json"
PACKAGE_SETUP = "COURSEWEAVE-SETUP.md"
RESERVED = {PACKAGE_METADATA.casefold(), PACKAGE_SETUP.casefold()}
_MARKDOWN = mistune.create_markdown(renderer="ast")


class DeliveryError(ProjectError):
    pass


class ExportRequest(ClosedModel):
    project_revision: Revision
    inventory_sha256: Sha256
    source_decisions_sha256: Sha256
    course_version: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$")
    kind: str = Field(pattern=r"^(?:draft|student_handoff)$")
    selected_paths: tuple[LocalPath, ...] = Field(min_length=1, max_length=10_000)


class RuntimeInput(ClosedModel):
    wheel: LocalPath
    wheel_sha256: Sha256
    constraints: LocalPath
    constraints_sha256: Sha256


class StudentInputs(ClosedModel):
    format: Literal['courseweave-student-inputs-v1']
    runtimes: dict[Literal['0.2.0', '0.3.0'], RuntimeInput] = Field(min_length=1, max_length=2)


def student_inputs(path: Path | None) -> StudentInputs:
    if path is None:
        raise DeliveryError('Student runtime inputs are not configured. Start Author from a complete release bundle or provide --student-inputs.')
    path = checked_local_path(path)
    try:
        return StudentInputs.model_validate_json(read_private(path.parent, path.name, max_bytes=32 * 1024))
    except ValueError:
        raise DeliveryError('The Student runtime input descriptor is invalid. Use verified release inputs.') from None


def read_export(project, export_id: str) -> ExportReceipt:
    if not re.fullmatch(r'export-[a-f0-9]{32}', export_id):
        raise DeliveryError('Choose a saved export receipt.')
    try:
        receipt = ExportReceipt.model_validate_json(read_private(project.state_root, 'exports/' + export_id + '.json', max_bytes=8 * 1024 * 1024))
        if receipt.project_id != project.project_id or receipt.export_id != export_id:
            raise ValueError()
        return receipt
    except ValueError:
        raise DeliveryError('The saved export receipt is invalid; create a new reviewed export.') from None


def build_student_handoff(project, export_id: str, destination: Path, catalog_path: Path | None, version: str) -> dict:
    from ..student_bundle import build_bundle
    destination = checked_local_path(destination)
    if destination.is_relative_to(project.course_root.parent):
        raise DeliveryError('Create Student bundles outside the working author project.')
    catalog = student_inputs(catalog_path)
    if version not in catalog.runtimes:
        raise DeliveryError('The selected Student version has no configured verified runtime inputs.')
    runtime = catalog.runtimes[version]
    catalog_root = checked_local_path(catalog_path).parent
    inputs = {}
    for kind in ('wheel', 'constraints'):
        name = getattr(runtime, kind)
        with source_file(catalog_root, name) as file_fd, os.fdopen(os.dup(file_fd), 'rb') as stream:
            if os.fstat(file_fd).st_size > 256 * 1024 * 1024 or hashlib.file_digest(stream, 'sha256').hexdigest() != getattr(runtime, kind + '_sha256'):
                raise DeliveryError('Student runtime input hash differs from its descriptor: ' + kind)
            if kind == 'wheel':
                try:
                    stream.seek(0)
                    with zipfile.ZipFile(stream) as wheel:
                        records = [name for name in wheel.namelist() if name.endswith('.dist-info/METADATA')]
                        if len(records) != 1 or wheel.getinfo(records[0]).file_size > 1024 * 1024:
                            raise ValueError()
                        metadata = BytesParser().parsebytes(wheel.read(records[0]))
                        if metadata.get('Name', '').casefold() != 'courseweave' or metadata.get('Version') != version:
                            raise ValueError()
                except (ValueError, zipfile.BadZipFile):
                    raise DeliveryError('The configured wheel does not identify the selected Student version.') from None
        inputs[kind] = (catalog_root / name, getattr(runtime, kind + '_sha256'))
    with _lock(project):
        _recover(project)
        receipt = read_export(project, export_id)
        if receipt.kind != 'student_handoff' or not receipt.compatibility.passed:
            raise DeliveryError('Choose a standard export with no deterministic errors.')
        inputs['course'] = (receipt.destination, receipt.package_sha256)
        with local_directory(project.state_root / 'bundles', create=True) as directory:
            if len(os.listdir(directory)) >= MAX_EXPORTS:
                raise DeliveryError('Student bundle receipt limit reached; archive this author project.')
        try:
            release = build_bundle(inputs, destination)
        except (ValueError, OSError) as exc:
            raise DeliveryError('Student bundle could not be completed: ' + str(exc)) from None
        result = {'bundle_id': 'bundle-' + uuid4().hex, 'export_id': export_id,
            'package_sha256': receipt.package_sha256, 'student_version': version,
            'wheel_sha256': runtime.wheel_sha256, 'constraints_sha256': runtime.constraints_sha256,
            'launcher_sha256': release['launcher_sha256'], 'destination': str(destination),
            'created_at': datetime.now(timezone.utc).isoformat()}
        atomic_bytes(project.state_root / 'bundles' / (result['bundle_id'] + '.json'), _json(result))
        return result


def _json(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def _hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _issue(code: str, path: str, message: str, severity="error") -> ValidationIssue:
    return ValidationIssue(code=code, location=("/files/" + path)[:1000],
        message=(path + ": " + message)[:2000], severity=severity)


class _HTMLReferences(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.anchors: set[str] = set()
        self.style = False

    def css(self, value):
        self.links.extend(match[1] for match in re.findall(r"url\(\s*(['\"]?)(.*?)\1\s*\)", value, re.I))
        self.links.extend(re.findall(r"@import\s+['\"]([^'\"]+)['\"]", value, re.I))

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        self.anchors.update(v for k, v in attrs if k in {"id", "name"} and v)
        for key in ("href", "src", "poster", "xlink:href"):
            if values.get(key):
                self.links.append(values[key])
        if values.get("srcset"):
            self.links.extend(part.strip().split()[0] for part in values["srcset"].split(",") if part.strip())
        if values.get("style"):
            self.css(values["style"])
        if tag == "style":
            self.style = True

    def handle_endtag(self, tag):
        if tag == "style":
            self.style = False

    def handle_data(self, data):
        if self.style:
            self.css(data)


def _heading_text(node):
    if node.get("type") in {"image", "inline_html"}:
        return ""
    return unescape(node.get("raw", "")) + "".join(_heading_text(child) for child in node.get("children", ()))


def _references(path: str, raw: bytes) -> tuple[list[str], set[str]]:
    suffix = Path(path).suffix.casefold()
    if suffix not in {".md", ".html", ".htm", ".svg", ".css", ".ipynb"}:
        return [], set()
    if len(raw) > (8 * 1024 * 1024 if suffix == ".ipynb" else MAX_TEXT_BYTES):
        raise DeliveryError("Linked-content validation limit exceeded for " + path)
    try:
        text = raw.decode("utf-8")
        parser = _HTMLReferences()
        if suffix in {".html", ".htm", ".svg"}:
            parser.feed(text)
        elif suffix == ".css":
            parser.css(text)
        else:
            texts = [text] if suffix == ".md" else ["".join(c["source"]) if isinstance(c["source"], list) else c["source"]
                for c in output_free_notebook(json.loads(text))["cells"] if c["cell_type"] == "markdown"]
            for value in texts:
                stack = list(_MARKDOWN(value))
                while stack:
                    node = stack.pop()
                    if node["type"] in {"link", "image"}:
                        parser.links.append(node["attrs"]["url"])
                    elif node["type"] in {"block_html", "inline_html"}:
                        parser.feed(node["raw"])
                    elif node["type"] == "heading":
                        # JupyterLab's renderMarkdown.createHeaderId preserves
                        # case and punctuation and replaces literal spaces.
                        parser.anchors.add(_heading_text(node).replace(" ", "-"))
                    stack.extend(node.get("children", ()))
        parser.close()
        if len(parser.links) > MAX_LINKS:
            raise DeliveryError("Link count limit exceeded in " + path)
        return parser.links, parser.anchors
    except (ValueError, UnicodeError, KeyError, TypeError, RecursionError):
        raise DeliveryError("Linked content is invalid or unsupported: " + path) from None


def _resolve_link(source: str, href: str) -> tuple[str | None, str]:
    if len(href) > 4096:
        raise DeliveryError("A link exceeds the supported length in " + source)
    value = urlsplit(href)
    if value.scheme in {"https", "http", "mailto"}:
        return None, ""
    if value.scheme or value.netloc or value.query or "\\" in href:
        raise DeliveryError("Unsafe or unsupported link in " + source)
    path = unquote(value.path)
    if path.startswith("/"):
        raise DeliveryError("A link escapes the course in " + source)
    target = posixpath.normpath(posixpath.join(posixpath.dirname(source), path)) if path else source
    try:
        local_path(target)
    except ValueError:
        raise DeliveryError("A link escapes the course in " + source) from None
    return target, unquote(value.fragment)


def _required(manifest, files) -> tuple[set[str], set[str]]:
    required = {"courseweave.json"}
    directories = set()
    for path, directory, _, source, _ in _local_sources(manifest):
        if isinstance(source, ArtifactExistsRequirement):
            continue  # These are future student artifacts, not distribution inputs.
        if directory:
            if path != ".":
                if excluded_path(path):
                    raise DeliveryError("A declared directory is private: " + path)
                directories.add(path)
        else:
            required.add(path)
    required.update(name for name in files if Path(name).parent == Path(".") and
        (name.casefold().startswith(("license", "copying", "notice")) or name.casefold() == "readme.md"))
    if manifest.runtime is not None:
        required.update(("pyproject.toml", "uv.lock"))
    return required, directories


def _snapshot_manifest(project):
    try:
        data = json.loads(read_private(project.course_root, "courseweave.json", max_bytes=1024 * 1024))
        return data, parse_manifest_data(data, project.course_root)
    except ValueError:
        raise DeliveryError("Save a valid schema-v2 manifest before preparing a course export.") from None


def _inspection(project, profile) -> dict:
    inventory = inspect_source(project.course_root)
    data, manifest = _snapshot_manifest(project)
    files = {file.path: file for file in inventory.files}
    bindings = _imported_file_sources(project)
    sources = {source.source_id: source for source in read_sources(project)}
    required, directories = _required(manifest, files)
    selected, pending, parsed = set(required), deque(sorted(required)), {}
    issues, total_links = [], 0
    while pending:
        name = pending.popleft()
        if name not in files or name in parsed:
            continue
        file = files[name]
        if Path(name).suffix.casefold() not in {".md", ".html", ".htm", ".svg", ".css", ".ipynb"}:
            parsed[name] = ([], set())
            continue
        raw = read_private(project.course_root, name, max_bytes=8 * 1024 * 1024)
        if _hash(raw) != file.sha256:
            raise DeliveryError("Course files changed; inspect the export inventory again.")
        links, anchors = _references(name, raw)
        parsed[name] = (links, anchors)
        total_links += len(links)
        if total_links > MAX_LINKS:
            raise DeliveryError("Package link limit reached (10,000).")
        for href in links:
            target, _ = _resolve_link(name, href)
            if target is not None and target not in selected:
                selected.add(target)
                pending.append(target)
    entries = []
    for name, file in sorted(files.items()):
        source = sources.get(bindings.get(name))
        blocked = []
        if name.casefold() in RESERVED:
            blocked.append("This is generated package metadata; it is recreated in the export.")
        elif bindings.get(name) and source is None:
            blocked.append("The imported source association is unavailable.")
        elif source and (source.status != "approved" or source.intended_use != "student_material" or source.redistribution != "include"):
            blocked.append("Review the imported source as approved student material with redistribution included.")
        with source_file(project.course_root, name) as fd:
            executable = bool(os.fstat(fd).st_mode & 0o111)
        entries.append(file.model_dump() | {"selected": name in selected and name.casefold() not in RESERVED,
            "source_id": source.source_id if source else None, "blocked_reasons": blocked, "executable": executable})
    for name in sorted(selected - files.keys()):
        issues.append(_issue("linked_asset_missing", name, "Required or linked material is absent from the course inventory."))
    identity = [{k: f[k] for k in ("path", "sha256", "size", "executable")} for f in entries]
    report = check_manifest(data, project.course_root, profile)
    return {"project_revision": open_project(project.course_root.parent).revision,
        "course_id": manifest.id, "inventory_sha256": _hash(_json(identity)),
        "source_decisions_sha256": _hash(_json({"sources": [s.model_dump(mode="json") for s in sources.values()], "bindings": bindings})),
        "files": entries, "omitted": [item.model_dump() for item in inventory.omitted],
        "required_paths": sorted(selected), "directories": sorted(directories),
        "compatibility": report.model_dump(mode="json") | {"passed": report.passed},
        "selection_issues": [issue.model_dump(mode="json") for issue in issues]}


def inspect_delivery(project, profile: StudentProfile) -> dict:
    with _lock(project):
        _recover(project)
        return _inspection(project, profile)


def _validate_snapshot(root: Path, profile: StudentProfile, paths: set[str]):
    data = json.loads(read_private(root, "courseweave.json", max_bytes=1024 * 1024))
    manifest = parse_manifest_data(data, root)
    report = check_manifest(data, root, profile)
    # Every standard package promises the released Student target. Selecting
    # candidate diagnostics cannot bypass an observed released-reader limit.
    if profile.application_version != '0.2.0':
        released = check_manifest(data, root, student_profile('0.2.0'))
        report = report.model_copy(update={'profile_issues': report.profile_issues + tuple(
            issue for issue in released.profile_issues
            if issue.severity == 'error' and issue not in report.profile_issues)})
    issues, parsed, total_links = [], {}, 0
    for name in sorted(paths):
        with source_file(root, name) as fd:
            prefix = os.read(fd, 43)
        if prefix == b"version https://git-lfs.github.com/spec/v1\n":
            issues.append(_issue("lfs_pointer", name, "Include actual file bytes, not a Git LFS pointer."))
        if Path(name).suffix.casefold() in {".md", ".html", ".htm", ".svg", ".css", ".ipynb"}:
            parsed[name] = _references(name, read_private(root, name, max_bytes=8 * 1024 * 1024))
            total_links += len(parsed[name][0])
            if total_links > MAX_LINKS:
                raise DeliveryError("Package link limit reached (10,000).")
    for name, (links, _) in parsed.items():
        for href in links:
            target, fragment = _resolve_link(name, href)
            if target is None:
                continue  # The receipt explicitly records no external URL verification.
            if target not in paths:
                issues.append(_issue("linked_asset_missing", name, "Linked file is not selected: " + target))
            elif fragment and (target not in parsed or fragment not in parsed[target][1]):
                issues.append(_issue("fragment_missing", name, "Linked fragment is not present: " + target + "#" + fragment))
    if not any(Path(name).parent == Path('.') and name.casefold().startswith(('license', 'copying')) for name in paths):
        issues.append(_issue("course_license_missing", "LICENSE", "Include the course's own license/ownership notice."))
    if manifest.runtime is not None:
        for name in ("pyproject.toml", "uv.lock"):
            try:
                tomllib.loads(read_private(root, name, max_bytes=MAX_TEXT_BYTES).decode('utf-8'))
            except (ProjectError, ValueError, UnicodeError):
                issues.append(_issue("runtime_input_missing", name, "Include valid declared notebook runtime inputs; dependency installation is a separate check."))
    if len(issues) > 9999:
        omitted = len(issues) - 9998
        issues = issues[:9998] + [_issue("issue_limit", "", f"{omitted} further link or asset issues omitted; fix these and export again.")]
    unchecked = ValidationIssue(code="external_links_not_checked", location="", severity="not_performed",
        message="External URLs, executable resources and dependency installation were not fetched or executed during export.")
    return report.model_copy(update={"links": tuple(issues), "not_performed": (
        *(issue for issue in report.not_performed if issue.code != "linked_assets_not_checked"), unchecked)})


def export_payload(receipt: ExportReceipt) -> dict:
    result = receipt.model_dump(mode="json")
    result["compatibility"]["passed"] = receipt.compatibility.passed
    return result


def list_exports(project, *, offset=0) -> dict:
    with _lock(project):
        _recover(project)
        with local_directory(project.state_root / "exports", create=True) as directory:
            names = sorted(os.listdir(directory))
        if len(names) > MAX_EXPORTS:
            raise DeliveryError("Export receipt limit exceeded.")
        reports = []
        for name in names:
            if not re.fullmatch(r"export-[a-f0-9]{32}\.json", name):
                raise DeliveryError("Unrecognized export receipt; inspect project recovery.")
            try:
                report = ExportReceipt.model_validate_json(read_private(project.state_root, "exports/" + name, max_bytes=8 * 1024 * 1024))
            except ValueError:
                raise DeliveryError("An export receipt is damaged; inspect project recovery.") from None
            reports.append(report)
        reports.sort(key=lambda r: r.created_at, reverse=True)
        return {"exports": [export_payload(r) for r in reports[offset:offset + 20]],
            "next_offset": offset + 20 if offset + 20 < len(reports) else None}


def export_course(project, destination: Path, profile: StudentProfile, request: ExportRequest) -> ExportReceipt:
    from ..student_launcher import archive_members
    request = ExportRequest.model_validate(request)
    destination = checked_local_path(destination)
    if destination.suffix != ".tar" or destination.exists():
        raise DeliveryError("Choose a new .tar file for the course export.")
    if destination.is_relative_to(project.course_root.parent):
        raise DeliveryError("Export outside the working author project.")
    with local_directory(destination.parent) as parent, _lock(project):
        _recover(project)
        plan = _inspection(project, profile)
        if any(getattr(request, key) != plan[key] for key in ("project_revision", "inventory_sha256", "source_decisions_sha256")):
            raise DeliveryError("Export review is stale; files or source decisions changed. Inspect the inventory again.")
        files = {file["path"]: file for file in plan["files"]}
        selected = set(request.selected_paths)
        if len({name.casefold() for name in request.selected_paths}) != len(request.selected_paths):
            raise DeliveryError("Export paths collide; select each file once with its exact spelling.")
        for name in selected:
            if excluded_path(name) or name not in files or files[name]["blocked_reasons"]:
                raise DeliveryError("File is excluded, unavailable or lacks a distribution decision: " + name)
        if "courseweave.json" not in selected:
            raise DeliveryError("The course manifest must be included.")
        if request.kind == "student_handoff" and (set(plan["required_paths"]) - selected):
            raise DeliveryError("Required or linked files are missing from the reviewed selection.")
        with local_directory(project.state_root / "exports", create=True) as exports_fd:
            if len(os.listdir(exports_fd)) >= MAX_EXPORTS:
                raise DeliveryError("Export receipt limit reached; archive this author project.")
        export_id = "export-" + uuid4().hex
        staging_root = Path(tempfile.mkdtemp(prefix=".courseweave-export-", dir=destination.parent))
        stage = staging_root / "course"
        stage.mkdir()
        archive_name = "." + export_id + ".tar"
        try:
            for name in sorted(selected):
                reviewed = InventoryFile(**{key: files[name][key] for key in ("path", "size", "sha256")})
                _copy_selected(project.course_root, reviewed, (stage / name,))
                if name.casefold().endswith(".ipynb"):
                    before = read_private(stage, name, max_bytes=8 * 1024 * 1024)
                    notebook = json.loads(before)
                    cleaned = output_free_notebook(notebook)
                    if notebook != cleaned:
                        atomic_bytes(stage / name, _json(cleaned), replace=True)
            for directory in plan["directories"]:
                with local_directory(stage / directory, create=True):
                    pass
            compatibility = _validate_snapshot(stage, profile, selected)
            if request.kind == "student_handoff" and not compatibility.passed:
                details = [issue.code + " " + issue.location for group in (compatibility.structural, compatibility.assets,
                    compatibility.links, compatibility.profile_issues) for issue in group if issue.severity == "error"]
                raise DeliveryError("Course handoff has deterministic errors: " + "; ".join(details[:6]))
            inventory = tuple(InventoryFile(path=file.path, size=file.size, sha256=file.sha256) for file in inspect_source(stage).files)
            inventory_sha256 = _hash(_json([file.model_dump(mode="json") for file in inventory]))
            compatibility = compatibility.model_copy(update={"inventory_sha256": inventory_sha256})
            metadata = {"format": "courseweave-package-v1", "course_id": plan["course_id"], "course_version": request.course_version,
                "kind": request.kind, "student_compatibility_target": "0.2.0", "inventory": [file.model_dump(mode="json") for file in inventory],
                "directories": plan["directories"], "compatibility": compatibility.model_dump(mode="json")}
            atomic_bytes(stage / PACKAGE_METADATA, _json(metadata))
            label = "DRAFT — incomplete course; not a Student handoff" if request.kind == "draft" else "Course source snapshot"
            atomic_bytes(stage / PACKAGE_SETUP, (f"# {label}\n\nCourse: {plan['course_id']} · Version {request.course_version}\n\n"
                "Keep the course manifest, selected assets and course license together. This archive contains no application runtime. "
                "Use a separately installed CourseWeave Student v0.2.0 or v0.3.0, or a generated macOS Student bundle. "
                "A notebook course includes its root pyproject.toml and uv.lock; install its dependencies in an isolated kernel environment. "
                "A Markdown-only course does not require a course Python project.\n\n"
                "Deterministic checks and checks not performed are recorded in COURSEWEAVE-PACKAGE.json. "
                "Export does not establish installed, editorial or learning acceptance. Notebook outputs are cleared only in this copy.\n").encode())
            current = _inspection(project, profile)
            if any(current[key] != plan[key] for key in ("project_revision", "inventory_sha256", "source_decisions_sha256")):
                raise DeliveryError("Course changed while preparing the export; inspect it again.")
            fd = os.open(archive_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, "wb") as stream:
                with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for directory in plan["directories"]:
                        info = tarfile.TarInfo(directory); info.type = tarfile.DIRTYPE; info.mode = 0o755
                        archive.addfile(info)
                    for name in sorted([*selected, PACKAGE_METADATA, PACKAGE_SETUP]):
                        with source_file(stage, name) as file_fd, os.fdopen(os.dup(file_fd), "rb") as content:
                            info = tarfile.TarInfo(name); info.size = os.fstat(file_fd).st_size
                            info.mode = 0o755 if name in files and files[name]["executable"] else 0o644
                            archive.addfile(info, content)
                stream.flush(); os.fsync(stream.fileno())
            with source_file(destination.parent, archive_name) as file_fd, os.fdopen(os.dup(file_fd), "rb") as content:
                try:
                    with tarfile.open(fileobj=content) as archive:
                        archive_members(archive)
                except ValueError as exc:
                    raise DeliveryError(str(exc)) from None
                content.seek(0)
                digest = hashlib.file_digest(content, "sha256").hexdigest()
            receipt = ExportReceipt(export_id=export_id, project_id=project.project_id, project_revision=plan["project_revision"],
                course_id=plan["course_id"], course_version=request.course_version, destination=destination,
                package_sha256=digest, inventory=inventory, compatibility=compatibility, kind=request.kind,
                created_at=datetime.now(timezone.utc))
            try:
                os.link(archive_name, destination.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                raise DeliveryError("Export destination appeared while preparing; nothing was replaced.") from None
            os.fsync(parent)
            atomic_bytes(project.state_root / "exports" / (export_id + ".json"), (receipt.model_dump_json(indent=2) + "\n").encode())
            return receipt
        finally:
            os.unlink(archive_name, dir_fd=parent) if (destination.parent / archive_name).exists() else None
            shutil.rmtree(staging_root)
