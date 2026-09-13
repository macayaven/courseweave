"""CourseWeave command-line interface.

Task 0 ships ``serve``: bind the service to loopback with a per-launch
capability token. The token lives in process memory only: it is accepted from
the ``COURSEWEAVE_CAPABILITY_TOKEN`` environment variable (the sanctioned
launch seam; Task 6 passes it to the owned JupyterLab child) or generated
randomly. It is never written to disk or printed.
"""

from __future__ import annotations

import os
import json
import uuid
import secrets
from pathlib import Path
from typing import Literal

import typer
import uvicorn

from courseweave import __version__
from courseweave.api import create_app
from courseweave.launch import LaunchSupervisor
from courseweave.manifest import (
    ManifestNotFoundError,
    ManifestValidationError,
    load_manifest,
)
from courseweave.providers import ProviderConfig

ENV_CAPABILITY_TOKEN = "COURSEWEAVE_CAPABILITY_TOKEN"

app = typer.Typer(
    name="courseweave",
    help="CourseWeave: local-first course platform.",
    no_args_is_help=True,
)


@app.command()
def validate(
    course_root: Path = typer.Option(
        ...,
        "--course-root",
        resolve_path=True,
        help="Root directory of the course repository.",
    ),
) -> None:
    """Validate that a saved course manifest is runnable."""
    try:
        root_is_directory = course_root.is_dir()
    except OSError:
        typer.echo("Course root could not be inspected.", err=True)
        raise typer.Exit(1) from None

    if not root_is_directory:
        typer.echo("Course root is not a directory.", err=True)
        raise typer.Exit(1)

    try:
        manifest = load_manifest(course_root, runnable=True)
    except ManifestNotFoundError:
        typer.echo("Course manifest not found.", err=True)
        raise typer.Exit(1) from None
    except ManifestValidationError as exc:
        typer.echo(str(exc) if "migrat" in str(exc) else "Course manifest is invalid or not runnable.", err=True)
        raise typer.Exit(1) from None
    except OSError:
        typer.echo("Course manifest could not be read.", err=True)
        raise typer.Exit(1) from None

    phase_count = sum(len(module.phases) for module in manifest.modules)
    surface_count = sum(
        len(phase.surfaces)
        for module in manifest.modules
        for phase in module.phases
    )
    typer.echo(
        "Course manifest is valid: "
        f"modules={len(manifest.modules)} "
        f"phases={phase_count} surfaces={surface_count}."
    )


@app.command()
def doctor(
    course_root: Path = typer.Option(
        ...,
        "--course-root",
        exists=True,
        file_okay=False,
        resolve_path=True,
        help="Root directory of the course repository.",
    ),
) -> None:
    """Report redacted provider configuration for a course root."""
    del course_root  # The command validates the supplied root; no course data is read.
    config = ProviderConfig.from_environ(os.environ)
    typer.echo(f"provider: {config.provider or 'MISSING'}")
    typer.echo(f"model: {config.model or 'MISSING'}")
    typer.echo(f"base_url: {config.base_url_status}")
    typer.echo(f"credential: {config.credential_status}")


@app.command()
def serve(
    course_root: Path = typer.Option(
        ...,
        "--course-root",
        exists=True,
        file_okay=False,
        resolve_path=True,
        help="Root directory of the course repository.",
    ),
    port: int = typer.Option(8765, "--port", min=1024, max=65535),
    state_dir: Path | None = typer.Option(None, "--state-dir", resolve_path=True),
) -> None:
    """Serve CourseWeave on loopback with a per-launch capability token."""
    capability_token = (
        os.environ.get(ENV_CAPABILITY_TOKEN) or secrets.token_urlsafe(32)
    )
    typer.echo(f"CourseWeave serving {course_root} at http://127.0.0.1:{port}")
    uvicorn.run(
        create_app(course_root, capability_token=capability_token, state_dir=state_dir),
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )


def _run_jupyter_mode(
    course_root: Path, port: int, mode: Literal["learn", "author"], state_dir: Path | None = None, kernel_python: Path | None = None
) -> None:
    try:
        exit_code = LaunchSupervisor(course_root, port=port, mode=mode,
            **({"state_dir": state_dir} if state_dir else {}),
            **({"kernel_python": kernel_python} if kernel_python else {})).run()
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from None
    if exit_code:
        raise typer.Exit(exit_code)


@app.command()
def launch(
    course_root: Path = typer.Option(
        ...,
        "--course-root",
        exists=True,
        file_okay=False,
        resolve_path=True,
        help="Root directory of the course repository.",
    ),
    port: int = typer.Option(8765, "--port", min=1024, max=65535),
    state_dir: Path | None = typer.Option(None, "--state-dir", resolve_path=True),
    kernel_python: Path | None = typer.Option(None, "--kernel-python", help="Absolute course Python with ipykernel (preserves venv path)."),
) -> None:
    """Open a CourseWeave learner workspace in authenticated JupyterLab."""
    _run_jupyter_mode(course_root, port, "learn", state_dir, kernel_python)


@app.command()
def author(
    course_root: Path = typer.Option(
        ...,
        "--course-root",
        exists=True,
        file_okay=False,
        resolve_path=True,
        help="Root directory of the course repository.",
    ),
    port: int = typer.Option(8765, "--port", min=1024, max=65535),
    state_dir: Path | None = typer.Option(None, "--state-dir", resolve_path=True),
    kernel_python: Path | None = typer.Option(None, "--kernel-python", help="Absolute course Python with ipykernel (preserves venv path)."),
) -> None:
    """Open CourseWeave Author in authenticated JupyterLab."""
    _run_jupyter_mode(course_root, port, "author", state_dir, kernel_python)


@app.command()
def migrate(source: Path = typer.Option(..., '--source', exists=True, dir_okay=False),
            apply: bool = typer.Option(False, '--apply'),
            output: Path | None = typer.Option(None, '--output')) -> None:
    """Preview v1 conversion; --apply writes a new v2 copy and never overwrites."""
    from courseweave.migration import preview_legacy
    from courseweave.engine import serialize_manifest
    try:
        result = preview_legacy(source)
        report = {'mappings':[item.model_dump(mode="json") for item in result.mappings],
                  'issues':[item.model_dump(mode="json") for item in result.issues]}
        if result.manifest is None:
            typer.echo(json.dumps(report, indent=2)); raise typer.Exit(1)
        report['manifest'] = result.manifest.model_dump(mode='json', exclude_none=True)
        report['manifest']['entry_module_id'] = result.manifest.entry_module_id
        if apply:
            destination = output or source.with_name('courseweave.v2.json')
            if destination.resolve() == source.resolve():
                typer.echo('Migration requires a separate output copy.', err=True); raise typer.Exit(1)
            with destination.open('xb') as stream:
                stream.write(serialize_manifest(result.manifest))
            report['output'] = str(destination)
        typer.echo(json.dumps(report, indent=2))
    except OSError:
        typer.echo('Migration could not write a new copy; existing files are preserved.', err=True)
        raise typer.Exit(1) from None


state_app = typer.Typer(help='Inspect, export, reset, delete, or explicitly import personal learner state.')
app.add_typer(state_app, name='state')


def _state_store(root, directory):
    from courseweave.store import CourseStore
    return CourseStore(root, state_dir=directory)


@state_app.command('inspect')
def inspect_state(course_root: Path = typer.Option(..., '--course-root'),
                  state_dir: Path | None = typer.Option(None, '--state-dir')):
    typer.echo(json.dumps(_state_store(course_root, state_dir).state_view(), indent=2))


@state_app.command('export')
def export_state(course_root: Path = typer.Option(..., '--course-root'),
                 state_dir: Path | None = typer.Option(None, '--state-dir'),
                 output: Path = typer.Option(..., '--output')):
    state = _state_store(course_root, state_dir).get_state()
    try:
        with output.open('x', encoding='utf-8') as stream:
            stream.write(state.model_dump_json(indent=2) + '\n')
    except OSError:
        typer.echo('Export requires a new writable output file.', err=True); raise typer.Exit(1) from None


def _reset_state(root, directory, operation):
    store = _state_store(root, directory)
    state = store.apply_state({'type':operation}, store.get_state().revision, str(uuid.uuid4()))
    typer.echo(json.dumps({'revision':state.revision, 'records':len(state.records)}))


@state_app.command('reset')
def reset_state(course_root: Path = typer.Option(..., '--course-root'),
                state_dir: Path | None = typer.Option(None, '--state-dir')):
    _reset_state(course_root, state_dir, 'reset_state')


@state_app.command('delete')
def delete_state(course_root: Path = typer.Option(..., '--course-root'),
                 state_dir: Path | None = typer.Option(None, '--state-dir')):
    _reset_state(course_root, state_dir, 'delete_state')


@state_app.command('import-legacy')
def import_state(course_root: Path = typer.Option(..., '--course-root'),
                 state_dir: Path | None = typer.Option(None, '--state-dir'),
                 source: Path = typer.Option(..., '--source'),
                 mappings: Path = typer.Option(..., '--mappings')):
    """Copy legacy SQLite records using explicit collection:key coordinate mappings."""
    store = _state_store(course_root, state_dir)
    state = store.import_legacy(source, json.loads(mappings.read_text()), store.get_state().revision, str(uuid.uuid4()))
    typer.echo(json.dumps({'revision':state.revision, 'imports':[item.model_dump(mode='json') for item in state.imports]}, indent=2))


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"courseweave {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False,
        "--version",
        help="Show the CourseWeave version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """CourseWeave: local-first course platform."""


if __name__ == "__main__":  # pragma: no cover
    app()
