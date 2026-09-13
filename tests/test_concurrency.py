from __future__ import annotations


import concurrent.futures
import hashlib
from pathlib import Path

from courseweave.manifest import load_manifest, manifest_bytes, parse_manifest_data
from courseweave.store import CourseStore


def _manifest_data(title: str = "Concurrent Course") -> dict:
    data = {'schema_version': 2,
     'id': 'concurrent-course',
     'title': 'Concurrent Course',
     'description': '',
     'entry_module_id': 'start',
     'policies': {'content_sharing': 'explicit_only',
                  'allowed_share_kinds': ['selection'],
                  'max_shared_chars': 8192,
                  'allowed_proposal_types': ['course', 'profile', 'workspace'],
                  'durable_mutation': 'proposal_or_direct_student_action',
                  'terminal_execution': 'student_only',
                  'conversation_memory': 'session_only',
                  'workspace_write_globs': ['work/*.txt']},
     'modules': [{'id': 'start',
                  'title': 'Start',
                  'description': '',
                  'phases': [{'id': 'read',
                              'title': 'Read',
                              'progress': 'required',
                              'experience': {'type': 'builtin', 'id': 'reading'},
                              'surfaces': [{'id': 'lesson',
                                            'purpose': 'primary',
                                            'type': 'markdown',
                                            'label': 'lesson',
                                            'path': 'lesson.md'}],
                              'completion': {'requirements': [{'id': 'acknowledgement',
                                                               'type': 'learner_record',
                                                               'record_kind': 'attestation',
                                                               'prompt': 'Confirm completion of '
                                                                         'Read.'}]},
                              'teacher': {'access': {'mode': 'available', 'requires': []},
                                          'guidance': {'style': {'type': 'builtin',
                                                                 'id': 'explanatory'},
                                                       'hint_level': 'gentle'},
                                          'sharing': {'allow': ['selection']},
                                          'proposals': {'allow': ['profile',
                                                                  'course',
                                                                  'workspace']}}}]}]}
    data['title'] = title
    return data


def _accept(root: str, key: str) -> tuple[str, str]:
    try:
        proposal = CourseStore(Path(root)).accept_proposal(
            "workspace-one", 1, key
        )
        return ("ok", proposal.status)
    except Exception as exc:  # noqa: BLE001 - serialize worker outcome for parent
        return ("error", type(exc).__name__)


def _edit(root: str, key: str) -> tuple[str, str]:
    try:
        proposal = CourseStore(Path(root)).edit_proposal(
            "workspace-one",
            1,
            {"summary": "Edited", "payload": {"content": "edited\n", "diff": ""}},
            key,
        )
        return ("ok", proposal.status)
    except Exception as exc:  # noqa: BLE001 - serialize worker outcome for parent
        return ("error", type(exc).__name__)


def _manifest_save(root: str, title: str, etag: str, key: str) -> tuple[str, str]:
    try:
        store = CourseStore(Path(root))
        manifest = parse_manifest_data(_manifest_data(title), Path(root))
        snapshot = store.save_course_manifest(manifest, etag, key)
        return ("ok", snapshot.manifest.title)
    except Exception as exc:  # noqa: BLE001 - serialize worker outcome for parent
        return ("error", type(exc).__name__)


def _course_root(tmp_path: Path) -> Path:
    (tmp_path / "lesson.md").write_text("# Lesson\n", encoding="utf-8")
    (tmp_path / "work").mkdir()
    manifest = parse_manifest_data(_manifest_data(), tmp_path)
    (tmp_path / "courseweave.json").write_bytes(manifest_bytes(manifest))
    return tmp_path


def test_two_processes_cannot_apply_workspace_proposal_twice(tmp_path: Path) -> None:
    root = _course_root(tmp_path)
    target = root / "work" / "answer.txt"
    target.write_text("before\n", encoding="utf-8")
    store = CourseStore(root)
    store.create_proposal(
        {
            "id": "workspace-one",
            "type": "workspace_file_replace",
            "origin": "teacher_suggested",
            "summary": "Replace",
            "target": {"path": "work/answer.txt"},
            "payload": {"content": "after\n", "diff": ""},
            "target_hash": hashlib.sha256(target.read_bytes()).hexdigest(),
        },
        "create",
    )
    with concurrent.futures.ProcessPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                _accept,
                [str(root), str(root)],
                ["accept-a", "accept-b"],
            )
        )
    assert sum(result[0] == "ok" for result in results) == 1
    assert target.read_text(encoding="utf-8") == "after\n"
    assert CourseStore(root).get_state().audit.__len__() == 1


def test_accept_and_edit_serialize_to_one_winner(tmp_path: Path) -> None:
    root = _course_root(tmp_path)
    target = root / "work" / "answer.txt"
    target.write_text("before\n", encoding="utf-8")
    CourseStore(root).create_proposal(
        {
            "id": "workspace-one",
            "type": "workspace_file_replace",
            "origin": "teacher_suggested",
            "summary": "Replace",
            "target": {"path": "work/answer.txt"},
            "payload": {"content": "after\n", "diff": ""},
            "target_hash": hashlib.sha256(target.read_bytes()).hexdigest(),
        },
        "create",
    )
    with concurrent.futures.ProcessPoolExecutor(max_workers=2) as pool:
        accept_future = pool.submit(_accept, str(root), "accept")
        edit_future = pool.submit(_edit, str(root), "edit")
        results = [accept_future.result(), edit_future.result()]
    assert sum(result[0] == "ok" for result in results) == 1


def test_concurrent_manifest_compare_and_swap_has_one_winner(tmp_path: Path) -> None:
    root = _course_root(tmp_path)
    raw = (root / "courseweave.json").read_bytes()
    etag = f'"{hashlib.sha256(raw).hexdigest()}"'
    with concurrent.futures.ProcessPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                _manifest_save,
                [str(root), str(root)],
                ["Title A", "Title B"],
                [etag, etag],
                ["manifest-a", "manifest-b"],
            )
        )
    assert sum(result[0] == "ok" for result in results) == 1
    assert load_manifest(root).title in {"Title A", "Title B"}
