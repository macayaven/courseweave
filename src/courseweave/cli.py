"""CourseWeave command-line interface.

Task 0 ships ``serve``: bind the service to loopback with a per-launch
capability token. The token lives in process memory only: it is accepted from
the ``COURSEWEAVE_CAPABILITY_TOKEN`` environment variable (the sanctioned
launch seam; Task 6 passes it to the owned JupyterLab child) or generated
randomly. It is never written to disk or printed.
"""

from __future__ import annotations

import os
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
    except ManifestValidationError:
        typer.echo("Course manifest is invalid or not runnable.", err=True)
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
) -> None:
    """Serve CourseWeave on loopback with a per-launch capability token."""
    capability_token = (
        os.environ.get(ENV_CAPABILITY_TOKEN) or secrets.token_urlsafe(32)
    )
    typer.echo(f"CourseWeave serving {course_root} at http://127.0.0.1:{port}")
    uvicorn.run(
        create_app(course_root, capability_token=capability_token),
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )


def _run_jupyter_mode(
    course_root: Path, port: int, mode: Literal["learn", "author"]
) -> None:
    exit_code = LaunchSupervisor(course_root, port=port, mode=mode).run()
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
) -> None:
    """Open a CourseWeave learner workspace in authenticated JupyterLab."""
    _run_jupyter_mode(course_root, port, "learn")


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
) -> None:
    """Open CourseWeave Author in authenticated JupyterLab."""
    _run_jupyter_mode(course_root, port, "author")


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
