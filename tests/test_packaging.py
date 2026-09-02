"""Packaging proof for the Task 0 walking skeleton.

These tests pin the wheel and bridge contract:

- the wheel is built inside the test from the CURRENT source tree (hatchling,
  the configured build backend), so a stale ``dist/`` artifact can never be
  validated by mistake;
- the wheel ships the prebuilt JupyterLab labextension under
  ``courseweave/labextension/`` (package metadata plus the federated
  ``static/remoteEntry.*.js`` entry and the settings schema) and registers it
  for discovery under ``share/jupyter/labextensions/courseweave`` via the
  version-independent PEP 427 data prefix;
- the wheel ships the static learner placeholder under
  ``courseweave/static/learn/`` and declares the ``courseweave`` console
  script;
- the lab bridge stays React-free, verified against both source declarations
  and the built federated JavaScript, and resolves its service origin from a
  non-persisted Jupyter page-config option (default loopback fallback only).
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

import pytest
from hatchling.builders.wheel import WheelBuilder

REPO_ROOT = Path(__file__).resolve().parents[1]
LAB_PACKAGE_JSON = REPO_ROOT / "frontend" / "packages" / "lab" / "package.json"
LAB_ENTRY_TS = REPO_ROOT / "frontend" / "packages" / "lab" / "src" / "index.ts"

REMOTE_ENTRY_RE = re.compile(
    r"^courseweave/labextension/static/remoteEntry\.[0-9a-f]+\.js$"
)
SHARED_LABEXTENSION_PACKAGE_RE = re.compile(
    r"^[^/]+\.data/data/share/jupyter/labextensions/courseweave/package\.json$"
)


@pytest.fixture(scope="module")
def wheel_contents(tmp_path_factory: pytest.TempPathFactory) -> dict[str, bytes]:
    """Build a wheel from the current source tree and read it back.

    Never read ``dist/``: that would validate whatever artifact happens to be
    lying around. Building here proves the inspected wheel derives from the
    sources under test.
    """
    output_dir = tmp_path_factory.mktemp("wheel-build")
    builder = WheelBuilder(str(REPO_ROOT))
    artifacts = [Path(path) for path in builder.build(directory=str(output_dir))]
    wheels = [path for path in artifacts if path.suffix == ".whl"]
    assert len(wheels) == 1, artifacts
    with zipfile.ZipFile(wheels[0]) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


class TestWheelContents:
    def test_wheel_contains_static_learn_asset(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        assert "courseweave/static/learn/index.html" in wheel_contents

    def test_wheel_contains_labextension_package_metadata(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        metadata = json.loads(wheel_contents["courseweave/labextension/package.json"])
        jupyterlab = metadata["jupyterlab"]
        assert jupyterlab["extension"]
        build = jupyterlab["_build"]
        assert re.fullmatch(r"static/remoteEntry\.[0-9a-f]+\.js", build["load"])
        assert build["extension"] == "./extension"

    def test_wheel_contains_federated_entry(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        assert any(REMOTE_ENTRY_RE.fullmatch(name) for name in wheel_contents)

    def test_wheel_contains_labextension_schema(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        assert (
            "courseweave/labextension/schemas/@courseweave/lab/plugin.json"
            in wheel_contents
        )

    def test_wheel_registers_labextension_for_jupyter_discovery(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        shared = [
            name for name in wheel_contents if SHARED_LABEXTENSION_PACKAGE_RE.match(name)
        ]
        assert len(shared) == 1, sorted(
            name for name in wheel_contents if "share/jupyter" in name
        )
        metadata = json.loads(wheel_contents[shared[0]])
        assert metadata["jupyterlab"]["_build"]["load"]

    def test_wheel_declares_console_script(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        entry_points = next(
            wheel_contents[name]
            for name in wheel_contents
            if name.endswith(".dist-info/entry_points.txt")
        ).decode()
        assert "[console_scripts]" in entry_points
        assert "courseweave = courseweave.cli:app" in entry_points


class TestBuiltBridgeBundle:
    def test_bundle_resolves_service_origin_from_page_config(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        """The bridge must read a page-config option, not hardcode one port."""
        bundle = [
            data
            for name, data in wheel_contents.items()
            if REMOTE_ENTRY_RE.match(name)
            or re.fullmatch(
                r"courseweave/labextension/static/[0-9a-f]+\.[0-9a-f]+\.js", name
            )
        ]
        assert bundle, "no built bridge JavaScript found in the wheel"
        assert any(b"courseweaveServiceUrl" in data for data in bundle), (
            "built bridge does not reference the courseweaveServiceUrl page-config "
            "option"
        )

    def test_bundle_contains_no_capability_token_plumbing(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        """The iframe URL carries the service origin only, never the token."""
        bundle = [
            data
            for name, data in wheel_contents.items()
            if name.startswith("courseweave/labextension/static/")
            and name.endswith(".js")
        ]
        for data in bundle:
            assert b"capability_token" not in data
            assert b"capabilityToken" not in data

    def test_bundle_is_react_free(self, wheel_contents: dict[str, bytes]) -> None:
        """No React code may ship inside the built federated JavaScript."""
        bundle = [
            data
            for name, data in wheel_contents.items()
            if name.startswith("courseweave/labextension/static/")
            and name.endswith(".js")
        ]
        assert bundle
        for data in bundle:
            assert b"react" not in data.lower(), (
                "react marker found in built bridge JavaScript"
            )


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
