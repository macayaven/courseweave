# Releasing CourseWeave

This runbook prepares a public application release. CourseWeave and Agent Harness
Path remain separate repositories with independent versions: the course stays in
`macayaven/agent-harness-path`, and the application stays in
`macayaven/courseweave`. The course remains usable through its standalone route;
CourseWeave is an optional interface.

The selected release uses final v0.2.0 package bytes. Prepare changes under
Unreleased/Draft, freeze the candidate commit and date for review, then publish
those v0.2.0 artifacts as an explicitly marked GitHub prerelease. Public-download
acceptance promotes that same release and unchanged bytes to latest. A failed
candidate stays a prerelease or draft and produces a newly built candidate; do
not relabel release-candidate package bytes as final v0.2.0. Never reuse `0.1.0`:
the compatible local pilot wheel has that metadata but differs from the public
v0.1.0 artifact.

## 1. Freeze release inputs

- Select an exact clean application commit and an exact public course commit.
- Confirm the course commit uses schema version 2, is available from the public
  course repository, and is the commit named by its own release notes.
- Start from the locally verified candidate pair when assessing drift:
  application `f1134590cced78a6bd5202062178eba1f1edc0ae`, course
  `585b45eb3186404b8445cae64126ab9929c22b87`.
- Record the application tree, course archive SHA-256, lockfile hashes, built
  wheel/sdist hashes, Python/Jupyter/Node/pnpm/uv versions, and all commands run.
- Confirm the selected license is present in `LICENSE` and represented correctly
  in package metadata and release assets. There is no license at present, so this
  gate is open.
- Verify `SECURITY.md` names a working confidential reporting route. If GitHub private
  vulnerability reporting is enabled, test the repository advisory link; if it
  remains disabled, verify the documented maintainer address is current.

Before freezing or rebuilding the selected v0.2.0 candidate:

```sh
git status --short
git rev-parse HEAD
git diff --exit-code
git diff --cached --exit-code
rg -n '__version__|"version"' \
  src/courseweave/__init__.py \
  frontend/package.json frontend/apps/*/package.json \
  frontend/packages/*/package.json \
  src/courseweave/labextension/package.json \
  src/courseweave/labextension/schemas/@courseweave/lab/package.json.orig
```

Confirm every version-bearing Python and bundled frontend/JupyterLab metadata
file remains 0.2.0. Build fresh outputs after any source update; do not patch
generated bundles by hand. Confirm `courseweave --version`, wheel metadata,
JupyterLab extension metadata, changelog, release-note title, and tag agree.

## 2. Make the public path portable

- Use `scripts/build_student_release.py` to produce the same seven-file bundle
  described below. Its receipt is build metadata derived from the selected clean
  application and course commits; it is not a private `.pilot/` acceptance
  receipt and is not a public asset.
- Require the default and `--no-provider` launches to ignore inherited provider
  credentials. Provider use is limited to the launcher's hidden-input
  `--provider ... --model ...` path or its deliberate `--provider-env` path.
- Install into a fresh user-owned location from the candidate bundle, with no
  source checkout or prepared state. Prove first and repeat setup, restart,
  redacted diagnostics, inspect/export/reset, damaged-input rejection and
  owned-process cleanup on macOS.
- Require a fresh default study home derived from `release.json.course_version`.
  Verify a different edition or explicit mismatched `--home` is refused without
  replacing notebooks, attempts, preferences or earlier pilot homes.
- Resolve bundle, study, export, evidence and disposable-root paths before writes.
  Reject iCloud Drive, Google Drive, redirected owned runtime paths and unsafe
  release/evidence/test-root overlap.

## 3. Run the source gate at the exact commit

Install from the committed lockfiles and run the same commands as the configured
GitHub Actions workflow:

```sh
uv sync --frozen
uv run --frozen pytest
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend typecheck
node --test frontend/scripts/verify-student-release-cli.test.mjs
pnpm --dir frontend test
UV_LINK_MODE=copy pnpm --dir frontend build
```

The workflow uses read-only repository permissions, Python 3.11 and 3.12 for the
Python suite, and Node 22 with pnpm 10.32.1 for frontend typecheck, tests, and
build. It runs for pull requests, pushes to `main`, and manual dispatch. Hosted CI
has not run for this unpublished preparation; require green jobs at the exact
release commit before tagging.

Review and commit the version, notes, lockfile and generated-output changes before
the clean-archive build proof below. It builds `git archive HEAD`; uncommitted
changes are excluded and cannot be validated by that command. Confirm the working
tree is empty, then run:

```sh
UV_LINK_MODE=copy pnpm --dir frontend test:build-determinism
git status --short
```

The final status must still be empty. Record `git rev-parse HEAD` alongside the
proof; artifact production must use that same clean candidate commit.

## 4. Build and inspect artifacts

Build from the clean candidate commit, before creating its tag, into a fresh
directory:

```sh
release_root=$(mktemp -d)
uv build --wheel --sdist --out-dir "$release_root/dist"
shasum -a 256 "$release_root"/dist/*
uv venv --python 3.11 "$release_root/venv"
uv pip install --python "$release_root/venv/bin/python" \
  "$release_root"/dist/courseweave-*.whl 'jupyterlab==4.6.3'
"$release_root/venv/bin/courseweave" --version
"$release_root/venv/bin/jupyter" labextension list
```

Inspect the wheel and sdist inventories. Require the Python package, console
script, Learn and Author assets, prebuilt Lab extension, schemas, frontend build
inputs, locks, tests, docs, and scripts expected by `pyproject.toml`; reject
dependency trees, test output, credentials, private paths, learner data, and raw
logs. Save a checksum file beside the wheel and sdist.

Install the Chromium binary for the pinned Playwright version before browser
checks; installing the pnpm dependencies alone does not download it:

```sh
pnpm --dir frontend exec playwright install chromium
```

The accepted student target is macOS. If adding Linux browser support, install its
required system packages as well (`playwright install --with-deps chromium`) and
record a separate installed run. The source-only CI workflow needs no browser.

Run the generic installed-wheel check against the exact candidate wheel and hash:

```sh
export COURSEWEAVE_TEST_WHEEL=/absolute/path/to/courseweave-VERSION-py3-none-any.whl
export COURSEWEAVE_TEST_WHEEL_SHA256=sha256-from-the-checksum-file
pnpm --dir frontend test:e2e:installed-wheel
```

Build the public student bundle from the selected clean commits. Run this from
the clean CourseWeave checkout, set `course_checkout` to the clean Agent Harness
Path checkout, and keep `release_root` on nonsynced local storage. The recipe
creates its receipt inputs directly from those commits and the committed lock;
it does not consume `.pilot/receipt.json`.

```sh
course_checkout=/absolute/path/to/agent-harness-path
test -z "$(git status --porcelain)"
test -z "$(git -C "$course_checkout" status --porcelain)"
platform_commit=$(git rev-parse HEAD)
course_commit=$(git -C "$course_checkout" rev-parse HEAD)
release_root=$(mktemp -d)
mkdir "$release_root/dist"

uv build --wheel --sdist --out-dir "$release_root/dist"
git -C "$course_checkout" archive --format=tar \
  --output="$release_root/agent-harness-path-0.2.0.tar" "$course_commit"

python3 - "$release_root/requirements.txt" <<'PY'
from pathlib import Path
import sys
import tomllib

locked = tomllib.loads(Path("uv.lock").read_text())["package"]
versions = [item["version"] for item in locked if item["name"] == "ipykernel"]
assert len(versions) == 1, versions
Path(sys.argv[1]).write_text(f"ipykernel=={versions[0]}\n")
PY

python3 - "$release_root" "$platform_commit" "$course_commit" <<'PY'
from pathlib import Path
import hashlib
import json
import sys

root = Path(sys.argv[1])
platform_commit, course_commit = sys.argv[2:]
wheels = sorted((root / "dist").glob("courseweave-*.whl"))
assert len(wheels) == 1, wheels
course = root / "agent-harness-path-0.2.0.tar"
constraints = root / "requirements.txt"
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
receipt = {
    "platform_commit": platform_commit,
    "course_commit": course_commit,
    "wheel": str(wheels[0].relative_to(root)),
    "wheel_sha256": digest(wheels[0]),
    "source_archives": [{
        "repository": "agent-harness-path",
        "path": course.name,
        "sha256": digest(course),
    }],
    "runtime_constraints": constraints.name,
    "runtime_constraints_sha256": digest(constraints),
}
(root / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
PY

python3 scripts/build_student_release.py \
  --receipt "$release_root/build-receipt.json" \
  --output "$release_root/CourseWeave Student Pilot v0.2.0"
tar -C "$release_root" -czf \
  "$release_root/agent-harness-path-courseweave-0.2.0-macos.tar.gz" \
  "CourseWeave Student Pilot v0.2.0"
(cd "$release_root/dist" && shasum -a 256 courseweave-*) \
  > "$release_root/SHA256SUMS"
(cd "$release_root" && shasum -a 256 \
  agent-harness-path-courseweave-0.2.0-macos.tar.gz) \
  >> "$release_root/SHA256SUMS"
```

Inspect `build-receipt.json`, `release.json`, both Python artifacts and all seven
bundle files. Require `course_version: "0.2.0"`, the two selected commit IDs,
the expected hashes and exactly one archive top-level directory:

```sh
python3 -m json.tool "$release_root/build-receipt.json" >/dev/null
python3 -m json.tool "$release_root/CourseWeave Student Pilot v0.2.0/release.json" >/dev/null
find "$release_root/CourseWeave Student Pilot v0.2.0" -maxdepth 1 -type f -print | sort
tar -tzf "$release_root/agent-harness-path-courseweave-0.2.0-macos.tar.gz"
(cd "$release_root/dist" && shasum -a 256 --check ../SHA256SUMS --ignore-missing)
(cd "$release_root" && shasum -a 256 --check SHA256SUMS --ignore-missing)
```

Attach the student bundle only to the CourseWeave release. The uncompressed
bundle, build receipt and embedded standalone course tar are staging inputs, not
separate public assets.

## 5. Prove course and state compatibility

The existing `test:e2e:installed-adapter` suite is a historical S01/S02 regression
fixture. It asserts course commit
`776f64ae8ae5d1e4fceca3a93de89b9ebf446727`, its tree and manifest digest in
[`agent-harness-path.spec.ts`](../frontend/e2e/agent-harness-path.spec.ts).
Setting `COURSEWEAVE_ADAPTER_ROOT` does not retarget those assertions. To reuse
that regression, point it at a clean checkout of its recorded course commit:

```sh
export COURSEWEAVE_ADAPTER_ROOT=/absolute/path/to/pinned-s01-s02-course-checkout
pnpm --dir frontend test:e2e:installed-adapter
```

The full-course entry point is
[`scripts/verify_student_release.mjs`](../scripts/verify_student_release.mjs),
run with Node 22, two positional paths and an explicit nonsynced test root:

```sh
node --experimental-transform-types scripts/verify_student_release.mjs \
  /absolute/path/to/candidate-student-package \
  /absolute/path/to/disposable-evidence \
  --test-root /absolute/path/to/disposable-root --no-live
```

Omitting both live flags is also synthetic-only. `RELEASE` must be the extracted
seven-file package. `EVIDENCE` must be outside `RELEASE`; the test root can be a
shared parent but cannot be equal to or nested inside either. The verifier resolves
aliases, rejects cloud-synced locations and unsafe overlap, creates only a unique
owned child beneath the test root, and removes that child after the run.
Choose a short test-root path: the longest verifier Unix handoff socket beneath
the resolved root must fit within 103 UTF-8 bytes. If preflight reports a longer
path, select a shorter nonsynced root and rerun. This verifier constraint does not
limit where the student package or durable study home can be stored.

The synthetic run must record the candidate wheel and course archive hashes and
recheck the fourteen readers, twelve notebooks, two optional protocols, native
navigation, recovery, inspect/export/reset, source preservation and provider-off
behavior. It also retains the existing checks for authored hints, 35 checks/105
options, continuous conversation, explicit scope/share, kernel isolation,
credential canaries and process cleanup. Teacher workflows remain a separate
acceptance claim.

An authorized real text check is a separate invocation. Configure exactly one
provider in the environment and use `--live-only`; the verifier passes
`--provider-env` and never discovers a credential file. Do not write the key in
the command, receipt or evidence:

```sh
COURSEWEAVE_PROVIDER=openai \
OPENAI_MODEL=YOUR_OPENAI_MODEL \
OPENAI_API_KEY="$OPENAI_API_KEY" \
node --experimental-transform-types scripts/verify_student_release.mjs \
  /absolute/path/to/candidate-student-package \
  /absolute/path/to/disposable-live-evidence \
  --test-root /absolute/path/to/disposable-live-root --live-only
```

Use the corresponding `ANTHROPIC_MODEL` and `ANTHROPIC_API_KEY` variables when
`COURSEWEAVE_PROVIDER=anthropic`. A passing synthetic run does not prove a live
provider, and one bounded live text run does not prove tool use or arbitrary
provider compatibility.

Schema-v1 manifests require an explicit copy migration:

```sh
courseweave migrate --source /absolute/path/to/courseweave.json
courseweave migrate --source /absolute/path/to/courseweave.json \
  --apply --output /absolute/path/to/courseweave.v2.json
```

Review reported unsupported or ambiguous mappings before using the output. Keep
the source file and a backup of learner state. Legacy state is not inferred from
the manifest conversion; importing it requires reviewed coordinate mappings and
an explicit `courseweave state import-legacy` command. Exercise upgrade and
rollback with copies before documenting either as supported.

## 6. Publish a candidate, verify its download, then promote

- Confirm the committed notes name the candidate version and date, with its
  prerelease status explicit until the public-download gate passes.
- Recheck that the published security-reporting route is available and matches
  `SECURITY.md`.
- Link the exact public course release and commit; include migration, rollback,
  provider, state-location, and supported-platform notes.
- Complete the reviewed local-candidate gates first: exact clean inputs, selected
  license, local source/build checks, generic installed-wheel proof,
  compatible-course proof, state/preservation checks, and independent review.
- Push the reviewed commit through a pull request so hosted source checks run at
  the proposed change. After review and merge, select the resulting `main`
  commit in a dedicated release checkout and require green hosted source checks
  on that exact commit. Inspect any merge or squash differences and rebuild the
  candidate artifacts from the final commit; repeat affected installed gates if
  their inputs changed. A green pull-request merge preview is not the final
  release commit.
- Create the annotated candidate tag only after the final commit, its source
  checks and its recorded artifacts have passed review. Do not move an existing
  tag to a different commit.
- Publish the final v0.2.0 wheel, sdist,
  `agent-harness-path-courseweave-0.2.0-macos.tar.gz`, and `SHA256SUMS` in an
  explicitly marked v0.2.0 GitHub prerelease. Keep those bytes unchanged through
  public-download acceptance and promotion.
- In a clean environment, fetch every artifact through its newly public download
  path. Verify checksums, install the downloaded wheel, follow the README's
  terminal bundle route, and repeat version, extension discovery, provider-off
  first setup, course validation, restart, export/reset and cleanup. Confirm the
  course feedback form opens without submitting invented feedback. This
  post-publication check closes the portability gate that local artifact paths
  cannot prove.
- Promote the exact verified v0.2.0 release and unchanged assets from prerelease
  to the latest public release only after the download/install check passes.
- Keep local private evidence private. Publish a bounded, portable summary with
  artifact identities, commands, results, and limitations; remove local absolute
  paths, credentials, participant data, and raw logs.
- Retain the previous public release and rollback instructions. Never replace an
  existing user's course files or state as part of setup or upgrade.
