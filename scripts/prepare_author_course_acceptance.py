#!/usr/bin/env python3
"""Prepare the exact AHP faithful control and disclosed repair using installed Author services.

This is release acceptance, not imported-code execution or a learning record.
Run with an explicitly selected installed Author Python, outside the source tree.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

from courseweave.author.content import ContentEdit, apply_change, change_diff, read_content, stage_manual_change
from courseweave.author.delivery import ExportRequest, build_student_handoff, export_course, inspect_delivery
from courseweave.author.project import checked_local_path, create_project, inspect_source, read_sources, update_source
from courseweave.author.quality import student_profile
from courseweave.store import CourseStore


def prepare(source, destination, catalog):
    source = checked_local_path(source); destination = checked_local_path(destination)
    catalog = checked_local_path(catalog)
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != 'c90aa1d84d3b1b1c21a5d263de03c4cb198f55c6':
        raise ValueError('Select the pinned public Agent Harness Path reference.')
    before = inspect_source(source)
    destination.mkdir(parents=True, exist_ok=False)
    project = create_project(source, destination / 'author-project', tuple(f.path for f in before.files), expected_inventory=before.digest)
    store = CourseStore(project.course_root, state_dir=project.state_root / 'transactions')
    for record in read_sources(project):
        update_source(project, store, record.source_id, record.revision,
            {'status': 'approved', 'intended_use': 'student_material', 'redistribution': 'include',
             'review_note': 'Pinned public course material selected for the authorized acceptance copy. Preserve original licenses and attribution.'})
    def request(kind):
        plan = inspect_delivery(project, student_profile())
        return ExportRequest(project_revision=plan['project_revision'], inventory_sha256=plan['inventory_sha256'],
            source_decisions_sha256=plan['source_decisions_sha256'], course_version='0.2.0', kind=kind,
            selected_paths=tuple(f['path'] for f in plan['files'] if f['selected'] and not f['blocked_reasons']))
    faithful_request = request('draft')
    faithful = export_course(project, destination / 'faithful-course.tar', student_profile(), faithful_request)
    if [(issue.code, issue.location) for issue in faithful.compatibility.links] != [('fragment_missing', '/files/labs/s01_loop.md')]:
        raise ValueError('Faithful baseline diagnostics differ from the reviewed one-fragment exception.')
    with tarfile.open(faithful.destination) as archive:
        for file in before.files:
            if file.path in faithful_request.selected_paths:
                assert hashlib.sha256(archive.extractfile(file.path).read()).hexdigest() == file.sha256, file.path
    snapshot = read_content(project, 'labs/s01_loop.md')
    old, new = 'README.md#wire-contract-so---replay-matches', 'README.md#Wire-contract-%28so---replay-matches%29'
    assert snapshot['text'].count(old) == 1
    change = stage_manual_change(project, ContentEdit(path='labs/s01_loop.md', before_exists=True,
        before_sha256=snapshot['sha256'], project_revision=snapshot['project_revision'], manifest_sha256=snapshot['manifest_sha256'],
        action={'kind': 'markdown_replace', 'text': snapshot['text'].replace(old, new)}))
    diff = change_diff(project, change.change_id)
    assert old in str(diff) and new in str(diff)
    apply_change(project, change.change_id, 0, 'reviewed-jupyter-fragment-repair', context_digest=change.context_digest)
    corrected = export_course(project, destination / 'course.tar', student_profile(), request('student_handoff'))
    assert corrected.compatibility.passed
    included = {}
    with tarfile.open(corrected.destination) as archive:
        for file in before.files:
            if file.path in faithful_request.selected_paths:
                data = archive.extractfile(file.path).read(); actual = hashlib.sha256(data).hexdigest(); included[file.path] = actual
                if file.path != 'labs/s01_loop.md': assert actual == file.sha256, file.path
        manifest = json.loads(archive.extractfile('courseweave.json').read())
    assert len(manifest['modules']) == 14
    assert len([name for name in included if name.endswith('.ipynb')]) == 12
    bundles = [build_student_handoff(project, corrected.export_id, destination / ('Student ' + version), catalog, version)
               for version in ['0.2.0', '0.3.0']]
    assert inspect_source(source) == before
    receipt = {'classification': 'installed Author service import/export; Student rendered/execution acceptance is separate',
        'source_commit': commit, 'original_inventory_sha256': before.digest, 'original_preserved': True,
        'faithful': faithful.model_dump(mode='json'), 'corrected': corrected.model_dump(mode='json'),
        'disclosed_change': {'path': 'labs/s01_loop.md', 'old': old, 'new': new, 'change_id': change.change_id},
        'included_sha256': included, 'modules': 14, 'notebooks': 12, 'bundles': bundles}
    (destination / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--student-inputs', type=Path, required=True)
    args = parser.parse_args()
    result = prepare(args.source, args.destination, args.student_inputs)
    print(json.dumps({'original_preserved': result['original_preserved'], 'modules': result['modules'],
                      'notebooks': result['notebooks'], 'package_sha256': result['corrected']['package_sha256']}))
