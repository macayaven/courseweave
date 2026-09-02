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

import typer
import uvicorn

from courseweave import __version__
from courseweave.api import create_app

ENV_CAPABILITY_TOKEN = "COURSEWEAVE_CAPABILITY_TOKEN"

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
