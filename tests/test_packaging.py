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
- the lab bridge stays free of React runtime code, verified semantically
  against the built federated JavaScript (React-specific runtime markers) and
  against source declarations;
- the bridge resolves its service origin with the required priority:
  non-empty ``courseweaveServiceUrl`` page-config option first, then this
  plugin's ``serviceOrigin`` setting from its shipped schema, then the
  loopback default.
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


def _bridge_javascript(wheel_contents: dict[str, bytes]) -> list[bytes]:
    """The built federated JavaScript of the bridge (entry plus chunks)."""
    return [
        data
        for name, data in wheel_contents.items()
        if REMOTE_ENTRY_RE.match(name)
        or re.fullmatch(
            r"courseweave/labextension/static/[0-9a-f]+\.[0-9a-f]+\.js", name
        )
    ]


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
        """Launch injection (priority 1) must come from page config."""
        bundle = _bridge_javascript(wheel_contents)
        assert bundle, "no built bridge JavaScript found in the wheel"
        assert any(b"courseweaveServiceUrl" in data for data in bundle), (
            "built bridge does not reference the courseweaveServiceUrl page-config "
            "option"
        )

    def test_bundle_consumes_service_origin_plugin_setting(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        """Manual custom-port configuration (priority 2) must flow through this
        plugin's ``serviceOrigin`` setting key, resolved via ISettingRegistry."""
        bundle = _bridge_javascript(wheel_contents)
        assert bundle, "no built bridge JavaScript found in the wheel"
        assert any(b"serviceOrigin" in data for data in bundle), (
            "built bridge does not consume the serviceOrigin plugin setting"
        )

    def test_setting_schema_pins_loopback_default(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        """The schema default is the loopback fallback (priority 3)."""
        schema = json.loads(
            wheel_contents[
                "courseweave/labextension/schemas/@courseweave/lab/plugin.json"
            ]
        )
        default = schema["properties"]["serviceOrigin"]["default"]
        assert default == "http://127.0.0.1:8765"
        bundle = _bridge_javascript(wheel_contents)
        assert any(
            b"http://127.0.0.1:8765" in data for data in bundle
        ), "built bridge lost the loopback default fallback"

    def test_bundle_contains_no_capability_token_plumbing(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        """The iframe URL carries the service origin only, never the token."""
        for data in _bridge_javascript(wheel_contents):
            assert b"capability_token" not in data
            assert b"capabilityToken" not in data

    def test_bundle_contains_no_react_runtime(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        """No React code may ship inside the built federated JavaScript.

        Semantic markers: these strings exist only when actual React runtime
        code is bundled (component/JSX machinery, react-dom, React internals),
        not when the word merely appears in descriptions or metadata.
        """
        react_runtime_markers = (
            b"react-dom",
            b"reactdom",
            b"jsx-runtime",
            b"__secret_internals_do_not_use_or_you_will_be_fired",
            b"react.element",
            b"react.portal",
        )
        for data in _bridge_javascript(wheel_contents):
            lowered = data.lower()
            for marker in react_runtime_markers:
                assert marker not in lowered, marker


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
