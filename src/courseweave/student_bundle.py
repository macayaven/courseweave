#!/usr/bin/env python3
"""Build a generic Student bundle from exact local runtime and course inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import os
import tarfile
import tomllib
from importlib.resources import files as resource_files
from importlib.metadata import distribution

from .student_launcher import archive_members, local_path, safe_course_id, safe_course_version


START = '''#!/bin/sh
set -u
RELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  printf '%s\\n' 'CourseWeave needs uv for its isolated Python setup.' 'Install uv: https://docs.astral.sh/uv/getting-started/installation/' 'Then open this Start command again.' >&2
  if [ -t 0 ]; then printf 'Press Enter to close.'; read -r answer; fi
  exit 1
fi
BOOTSTRAP_PYTHON=$(uv --no-config run --no-project --python 3.11 python -I -c 'import sys; print(sys.executable)') || exit $?
exec "$BOOTSTRAP_PYTHON" -I "$RELEASE_DIR/student_pilot.py" "$@"
'''

SAFE_VERSION = re.compile(r'[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*')


def _digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def course_metadata(archive_path: Path) -> dict:
    try:
        with tarfile.open(archive_path) as archive:
            members = archive_members(archive)
            pyprojects = [member for member in members if member.name == 'pyproject.toml']
            manifests = [member for member in members if member.name == 'courseweave.json']
            licenses = [member for member in members if member.name.casefold().startswith(('license', 'copying')) and '/' not in member.name]
            if len(manifests) != 1 or not manifests[0].isfile():
                raise ValueError('Course archive must contain one regular root courseweave.json.')
            if not licenses or any(not member.isfile() for member in licenses):
                raise ValueError('Course archive must include its root LICENSE/ownership notice.')
            def read(member, maximum=1024 * 1024):
                if not member.isfile() or member.size > maximum:
                    raise ValueError('Course metadata is invalid or exceeds its size bound.')
                with archive.extractfile(member) as stream:
                    return stream.read().decode('utf-8')
            manifest = json.loads(read(manifests[0]))
            course_id = safe_course_id(manifest.get('id'))
            if manifest.get('schema_version') != 2:
                raise ValueError('Course manifest must use schema version 2.')
            packages = [member for member in members if member.name == 'COURSEWEAVE-PACKAGE.json']
            if packages:
                package = json.loads(read(packages[0], maximum=8 * 1024 * 1024))
                if package.get('format') != 'courseweave-package-v1' or package.get('kind') != 'student_handoff':
                    raise ValueError('A draft archive cannot become a Student bundle. Export a standard handoff.')
                if package.get('course_id') != course_id:
                    raise ValueError('Package identity differs from the course manifest.')
                version = safe_course_version(package.get('course_version'))
                report = package.get('compatibility', {})
                if not report or any(issue.get('severity') == 'error' for name in
                    ('structural', 'assets', 'links', 'profile_issues', 'not_performed') for issue in report.get(name, [])):
                    raise ValueError('The package has unresolved deterministic errors.')
            else:
                if len(pyprojects) != 1 or not pyprojects[0].isfile():
                    raise ValueError('A legacy course archive needs pyproject.toml with its version; new Markdown courses use package metadata.')
                metadata = tomllib.loads(read(pyprojects[0], maximum=256 * 1024))
                version = safe_course_version(metadata.get('project', {}).get('version'))
            notebook_runtime = manifest.get('runtime') is not None
            if notebook_runtime and (len(pyprojects) != 1 or not any(member.name == 'uv.lock' and member.isfile() for member in members)):
                raise ValueError('A notebook course requires its root pyproject.toml and uv.lock.')
            return {'course_id': course_id, 'course_version': version, 'notebook_runtime': notebook_runtime}
    except tomllib.TOMLDecodeError:
        raise ValueError('Course archive root pyproject.toml is unreadable or malformed.') from None
    except ValueError:
        raise
    except (OSError, tarfile.TarError, UnicodeError):
        raise ValueError('Course archive root pyproject.toml is unreadable or malformed.') from None


def student_readme(metadata: dict) -> str:
    return f'''# CourseWeave Student — {metadata['course_id']} v{metadata['course_version']}

Keep this folder together on nonsynced local storage. On macOS, open **Start Course.command**.
If macOS asks for permission, use Finder's Open action. Install uv first if the launcher reports it missing:
https://docs.astral.sh/uv/getting-started/installation/

First setup needs internet and installs the included application wheel and pinned runtime inputs in a separate study home.
A notebook course also installs its own root pyproject.toml and frozen uv.lock in an isolated kernel environment.
Setup is an explicit dependency-installation action; review the course publisher and its license before starting.
A Markdown-only course needs no course Python project. Imported code is never run merely by exporting or checking metadata.

The study home is selected by course ID, version and package hash. Your course copy, notebooks and learning records live there.
The launcher prints its path. Reopen the same Start command to resume; Ctrl-C in its terminal stops the owned session.
Choose an activity in the outline; use native notebook Run/Run All and save with Cmd-S. Progress records authored requirements;
it does not certify mastery. Optional unaided work follows the course's assistance restrictions.

## Explicit terminal commands

Run these from this bundle's directory (quote paths containing spaces):

```sh
./Start\\ Course.command setup --home /local/path/to/new-study
./Start\\ Course.command check --no-provider --home /local/path/to/new-study
./Start\\ Course.command --no-provider --port 8766 --home /local/path/to/new-study
./Start\\ Course.command inspect --home /local/path/to/new-study
./Start\\ Course.command export --output /local/path/to/new-records.json --home /local/path/to/new-study
./Start\\ Course.command reset --confirm --home /local/path/to/new-study
```

Use the same --home for every command when you choose a custom home. Stop the course before reset. Reset clears learning records
and preferences while keeping notebooks. Export records and separately copy saved notebooks before removing a study home.
Never select an existing unrelated folder. A changed package requires a new home; no old edition is overwritten.

## Optional assistant

The assistant is off by default. Use `--provider openai --model MODEL` (optionally `--base-url URL`) or
`--provider anthropic --model MODEL` for a hidden API-key prompt valid for this launch only.
Automation can use `--provider-env` with explicit COURSEWEAVE_PROVIDER, OPENAI_MODEL/OPENAI_API_KEY or
ANTHROPIC_MODEL/ANTHROPIC_API_KEY in its terminal. Only the selected provider variables are passed to the application;
keys are excluded from notebook kernels. No .env file is loaded. Source search is an Author feature.

## Recovery and scope

`check` verifies bundled file hashes and checks existing installation without creating a study home. If setup is interrupted,
rerun the same command; the launcher repairs its runtime and preserves saved course files. A damaged release needs a new copy.
If a port is occupied, return to that course or select another --port. Do not delete another session's files or processes.

`release.json` names exact runtime and course hashes. COURSEWEAVE-PACKAGE.json inside the course records performed checks
and checks not performed. Packaging alone does not prove live provider behavior, factual accuracy or learning outcomes.
Supported target: single-user local macOS, schema-v2 courses, separate Student v0.2.0/v0.3.0 application inputs.

The root LICENSE covers the CourseWeave application (PolyForm Shield, not an OSI open-source license).
The course archive retains the course publisher's separate license and attribution. New author content retains its ownership.
'''


def build(receipt_path: Path, output: Path):
    receipt = json.loads(receipt_path.read_text())
    source = receipt_path.parent
    if len(receipt['source_archives']) != 1:
        raise ValueError('Select exactly one course source archive in the receipt.')
    course = receipt['source_archives'][0]
    inputs = {
        'wheel': (source / receipt['wheel'], receipt['wheel_sha256']),
        'course': (source / course['path'], course['sha256']),
        'constraints': (source / receipt['runtime_constraints'], receipt['runtime_constraints_sha256']),
    }
    return build_bundle(inputs, output, provenance={key: receipt[key] for key in ('platform_commit', 'course_commit', 'delivery_commit') if key in receipt})


def build_bundle(inputs: dict, output: Path, *, provenance: dict | None = None, application_license: str | None = None):
    output = local_path(output, 'bundle destination')
    if set(inputs) != {'wheel', 'course', 'constraints'}:
        raise ValueError('Select exactly one wheel, course archive and runtime constraints input.')
    inputs = {key: (local_path(path, key + ' input'), digest) for key, (path, digest) in inputs.items()}
    for key, (path, digest) in inputs.items():
        if not path.is_file() or path.stat().st_size > 1024 * 1024 * 1024 or _digest(path) != digest:
            raise ValueError(f'Receipted artifact hash does not match: {key}')
    metadata = course_metadata(inputs['course'][0])
    application_license = application_license or distribution('courseweave').read_text('licenses/LICENSE')
    if not application_license:
        raise ValueError('The installed application license is unavailable.')
    output.mkdir(parents=True, exist_ok=False)
    files = {}
    for key, (path, digest) in inputs.items():
        name = path.name if key == 'wheel' else ('course.tar' if key == 'course' else 'requirements.txt')
        shutil.copy2(path, output / name)
        if _digest(output / name) != digest:
            raise ValueError(f'{key} changed during bundle preparation. The incomplete destination cannot be launched; choose a new destination.')
        (output / name).chmod(0o600)
        files[key] = {'path': name, 'sha256': digest}
    (output / 'LICENSE').write_text(application_license)
    (output / 'student_pilot.py').write_bytes(resource_files('courseweave').joinpath('student_launcher.py').read_bytes())
    (output / 'README.md').write_text(student_readme(metadata))
    start = output / 'Start Course.command'
    start.write_text(START)
    start.chmod(0o755)
    release = {
        'format_version': 2, **(provenance or {}), **metadata, 'files': files,
        'launcher_sha256': hashlib.sha256((output / 'student_pilot.py').read_bytes()).hexdigest(),
        'supported_target': 'macOS, single-user local Student, schema-v2 course; installed and learning acceptance are separate',
    }
    # The complete release descriptor is the readiness marker. An interrupted
    # directory without it cannot be launched or mistaken for a finished bundle.
    with (output / 'release.json').open('x') as stream:
        stream.write(json.dumps(release, indent=2) + '\n'); stream.flush(); os.fsync(stream.fileno())
    return release


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.receipt, args.output)
