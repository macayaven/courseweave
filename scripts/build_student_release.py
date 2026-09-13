#!/usr/bin/env python3
"""Package a verified pilot receipt into a student release without rebuilding it."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tomllib


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


def course_version(archive_path: Path) -> str:
    try:
        with tarfile.open(archive_path) as archive:
            pyprojects = [member for member in archive.getmembers() if member.name == 'pyproject.toml']
            manifests = [member for member in archive.getmembers() if member.name == 'courseweave.json']
            licenses = [member for member in archive.getmembers() if member.name == 'LICENSE']
            if len(pyprojects) != 1 or not pyprojects[0].isfile():
                raise ValueError('Course archive must contain one regular root pyproject.toml.')
            if len(manifests) != 1 or not manifests[0].isfile():
                raise ValueError('Course archive must contain one regular root courseweave.json.')
            if len(licenses) != 1 or not licenses[0].isfile():
                raise ValueError('Course archive must contain one regular root LICENSE.')
            if pyprojects[0].size > 256 * 1024:
                raise ValueError('Course archive root pyproject.toml is unexpectedly large.')
            stream = archive.extractfile(pyprojects[0])
            if stream is None:
                raise ValueError('Course archive root pyproject.toml could not be read.')
            metadata = tomllib.loads(stream.read().decode('utf-8'))
    except tomllib.TOMLDecodeError:
        raise ValueError('Course archive root pyproject.toml is unreadable or malformed.') from None
    except ValueError:
        raise
    except (OSError, tarfile.TarError, UnicodeError):
        raise ValueError('Course archive root pyproject.toml is unreadable or malformed.') from None
    try:
        version = metadata['project']['version']
    except (KeyError, TypeError):
        raise ValueError('Course archive root pyproject.toml has no [project].version.') from None
    if not isinstance(version, str) or len(version) > 64 or not SAFE_VERSION.fullmatch(version):
        raise ValueError('Course archive [project].version is not a safe release version.')
    return version


def build(receipt_path: Path, output: Path):
    receipt = json.loads(receipt_path.read_text())
    source = receipt_path.parent
    course = next(item for item in receipt['source_archives'] if item['repository'] == 'agent-harness-path')
    inputs = {
        'wheel': (source / receipt['wheel'], receipt['wheel_sha256']),
        'course': (source / course['path'], course['sha256']),
        'constraints': (source / receipt['runtime_constraints'], receipt['runtime_constraints_sha256']),
    }
    for path, digest in inputs.values():
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f'Receipted artifact hash does not match: {path.name}')
    version = course_version(inputs['course'][0])
    output.mkdir(parents=True, exist_ok=False)
    files = {}
    for key, (path, digest) in inputs.items():
        name = path.name if key == 'wheel' else ('course.tar' if key == 'course' else 'requirements.txt')
        shutil.copy2(path, output / name)
        files[key] = {'path': name, 'sha256': digest}
    project = Path(__file__).resolve().parents[1]
    shutil.copy2(project / 'LICENSE', output / 'LICENSE')
    shutil.copy2(project / 'scripts/student_pilot.py', output / 'student_pilot.py')
    shutil.copy2(project / 'docs/pilot/STUDENT-README.md', output / 'README.md')
    start = output / 'Start Course.command'
    start.write_text(START)
    start.chmod(0o755)
    release = {
        'format_version': 1, 'platform_commit': receipt['platform_commit'],
        'course_commit': receipt['course_commit'], 'course_version': version, 'files': files,
        'launcher_sha256': hashlib.sha256((output / 'student_pilot.py').read_bytes()).hexdigest(),
        'supported_target': 'macOS, single-user student pilot, S01–S14; twelve notebooks and two optional practical protocols',
    }
    if receipt.get('delivery_commit'):
        release['delivery_commit'] = receipt['delivery_commit']
    (output / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
    print(f'Student release: {output}\nStart: {start}\nApplication wheel SHA256: {receipt["wheel_sha256"]}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.receipt, args.output)
