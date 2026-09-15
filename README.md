# CourseWeave

CourseWeave is a local-first course application for JupyterLab. A canonical
course manifest and deterministic learning records govern progress; the learner
assistant can explain deliberately selected material, but it cannot complete an
activity or mutate course state on its own.

The [Agent Harness Path](https://github.com/macayaven/agent-harness-path) remains
a complete standalone course. CourseWeave adds an optional guided route through
the same S01–S14 material: fourteen lesson readers, twelve runnable notebooks and
two optional notebook-free protocols.

## Release status

Student v0.2.0 is released. The
[v0.2.0 release page](https://github.com/macayaven/courseweave/releases/tag/v0.2.0)
provides the macOS bundle, checksums, publication date and public-download evidence.
The v0.1.0 wheel supports schema v1 and cannot load the current schema-v2 course.

Author Edition v0.3.0 is a local candidate undergoing installed acceptance. It adds
private projects, six assistant roles, explicit source research, reviewed content
changes, real Student preview, generic course delivery and backup/restore. Its
separate **Start Author.command** bundle includes both Student versions and
reproducible source/runtime inputs. See [Author setup](author-setup.md) and the
[acceptance status](docs/pilot/author-edition-acceptance.md). This candidate has not
been published or accepted as a complete release.

The [native course route](https://github.com/macayaven/agent-harness-path#quickstart)
continues to work independently. Historical local evidence remains bound to its
named artifacts; it does not establish acceptance of a newer candidate.

## Guided Student macOS setup

You need macOS, internet access for first setup, and
[uv](https://docs.astral.sh/uv/getting-started/installation/). Put the download
and study home on nonsynced local storage, outside iCloud Drive and Google Drive.
You do not need Node, a source checkout, a separate Jupyter installation or an
API key.

In Terminal, change to a nonsynced download folder and run:

```sh
curl -fLO https://github.com/macayaven/courseweave/releases/download/v0.2.0/agent-harness-path-courseweave-0.2.0-macos.tar.gz
curl -fLO https://github.com/macayaven/courseweave/releases/download/v0.2.0/SHA256SUMS
shasum -a 256 --check SHA256SUMS --ignore-missing | grep -F 'agent-harness-path-courseweave-0.2.0-macos.tar.gz: OK'
tar -xzf agent-harness-path-courseweave-0.2.0-macos.tar.gz
cd "CourseWeave Student Pilot v0.2.0"
./"Start Course.command" --no-provider
```

Continue only when the checksum command prints the named bundle followed by
`OK`. The terminal route downloads, verifies, extracts and starts the reviewed
archive directly. Keep the Terminal window open while studying; save notebooks
and press Ctrl-C there to stop. Starting again resumes the same versioned study
home. First setup installs isolated application and course environments and may
take several minutes.

Start with **Read and trace the theory** in S01, open the lesson, write a
prediction before running the notebook, then attempt the self-check before
revealing its feedback. Repeat reading → notebook → self-check through S12.
Videos and hard labs are optional. S13 and S14 are optional notebook-free
protocols on a system you own; their unaided phases do not permit assistant help
or sharing.

## Optional assistant

The bundle starts with the assistant off even if your shell already contains API
keys. Reading, notebooks, authored hints and self-checks still work. For a single
interactive launch, let the launcher request the key with hidden input:

```sh
./"Start Course.command" --provider openai --model YOUR_OPENAI_MODEL
./"Start Course.command" --provider anthropic --model YOUR_ANTHROPIC_MODEL
```

Use `--base-url https://your-gateway.example/v1` only when your provider or
OpenAI-compatible gateway requires it. Never put a key in an argument, notebook,
course file or issue. The prompt-held key is not saved by CourseWeave.

For deliberate environment injection, select one provider and set its exact
variables:

- OpenAI-compatible: `COURSEWEAVE_PROVIDER=openai`, `OPENAI_MODEL` and
  `OPENAI_API_KEY`; `OPENAI_BASE_URL` is optional.
- Anthropic: `COURSEWEAVE_PROVIDER=anthropic`, `ANTHROPIC_MODEL` and
  `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` is optional.

Then run:

```sh
./"Start Course.command" --provider-env
```

The accepted bundled profile is text-only. Configuration is checked when you ask
a question; it does not establish general provider or live-tool compatibility.
Provider retention remains separate from CourseWeave state controls.

## Feedback and recovery

Use the one-click
[course feedback form](https://github.com/macayaven/agent-harness-path/issues/new?template=course-feedback.yml)
for lesson, notebook, hard-lab, CourseWeave-route or S13/S14 friction. Submit only
when you choose. Include the public session/activity, what you tried, expected
and observed, and how you recovered. Remove credentials, raw chats, participant
content, private project details, local paths and full notebook/work products.
Nothing in CourseWeave sends telemetry or files to this form automatically.

For a reproducible launcher, bundle or application defect, use the
[CourseWeave issue tracker](https://github.com/macayaven/courseweave/issues).
Run the local redacted diagnostic without a provider call:

```sh
./"Start Course.command" check
```

The bundled README documents restart, separate study homes, inspect, export,
reset and rollback. A new course version never silently replaces an earlier
study folder.

## Develop from source

Source development is a contributor path, separate from the student bundle.
Use Python 3.11 or 3.12, uv, Node `^20.19.0` or `>=22.12.0`, and pnpm 10.32.1 in
a nonsynced local checkout:

```sh
uv sync --frozen
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend typecheck
pnpm --dir frontend test
UV_LINK_MODE=copy pnpm --dir frontend build
uv run --frozen pytest
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for source workflows and
[docs/RELEASING.md](docs/RELEASING.md) for installed-artifact and release gates.
CourseWeave is source available under PolyForm Shield 1.0.0, not OSI open
source. Read the
[licensing guide](docs/LICENSING.md) before reuse or redistribution.

## Project documentation

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Licensing](docs/LICENSING.md)
- [Release process](docs/RELEASING.md)
- [Schema and API contract](docs/contracts/api.md)
- [Engineering standard](docs/engineering.md)
- [Three product specifications and approved Author Edition plan](docs/specs/README.md)
- [Historical v0.1.0 verification](docs/verification/v0.md)

The root [`LICENSE`](LICENSE) covers CourseWeave. The independently maintained
Agent Harness Path course retains its Apache-2.0 software and CC BY 4.0 content
licensing, and learner-created work remains the learner's.
