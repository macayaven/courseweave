# Contributing to CourseWeave

CourseWeave keeps course rules in one canonical schema and deterministic engine.
Interfaces, provider adapters, and assistant output must consume that authority;
they must not create a competing completion or mutation path. Read the
[engineering standard](docs/engineering.md) before architectural, state, security,
or release changes.

CourseWeave is source available under PolyForm Shield 1.0.0, not OSI open source.
Read the [licensing guide](docs/LICENSING.md) and controlling
[`LICENSE`](LICENSE) before reuse or redistribution.

## Local setup

Use a nonsynced local checkout. The supported contributor toolchain is Python
3.11 or 3.12, uv, Node `^20.19.0` or `>=22.12.0`, and pnpm 10.32.1.

```sh
uv sync --frozen
pnpm --dir frontend install --frozen-lockfile
```

Do not add generated dependency directories, credentials, learner data, raw
provider logs, or private course material to a change. Provider-backed tests must
be deliberately authorized and must use test-owned data; ordinary source checks
do not require a provider.

You must have the right to submit your work. Ordinary accepted contributions are
distributed under the project license, while contributors retain copyright. The
project does not require copyright assignment, a contributor license agreement,
or an implied broad commercial relicensing grant. Discuss any different terms
with the maintainer before submission.

## Validation

Run the smallest checks that cover a change, then run the source gate before a
pull request that changes behavior:

```sh
uv run --frozen pytest
pnpm --dir frontend typecheck
pnpm --dir frontend test
UV_LINK_MODE=copy pnpm --dir frontend build
```

If frontend sources change, include their tracked built application and
JupyterLab-extension outputs. Confirm a clean rebuild matches the committed
outputs:

```sh
UV_LINK_MODE=copy pnpm --dir frontend test:build-determinism
```

Changes to packaging, launch, native surfaces, state, privacy, recovery, or the
course contract also require the relevant installed-wheel or adapter browser
checks documented in [the pilot verification guide](docs/pilot/verification.md).
Those checks are release evidence and are not replaced by unit-test counts.

Documentation-only changes should check relative links and examples; they do not
need a rerun of the complete installed student journey unless a command, artifact
identity, or acceptance claim changed.

The public learner path is the versioned macOS bundle documented in the root
README. Do not replace it with a source checkout, a private wheel path, a prepared
`.pilot/` receipt or a maintainer credential route. When learner setup commands
change, exercise them against the exact candidate bundle and keep the provider-off
default, checksum gate, fresh versioned home and feedback redaction boundary
visible.

## Pull requests

Keep each change focused and explain:

- the concrete behavior or documentation problem;
- the authoritative contract or state owner affected;
- the commands run and their observed results;
- any installed, provider, accessibility, course, or human checks that were not run;
- migration, recovery, privacy, and generated-output implications where relevant.

Do not claim production readiness, accessibility conformance, provider
compatibility, or learning outcomes from synthetic tests. A fix to a verified
defect should include focused regression coverage. Avoid tests that restate the
implementation without exercising a user-visible contract.
