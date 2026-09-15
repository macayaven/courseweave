"""Private selected backups reopen as new projects without replay authority."""
import hashlib
import io
import json
from pathlib import Path
import tarfile

import pytest

from courseweave.author import content
from courseweave.author.contracts import MarkdownDraft
from courseweave.author.project import ProjectError, open_project, read_sources, update_source
from courseweave.store import CourseStore
from test_author_content import project, context_for
from test_author_assistant import project as review_project


def create_backup(project, path, categories=('changes',)):
    from courseweave.author.backup import inspect_backup, backup_project
    plan = inspect_backup(project, categories)
    return backup_project(project, path, categories, plan['inventory_sha256'])


def test_backup_restore_preserves_selected_content_and_revocation_without_replay(project, tmp_path):
    from courseweave.author.backup import restore_backup
    ctx = context_for(project)
    pending = content.stage_change(project, ctx, MarkdownDraft(kind='markdown_replace', text='Pending reviewed draft'))
    rejected = content.stage_change(project, ctx, MarkdownDraft(kind='markdown_replace', text='Rejected draft'))
    content.reject_change(project, rejected.change_id, 0)
    source = read_sources(project)[0]
    update_source(project, CourseStore(project.course_root, state_dir=project.state_root/'transactions'),
        source.source_id, source.revision, {'status': 'rejected', 'redistribution': 'exclude'})
    for root in (project.state_root, project.course_root):
        (root/'.env').write_text('planted-private-key')
    (project.state_root/'conversation.json').write_text('planted-session-conversation')
    backup = create_backup(project, tmp_path/'private.tar')
    raw = (tmp_path/'private.tar').read_bytes()
    assert b'planted-private-key' not in raw and b'planted-session-conversation' not in raw
    assert b'Saved student output' in raw  # Exact authored source copy, not the separate student's notebook.
    before = (project.course_root/'lesson.md').read_bytes()
    restored = restore_backup(tmp_path/'private.tar', tmp_path/'restored', backup['archive_sha256'])
    assert restored.project_id == 'restored' and open_project(tmp_path/'restored') == restored
    assert (restored.course_root/'lesson.md').read_bytes() == before
    assert read_sources(restored) == read_sources(project)
    assert content.read_change(restored, pending.change_id).status == 'stale'
    assert content.read_change(restored, rejected.change_id).status == 'rejected'
    for change in (pending, rejected):
        with pytest.raises(ProjectError):
            content.apply_change(restored, change.change_id, 0, 'old-context', context_digest=ctx.digest)
    assert (project.course_root/'lesson.md').read_bytes() == before
    assert not (restored.state_root/'conversation.json').exists()
    with pytest.raises(ProjectError, match='exists|new'):
        restore_backup(tmp_path/'private.tar', project.course_root.parent, backup['archive_sha256'])


def test_backup_selection_and_stale_review_are_explicit(project, tmp_path):
    from courseweave.author.backup import inspect_backup, backup_project, restore_backup
    ctx = context_for(project)
    content.stage_change(project, ctx, MarkdownDraft(kind='markdown_replace', text='Private candidate'))
    plan = inspect_backup(project, ())
    (project.course_root/'lesson.md').write_text('New external content')
    with pytest.raises(ProjectError, match='changed|review'):
        backup_project(project, tmp_path/'stale.tar', (), plan['inventory_sha256'])
    assert not (tmp_path/'stale.tar').exists()
    backup = create_backup(project, tmp_path/'core.tar', ())
    restored = restore_backup(tmp_path/'core.tar', tmp_path/'core-restore', backup['archive_sha256'])
    assert content.list_changes(restored)['changes'] == []
    assert b'Private candidate' not in (tmp_path/'core.tar').read_bytes()


def test_saved_review_disposition_survives_restore_but_references_are_stale(review_project, tmp_path):
    from courseweave.author.backup import restore_backup
    from courseweave.author.quality import save_review, read_review, update_review, FindingDecision
    from test_author_quality import reviewed
    ctx, reply, _ = reviewed(review_project)
    report = save_review(review_project, ctx, reply)
    report = update_review(review_project, report.report_id, report.findings[0].claim_id,
        FindingDecision(revision=0, human_disposition='dismissed', reason='Reviewed example; retain this decision.'))
    backup = create_backup(review_project, tmp_path/'reports.tar', ('reviews',))
    restored = restore_backup(tmp_path/'reports.tar', tmp_path/'review-restore', backup['archive_sha256'])
    current = read_review(restored, report.report_id)
    assert current.project_id == 'review-restore' and current.status == 'stale'
    assert current.findings[0].human_disposition == 'dismissed'
    assert current.findings[0].disposition_reason == 'Reviewed example; retain this decision.'
    assert current.summary == report.summary


@pytest.mark.parametrize('damage', ['truncated', 'future', 'extra', 'traversal', 'symlink', 'missing-source', 'hash'])
def test_partial_or_incompatible_backup_is_rejected_before_new_project(project, tmp_path, damage):
    from courseweave.author.backup import restore_backup
    create_backup(project, tmp_path/'good.tar', ())
    with tarfile.open(tmp_path/'good.tar') as archive:
        files = {m.name: archive.extractfile(m).read() for m in archive}
    if damage == 'future':
        data = json.loads(files['COURSEWEAVE-AUTHOR-BACKUP.json']);data['format'] = 999
        files['COURSEWEAVE-AUTHOR-BACKUP.json'] = json.dumps(data).encode()
    elif damage == 'extra': files['author-state/credentials.json'] = b'planted-key'
    elif damage == 'traversal': files['../outside.txt'] = b'No'
    elif damage == 'hash': files['course/lesson.md'] = b'Unreviewed replacement'
    elif damage == 'missing-source':
        del files[next(name for name in files if name.endswith('/raw'))]
    bad = tmp_path/'bad.tar'
    with tarfile.open(bad, 'w') as archive:
        for name, raw in files.items():
            item = tarfile.TarInfo(name);item.size = len(raw)
            archive.addfile(item, io.BytesIO(raw))
        if damage == 'symlink':
            item = tarfile.TarInfo('course/redirect');item.type = tarfile.SYMTYPE;item.linkname = '/tmp'
            archive.addfile(item)
    if damage == 'truncated': bad.write_bytes(bad.read_bytes()[:1300])
    with pytest.raises(ProjectError):
        restore_backup(bad, tmp_path/'new-project', hashlib.sha256(bad.read_bytes()).hexdigest())
    assert not (tmp_path/'new-project').exists()
    assert not (tmp_path/'outside.txt').exists()


def test_private_api_requires_reviewed_backup_and_new_restore_identity(project, tmp_path):
    from fastapi.testclient import TestClient
    from courseweave.api import create_app
    home = tmp_path/'author-home'
    app = create_app(project.course_root, state_dir=project.state_root/'transactions', capability_token='backup-test-capability', author_project=project)
    headers = {'Authorization': 'Bearer backup-test-capability'}
    with TestClient(app) as client:
        assert client.post('/api/author/backups/inspect', json={'categories': []}).status_code == 403
        plan = client.post('/api/author/backups/inspect', headers=headers, json={'categories': []})
        assert plan.status_code == 200, plan.text
        body = {'categories': [], 'destination': str(tmp_path/'api-backup.tar'), 'inventory_sha256': plan.json()['inventory_sha256']}
        result = client.post('/api/author/backups', headers=headers, json=body)
        assert result.status_code == 201, result.text
    # Restore is an Author-home action, available even when no project is open.
    root = create_app(project.course_root, capability_token='backup-test-capability', author_home=home)
    with TestClient(root) as client:
        inspected = client.post('/api/author/projects/restore/inspect', headers=headers, json={'archive': body['destination']})
        assert inspected.status_code == 200, inspected.text
        restore = {'archive': body['destination'], 'archive_sha256': inspected.json()['archive_sha256'], 'project_id': 'restored-api'}
        response = client.post('/api/author/projects/restore', headers=headers, json=restore)
        assert response.status_code == 201, response.text
        assert response.json()['project_id'] == 'restored-api'
        assert client.post('/api/author/projects/restore', headers=headers, json=restore).status_code == 409
        assert open_project(home/'projects/restored-api').revision > project.revision
