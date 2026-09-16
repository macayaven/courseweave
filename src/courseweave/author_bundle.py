"""Build a portable Author release from explicitly hashed local artifacts."""
from email.parser import BytesParser
import gzip
import hashlib
from importlib.metadata import distribution
from importlib.resources import files
import io
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import zipfile

from .author_launcher import VERSION, load_release, local_path
from .student_bundle import START


README = '''# CourseWeave Author Edition v0.3.0

Create and revise local courses, inspect sources and reviewed changes, try the actual Student experience, and hand off a course.
This folder is a separate Author candidate. Keep it together on nonsynced local storage, outside cloud Drive, Desktop and Documents.

## Start

On macOS, open **Start Author.command**. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) if requested.
If macOS asks for permission, use Finder's Open action. First setup needs internet and installs pinned Python/Jupyter dependencies.
No source checkout, Node, existing Jupyter installation or API key is needed. Later starts reuse these private environments.
The launcher prints your Author home. Projects live under `workspace/projects`; preview study homes under `workspace/previews`.
Your existing courses and Student homes are separate. Keep the Terminal window open; Ctrl-C stops the owned session.

## Make a course

1. Create a project, or inspect and import an explicit local course directory into a private copy. Inspect omissions before import.
2. Select course/module/activity scope. Add supported Markdown or notebook content, objectives, self-checks and course requirements.
3. Import a local reference or explicitly fetch a permitted public URL. Inspect provenance and excerpts; approve sources for assistant use
   and decide distribution rights separately. Search snippets are discovery evidence, not verified quotations or permission to redistribute.
4. Optionally ask the one Author assistant to act as curator, curriculum designer, source researcher, fact checker, proofreader or
   compatibility reviewer. Read the role, selection, source scope and omissions. A reply is a suggestion. Save useful reports explicitly.
5. Inspect each pending change's exact diff, then review/apply that revision. One file or manifest changes atomically. Stale proposals
   cannot overwrite newer work. Notebook cell IDs remain stable; source notebooks are output-free when exported.
6. Check alignment and deterministic Student compatibility. A model explanation cannot override a failed check.
7. Inspect an export inventory, specify course version and destination, then create the standard handoff. Missing/unsupported content
   produces an explicit error or labeled draft. Include your course license and required attribution.
8. Prepare Student preview from the saved snapshot, choosing released v0.2.0 or candidate v0.3.0. The assistant is off by default.
   This is a real separate study environment. Run notebooks, save with Cmd-S, try native checks and inspect optional unaided gates.
   Stop preview and choose Keep or Discard. Starting a preview does not record activity completion.
9. Build a generic Student bundle from the saved export. Share that bundle's Start Course.command and README with permitted course content.

The course's schema-v2 rules and learning records are authoritative. Progress records authored requirements, not demonstrated mastery.
Optional unaided work retains its assistance restrictions. Imported code is not executed during structural validation or source research;
explicit preview setup installs course dependencies, and pressing Run executes notebook code.

## Optional model and source search

Both are off by default, even when your terminal contains keys. Nothing automatically loads a .env file.
For this launch only, prompt for a hidden model key (and optionally a hidden Brave Search API key):

```sh
./"Start Author.command" --provider openai --model YOUR_MODEL
./"Start Author.command" --provider openai --model YOUR_MODEL --base-url https://your-gateway.example/v1 --search-key
./"Start Author.command" --provider anthropic --model YOUR_MODEL
```

Automation may explicitly select `--provider-env` using COURSEWEAVE_PROVIDER and the selected provider's MODEL/API_KEY variables;
use `--search-key-env` to select BRAVE_SEARCH_API_KEY. Existing protected credential tools can supply those process variables.
Keys are kept out of notebook kernels. Text-only model responses are supported; native model tools are not required.
Model/search calls may incur provider charges. Research stays network-off until an explicit research action and configured permission;
public URL/redirect policy, allow/deny lists, bounded requests and cancellation still apply. Every source requires human approval.
Conversation and Brave discovery results are session-only. Search result URLs, titles and snippets are excluded from saved reports
and backups; reopening a research report requires a new explicit search to view results. Direct source fetches retain their own
provenance and review decisions. Respect publisher terms before retaining or redistributing source pages. Each author supplies their
own search account key; no key is distributed. Deliberately saved reports, source snapshots and changes persist separately.

## Setup, restart and recovery

```sh
./"Start Author.command" setup --home /local/path/to/new-author-home
./"Start Author.command" check --home /local/path/to/new-author-home
./"Start Author.command" --no-provider --home /local/path/to/new-author-home --port 8767
```

Use the same --home to resume. Check verifies all release hashes and existing runtime without creating a workspace or using credentials.
A changed build uses a different default home. Restore a private backup into a new home/project to move work; do not copy runtime state.
If setup is interrupted, repeat setup. Saved projects are preserved. If another session owns the port, use its window or choose another port.
Do not remove an unrelated process or lock file. After a crash, reopen Author: reviewed changes reconcile from exact file hashes;
interrupted previews show retained files and explicit Stop/Keep/Discard actions. Orphaned export staging is inspectable and removable.

Under **Backup and recovery**, select optional saved artifacts, inspect the inventory, and create a new private .tar backup.
Saved course files, current source snapshots and applied-change provenance are included. Chat, credential custody, runtimes,
Student notebooks/records, previews and delivery outputs are excluded. Keep authored/imported secrets out of course content.
To restore, inspect the archive, choose a new project ID and select Restore as new project. Existing projects are never overwritten;
recovered pending drafts and reports require fresh review. Incomplete/damaged archives are rejected before project creation.
A disk failure during copying leaves an incomplete new project; choose a fresh destination after resolving storage, preserving the original.
Back up retained Student notebooks and export their learning records separately using the Student bundle's README.

## Contents, reproduction and limits

release.json names exact file hashes and the application source commit. The source .tar.gz contains the versioned source, tests,
frontend lockfile/build inputs, setup and release runbooks. requirements.txt pins the application/isolated-kernel runtime dependencies.
student-inputs.json binds the included released Student v0.2.0 and candidate v0.3.0 wheels. No runtime or machine credential is bundled.
Rebuild with the source archive's docs/RELEASING.md and scripts/build_author_release.py; preserve the separately released v0.2.0 input.
Installation still needs the Python/package registries: this is not an offline installer or a signed/notarized macOS application.

Supported target: single-user local macOS, Python 3.11 application and Python 3.12 isolated notebook kernels, JupyterLab 4.6.3,
schema-v2 courses. Generic Markdown-only and notebook course handoffs are supported. Local video is blocked in paired handoffs because
released Student v0.2.0 cannot authenticate that playback; use a permitted HTTPS video surface. Desktop/narrow UI checks are automated;
screen-reader usability, learner timing, learning gains, general production readiness and external compliance are not established.
Acceptance and independent-review records identify the exact tested candidate and any open gates. Packaging alone is not acceptance.

The root LICENSE is the CourseWeave application PolyForm Shield license, which is not an OSI open-source license.
See THIRD_PARTY_LICENSES.md for included dependencies. Each course keeps its own license/attribution; new author content retains its ownership.
'''


def digest(path: Path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build_bundle(inputs: dict, output: Path, *, platform_commit: str) -> dict:
    if set(inputs) != {'wheel', 'student_wheel', 'constraints', 'source'} or not re.fullmatch(r'[a-f0-9]{40}', platform_commit):
        raise ValueError('Select the exact application/source, released Student wheel, constraints and source commit.')
    output = local_path(output, 'bundle destination')
    normalized = {}
    for kind, (path, expected) in inputs.items():
        path = local_path(path, kind + ' input')
        if not path.is_file() or path.stat().st_size > 512 * 1024 * 1024 or digest(path) != expected:
            raise ValueError('Receipted artifact hash differs: ' + kind)
        normalized[kind] = (path, expected)
    for kind, version in [('wheel', VERSION), ('student_wheel', '0.2.0')]:
        with zipfile.ZipFile(normalized[kind][0]) as archive:
            records = [item for item in archive.infolist() if item.filename.endswith('.dist-info/METADATA')]
            if len(records) != 1 or records[0].file_size > 1024 * 1024:
                raise ValueError('Invalid wheel metadata: ' + kind)
            metadata = BytesParser().parsebytes(archive.read(records[0]))
            if metadata.get('Name') != 'courseweave' or metadata.get('Version') != version:
                raise ValueError('The wheel does not identify the required application version: ' + kind)
    with tarfile.open(normalized['source'][0]) as archive:
        metadata = archive.getmember(f'courseweave-{VERSION}/PKG-INFO')
        if not metadata.isfile() or metadata.size > 1024 * 1024:
            raise ValueError('Source archive metadata is invalid.')
        with archive.extractfile(metadata) as stream:
            package = BytesParser().parsebytes(stream.read())
        if package.get('Name') != 'courseweave' or package.get('Version') != VERSION:
            raise ValueError('Source archive version differs from the Author application.')
    output.mkdir(parents=True, exist_ok=False)
    records = {}
    def record(kind, name):
        records[kind] = {'path': name, 'sha256': digest(output / name)}
    for kind, (path, expected) in normalized.items():
        name = 'requirements.txt' if kind == 'constraints' else path.name
        if (output / name).exists():
            raise ValueError('Release artifact filenames overlap.')
        shutil.copyfile(path, output / name)
        if digest(output / name) != expected:
            raise ValueError('An input changed during copying. Choose a new bundle destination.')
        record(kind, name)
    for kind, name in [('author_launcher', 'author_launcher.py'), ('student_launcher', 'student_launcher.py')]:
        (output / name).write_bytes(files('courseweave').joinpath(name).read_bytes()); record(kind, name)
    for kind, name in [('license', 'LICENSE'), ('third_party', 'THIRD_PARTY_LICENSES.md')]:
        text = distribution('courseweave').read_text('licenses/' + name)
        if not text:
            raise ValueError('Installed application license is missing: ' + name)
        (output / name).write_text(text); record(kind, name)
    start = output / 'Start Author.command'
    start.write_text(START.replace('student_pilot.py', 'author_launcher.py')); start.chmod(0o755); record('start', start.name)
    (output / 'README.md').write_text(README); record('readme', 'README.md')
    catalog = {'format': 'courseweave-student-inputs-v1', 'runtimes': {}}
    for version, kind in [('0.2.0', 'student_wheel'), (VERSION, 'wheel')]:
        catalog['runtimes'][version] = {'wheel': records[kind]['path'], 'wheel_sha256': records[kind]['sha256'],
            'constraints': records['constraints']['path'], 'constraints_sha256': records['constraints']['sha256']}
    (output / 'student-inputs.json').write_text(json.dumps(catalog, indent=2) + '\n'); record('student_inputs', 'student-inputs.json')
    release = {'format': 'courseweave-author-release-v1', 'application_version': VERSION,
               'platform_commit': platform_commit, 'files': records,
               'scope': 'Local macOS candidate; installation, live-provider, course and independent-review acceptance are separate.'}
    with (output / 'release.json').open('x') as stream:
        json.dump(release, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    load_release(output)
    return release


def pack_bundle(bundle: Path, destination: Path):
    bundle = local_path(bundle, 'bundle source'); destination = local_path(destination, 'archive destination')
    release = load_release(bundle)
    names = sorted([item['path'] for item in release['files'].values()] + ['release.json'])
    # Flat allowlist: author data, caches and unrelated files cannot enter a release.
    with destination.open('xb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for name in names:
                data = (bundle / name).read_bytes()
                member = tarfile.TarInfo(f'CourseWeave Author Edition v{VERSION}/' + name)
                member.size = len(data); member.mode = 0o755 if name.endswith('.command') else 0o644
                archive.addfile(member, io.BytesIO(data))
    return {'path': destination.name, 'sha256': digest(destination)}
