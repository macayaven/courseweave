"""CourseWeave command-line interface.

Task 0 ships ``serve``: bind the service to loopback, generate the per-launch
capability token, and write the gitignored runtime settings file that later
tasks hand to the JupyterLab bridge. The token value is never printed.
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import typer
import uvicorn

from courseweave import __version__
from courseweave.api import create_app

app = typer.Typer(
    name="courseweave",
    help="CourseWeave: local-first course platform.",
    no_args_is_help=True,
)


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
    capability_token = secrets.token_urlsafe(32)
    runtime_settings = course_root / ".courseweave" / "runtime.json"
    runtime_settings.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {
            "base_url": f"http://127.0.0.1:{port}",
            "capability_token": capability_token,
        },
        indent=2,
    )
    descriptor = os.open(runtime_settings, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(payload + "\n")

    typer.echo(f"CourseWeave serving {course_root} at http://127.0.0.1:{port}")
    typer.echo(f"Runtime settings written to {runtime_settings}")
    uvicorn.run(
        create_app(course_root, capability_token=capability_token),
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )


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
