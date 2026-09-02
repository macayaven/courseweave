"""Packaging proof for the Task 0 walking skeleton.

These tests pin the wheel contract before it exists:

- the built wheel ships the prebuilt JupyterLab labextension under
  ``courseweave/labextension/`` (package metadata plus the federated
  ``static/remoteEntry.*.js`` entry and the settings schema), and registers it
  for discovery under ``share/jupyter/labextensions/courseweave``;
- the wheel ships the static learner placeholder under
  ``courseweave/static/learn/``;
- the ``courseweave`` console script is declared;
- the lab bridge package stays React-free.
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LAB_PACKAGE_JSON = REPO_ROOT / "frontend" / "packages" / "lab" / "package.json"
LAB_ENTRY_TS = REPO_ROOT / "frontend" / "packages" / "lab" / "src" / "index.ts"

REMOTE_ENTRY_RE = re.compile(
    r"^courseweave/labextension/static/remoteEntry\.[0-9a-f]+\.js$"
)


def _newest_wheel() -> Path:
    wheels = sorted((REPO_ROOT / "dist").glob("courseweave-*.whl"))
    assert wheels, (
        "no courseweave wheel found in dist/ (expected build: "
        "`pnpm build` then `uv build`)"
    )
    return wheels[-1]


def _read_wheel() -> dict[str, bytes]:
    with zipfile.ZipFile(_newest_wheel()) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


class TestWheelContents:
    def test_wheel_contains_static_learn_asset(self) -> None:
        contents = _read_wheel()
        assert "courseweave/static/learn/index.html" in contents

    def test_wheel_contains_labextension_package_metadata(self) -> None:
        contents = _read_wheel()
        metadata = json.loads(contents["courseweave/labextension/package.json"])
        jupyterlab = metadata["jupyterlab"]
        assert jupyterlab["extension"]
        build = jupyterlab["_build"]
        assert re.fullmatch(r"static/remoteEntry\.[0-9a-f]+\.js", build["load"])
        assert build["extension"] == "./extension"

    def test_wheel_contains_federated_entry(self) -> None:
        contents = _read_wheel()
        assert any(REMOTE_ENTRY_RE.fullmatch(name) for name in contents)

    def test_wheel_contains_labextension_schema(self) -> None:
        contents = _read_wheel()
        assert "courseweave/labextension/schemas/@courseweave/lab/plugin.json" in contents

    def test_wheel_registers_labextension_for_jupyter_discovery(self) -> None:
        contents = _read_wheel()
        # Hatchling maps shared-data under the PEP 427 ``.data/data`` prefix;
        # installers relocate it to ``<env>/share/jupyter/labextensions``.
        metadata = json.loads(
            contents[
                "courseweave-0.1.0.data/data/share/jupyter/labextensions/"
                "courseweave/package.json"
            ]
        )
        assert metadata["jupyterlab"]["_build"]["load"]

    def test_wheel_declares_console_script(self) -> None:
        contents = _read_wheel()
        entry_points = next(
            contents[name]
            for name in contents
            if name.endswith(".dist-info/entry_points.txt")
        ).decode()
        assert "[console_scripts]" in entry_points
        assert "courseweave = courseweave.cli:app" in entry_points


class TestLabBridgeIsReactFree:
    def test_lab_package_declares_no_react(self) -> None:
        package = json.loads(LAB_PACKAGE_JSON.read_text(encoding="utf-8"))
        for group in ("dependencies", "devDependencies", "peerDependencies"):
            declared = package.get(group, {})
            react_keys = [name for name in declared if "react" in name.lower()]
            assert not react_keys, (group, react_keys)

    def test_lab_entry_imports_no_react(self) -> None:
        source = LAB_ENTRY_TS.read_text(encoding="utf-8")
        assert not re.search(r"from\s+['\"]react", source)
        assert "@lumino/widgets" in source
