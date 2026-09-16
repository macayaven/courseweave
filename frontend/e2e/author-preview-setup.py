"""Installed acceptance setup/capture helper. Never use a real student home."""
import hashlib
import json
import os
from pathlib import Path
import sys
import webbrowser
import socket


def main():
    mode, source_arg, case_arg, catalog_arg = sys.argv[1:]
    source, case, catalog = map(Path, (source_arg, case_arg, catalog_arg))
    from courseweave.author.project import checked_local_path
    for path in (source, case, catalog):
        checked_local_path(path)
    home = case / 'author-home'
    if mode == 'seed':
        from courseweave.author.project import create_project, inspect_source, read_sources, update_source
        from courseweave.author.delivery import ExportRequest, export_course, inspect_delivery
        from courseweave.author.quality import student_profile
        from courseweave.store import CourseStore
        inventory = inspect_source(source)
        (home / 'projects').mkdir(parents=True, mode=0o700)
        project = create_project(source, home / 'projects/preview-practice', tuple(f.path for f in inventory.files))
        store = CourseStore(project.course_root, state_dir=project.state_root / 'transactions')
        for record in read_sources(project):
            update_source(project, store, record.source_id, record.revision,
                {'status': 'approved', 'intended_use': 'student_material', 'redistribution': 'include',
                 'review_note': 'Explicit automated decision for the versioned acceptance fixture; not a human editorial review.'})
        plan = inspect_delivery(project, student_profile())
        selection = ExportRequest(project_revision=plan['project_revision'], inventory_sha256=plan['inventory_sha256'],
            source_decisions_sha256=plan['source_decisions_sha256'], course_version='1.0.0', kind='student_handoff',
            selected_paths=tuple(f['path'] for f in plan['files'] if f['selected']))
        receipt = export_course(project, case / 'preview-course.tar', student_profile(), selection)
        (case / 'seed.json').write_text(json.dumps({'category': 'installed service fixture preparation',
            'export_id': receipt.export_id, 'package_sha256': receipt.package_sha256,
            'original_files': {f.path: f.sha256 for f in inventory.files}}, indent=2) + '\n')
        return
    if mode != 'launch':
        raise ValueError('Choose seed or launch.')
    counter = 0

    def capture(url):
        nonlocal counter
        path = case / 'bootstrap' / f'open-{counter:04d}'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(url)
        counter += 1
        return True

    webbrowser.open = capture
    from courseweave.cli import app
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    app(['author', '--home', str(home), '--port', str(port), '--student-inputs', str(catalog)])


if __name__ == '__main__':
    main()
