"""Private project import never rewrites its selected source or student homes."""

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from courseweave.api import create_app


def test_project_creation_never_replaces_source(tmp_path):
    from courseweave.author.project import create_project, open_project
    source = tmp_path / "source"
    source.mkdir()
    (source / "lesson.md").write_text("Original lesson\n")
    project = create_project(source, tmp_path / "author-project", ("lesson.md",))
    assert (source / "lesson.md").read_text() == "Original lesson\n"
    assert (project.course_root / "lesson.md").read_text() == "Original lesson\n"
    assert project.state_root.parent == project.course_root.parent
    assert project.state_root != project.course_root
    assert open_project(tmp_path / "author-project") == project
    assert not (project.course_root / "courseweave.json").exists()


def test_inventory_excludes_private_files_and_preserves_duplicate_identities(tmp_path):
    from courseweave.author.project import inspect_source, create_project, read_sources
    source = tmp_path / "source"
    source.mkdir()
    for rel in ("lesson.md", "second.md", ".env", "state/records.json", ".git/config",
                ".venv/bin/python", "author-state/report.json", "chat.json", "__pycache__/x.pyc",
                "build/generated.js", "dist/wheel.whl", "cache/local.tmp", "courseweave.db"):
        p = source / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("private" if rel not in ("lesson.md", "second.md") else "Same lesson\n")
    inventory = inspect_source(source)
    assert [entry.path for entry in inventory.files] == ["lesson.md", "second.md"]
    project = create_project(source, tmp_path / "new-project", ("lesson.md", "second.md"),
                             expected_inventory=inventory.digest)
    sources = read_sources(project)
    assert len({entry.source_id for entry in sources}) == 2
    assert len({entry.raw_sha256 for entry in sources}) == 1
    assert all(entry.status == "candidate" and entry.redistribution == "undecided" for entry in sources)
    assert all(entry.intended_use == "author_reference" for entry in sources)
    assert sorted(p.name for p in project.course_root.iterdir()) == ["lesson.md", "second.md"]


@pytest.mark.parametrize("kind", ["symlink", "fifo", "excluded"])
def test_selected_unsafe_files_fail_before_destination_creation(tmp_path, kind):
    from courseweave.author.project import create_project, ProjectError
    source = tmp_path / "source"
    source.mkdir()
    if kind == "symlink":
        (source / "unsafe").symlink_to(tmp_path / "elsewhere")
    elif kind == "fifo":
        os.mkfifo(source / "unsafe")
    else:
        (source / ".env").write_text("synthetic-private-value")
    destination = tmp_path / "new-project"
    with pytest.raises(ProjectError):
        create_project(source, destination, (".env" if kind == "excluded" else "unsafe",))
    assert not destination.exists()


def test_import_preserves_existing_destination_and_rejects_stale_inventory(tmp_path):
    from courseweave.author.project import create_project, inspect_source, ProjectError
    source = tmp_path / "source"
    source.mkdir()
    (source / "lesson.md").write_text("Before")
    inventory = inspect_source(source)
    (source / "lesson.md").write_text("External revision")
    destination = tmp_path / "new-project"
    with pytest.raises(ProjectError, match="changed"):
        create_project(source, destination, ("lesson.md",), expected_inventory=inventory.digest)
    assert not destination.exists()
    destination.mkdir()
    (destination / "keep.txt").write_text("Keep")
    with pytest.raises(ProjectError):
        create_project(None, destination, ())
    assert (destination / "keep.txt").read_text() == "Keep"


def test_reviewed_inventory_binds_source_origin_even_for_identical_files(tmp_path):
    from courseweave.author.project import inspect_source, create_project, ProjectError
    first, second = tmp_path / "first", tmp_path / "second"
    for root in (first, second):
        root.mkdir()
        (root / "lesson.md").write_text("Same content, different origin")
    reviewed = inspect_source(first)
    with pytest.raises(ProjectError, match="changed"):
        create_project(second, tmp_path / "destination", ("lesson.md",), expected_inventory=reviewed.digest)


def test_inventory_limits_fail_without_partial_project(tmp_path, monkeypatch):
    from courseweave.author import project as service
    source = tmp_path / "source"
    source.mkdir()
    for name in ("one.md", "two.md", "three.md"):
        (source / name).write_text("12345")
    monkeypatch.setattr(service, "MAX_FILES", 2)
    with pytest.raises(service.ProjectError, match="limit"):
        service.inspect_source(source)
    monkeypatch.setattr(service, "MAX_FILES", 10000)
    monkeypatch.setattr(service, "MAX_BYTES", 10)
    with pytest.raises(service.ProjectError, match="limit"):
        service.create_project(source, tmp_path / "large-project", ("one.md",))
    assert not (tmp_path / "large-project").exists()


@pytest.mark.parametrize("name", [".git", ".env", "author-state", "state", "venv"])
def test_private_directories_cannot_be_selected_as_the_inventory_root(tmp_path, name):
    from courseweave.author.project import inspect_source, ProjectError
    root = tmp_path / name
    root.mkdir()
    (root / "ordinary.txt").write_text("Synthetic private state")
    with pytest.raises(ProjectError, match="private|runtime"):
        inspect_source(root)


def test_symlink_roots_cloud_paths_and_incomplete_projects_are_rejected(tmp_path):
    from courseweave.author.project import create_project, open_project, checked_local_path, ProjectError
    actual = tmp_path / "actual"
    actual.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(actual, target_is_directory=True)
    with pytest.raises(ProjectError):
        create_project(None, linked / "project", ())
    with pytest.raises(ProjectError):
        checked_local_path(Path.home() / "Library/Mobile Documents/course")
    with pytest.raises(ProjectError):
        open_project(actual)


def test_project_records_cannot_redirect_to_another_root(tmp_path):
    from courseweave.author.project import create_project, open_project, ProjectError
    project = create_project(None, tmp_path / "new-project", ())
    metadata = project.state_root / "project.json"
    data = json.loads(metadata.read_text())
    data["course_root"] = str(tmp_path / "student-course")
    metadata.write_text(json.dumps(data))
    with pytest.raises(ProjectError):
        open_project(tmp_path / "new-project")


def test_project_requests_are_bound_to_the_selected_project_not_global_state(tmp_path):
    home = tmp_path / "author-home"
    client = TestClient(create_app(capability_token="project-test", author_home=home))
    auth = {"Authorization": "Bearer project-test"}
    assert client.get("/api/author/projects").status_code == 403
    first = client.post("/api/author/projects", headers=auth, json={"project_id": "first", "selected_paths": []})
    second = client.post("/api/author/projects", headers=auth, json={"project_id": "second", "selected_paths": []})
    assert first.status_code == second.status_code == 201
    assert Path(first.json()["course_root"]) == home / "projects" / "first" / "course"
    a = {**auth, "X-CourseWeave-Project": "first"}
    b = {**auth, "X-CourseWeave-Project": "second"}
    for header, title in ((a, "First project"), (b, "Second project")):
        response = client.get("/api/course", headers=header)
        data = response.json()
        data["title"] = title
        saved = client.put("/api/course", headers={**header, "If-Match": response.headers["etag"],
            "Idempotency-Key": title, "X-CourseWeave-Origin": "student_requested"}, json=data)
        assert saved.status_code == 200, saved.text
    assert client.get("/api/course", headers=a).json()["title"] == "First project"
    assert client.get("/api/course", headers=b).json()["title"] == "Second project"
    assert client.get("/api/course", headers={**auth, "X-CourseWeave-Project": "../elsewhere"}).status_code == 422


def test_student_launch_cannot_discover_or_create_author_projects(tmp_path):
    client = TestClient(create_app(tmp_path, capability_token="student-test"))
    auth = {"Authorization": "Bearer student-test"}
    assert client.get("/api/author/projects", headers=auth).json() == {"enabled": False}
    assert client.post("/api/author/projects", headers=auth,
                       json={"project_id": "forbidden", "selected_paths": []}).status_code == 403


def test_source_decisions_are_human_reviewed_and_revision_checked(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "lesson.md").write_text("Review me")
    client = TestClient(create_app(capability_token="author", author_home=tmp_path / "home"))
    auth = {"Authorization": "Bearer author"}
    inventory = client.post("/api/author/projects/inventory", headers=auth,
                            json={"source_root": str(source)}).json()
    result = client.post("/api/author/projects", headers=auth, json={"project_id": "review",
        "source_root": str(source), "selected_paths": ["lesson.md"], "expected_inventory": inventory["digest"]})
    assert result.status_code == 201
    headers = {**auth, "X-CourseWeave-Project": "review"}
    record = client.get("/api/author/sources", headers=headers).json()["sources"][0]
    decision = {"revision": record["revision"], "title": "Reviewed lesson", "status": "approved",
                "intended_use": "student_material", "redistribution": "include", "review_note": "Owned original material"}
    url = f'/api/author/sources/{record["source_id"]}'
    saved = client.put(url, headers=headers, json=decision)
    assert saved.status_code == 200
    assert saved.json()["revision"] == record["revision"] + 1
    assert saved.json()["raw_sha256"] == record["raw_sha256"]
    assert client.put(url, headers=headers, json=decision).status_code == 409
    assert client.put(url, headers=headers, json={**decision, "snapshot_path": "../private"}).status_code == 422
    assert (source / "lesson.md").read_text() == "Review me"
