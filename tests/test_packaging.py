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
import subprocess
import uuid
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from hatchling.builders.wheel import WheelBuilder

from courseweave.api import create_app

REPO_ROOT = Path(__file__).resolve().parents[1]
LAB_PACKAGE_JSON = REPO_ROOT / "frontend" / "packages" / "lab" / "package.json"
LAB_ENTRY_TS = REPO_ROOT / "frontend" / "packages" / "lab" / "src" / "index.ts"
FRONTEND_LOCK = REPO_ROOT / "frontend" / "pnpm-lock.yaml"
FRONTEND_WORKSPACE = REPO_ROOT / "frontend" / "pnpm-workspace.yaml"

THIRD_PARTY_NOTICE = "THIRD_PARTY_LICENSES.md"
REACT_MIT_LICENSE = b"""MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the \"Software\"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

REMOTE_ENTRY_RE = re.compile(
    r"^courseweave/labextension/static/remoteEntry\.[0-9a-f]+\.js$"
)
SHARED_LABEXTENSION_PACKAGE_RE = re.compile(
    r"^[^/]+\.data/data/share/jupyter/labextensions/@courseweave/lab/package\.json$"
)
LABEXTENSIONS_ARCHIVE_PREFIX = ".data/data/share/jupyter/labextensions/"
PLUGIN_ID = "@courseweave/lab:plugin"


@pytest.fixture(scope="module")
def wheel_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Build a wheel from the current source tree.

    Never read ``dist/``: that would validate whatever artifact happens to be
    lying around. Building here proves the inspected wheel derives from the
    sources under test.
    """
    output_dir = tmp_path_factory.mktemp("wheel-build")
    builder = WheelBuilder(str(REPO_ROOT))
    artifacts = [Path(path) for path in builder.build(directory=str(output_dir))]
    wheels = [path for path in artifacts if path.suffix == ".whl"]
    assert len(wheels) == 1, artifacts
    return wheels[0]


@pytest.fixture(scope="module")
def wheel_contents(wheel_path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(wheel_path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


@pytest.fixture(scope="module")
def installed_labextensions(
    wheel_path: Path, tmp_path_factory: pytest.TempPathFactory
) -> Path:
    """Extract the wheel's shared-data labextensions tree, relocated exactly
    as an installer would place it under ``share/jupyter/labextensions``."""
    target = tmp_path_factory.mktemp("share") / "jupyter" / "labextensions"
    with zipfile.ZipFile(wheel_path) as archive:
        members = [
            name for name in archive.namelist() if LABEXTENSIONS_ARCHIVE_PREFIX in name
        ]
        assert members, "wheel contains no share/jupyter/labextensions data"
        for name in members:
            relative = name.split(LABEXTENSIONS_ARCHIVE_PREFIX, 1)[1]
            if not relative or relative.endswith("/"):
                continue
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(name))
    return target


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
    def test_wheel_retains_bundled_react_license_notice(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        license_entries = [
            name
            for name in wheel_contents
            if name.endswith(f".dist-info/licenses/{THIRD_PARTY_NOTICE}")
        ]
        assert len(license_entries) == 1, license_entries
        notice = wheel_contents[license_entries[0]]
        for component in (
            b"React 19.2.8",
            b"ReactDOM 19.2.8",
            b"scheduler 0.27.0",
        ):
            assert component in notice
        assert REACT_MIT_LICENSE in notice

        metadata_entries = [
            name for name in wheel_contents if name.endswith(".dist-info/METADATA")
        ]
        assert len(metadata_entries) == 1, metadata_entries
        assert (
            f"License-File: {THIRD_PARTY_NOTICE}".encode()
            in wheel_contents[metadata_entries[0]]
        )

    def test_installed_smoke_redacts_bootstrap_failures_and_checks_discovery(self) -> None:
        helper = (REPO_ROOT / "frontend" / "e2e" / "installed-wheel-helpers.ts").read_text()
        spec = (REPO_ROOT / "frontend" / "e2e" / "installed-wheel-lab.spec.ts").read_text()
        assert "labextension', 'list'], { env: environment }" in helper
        assert "@courseweave\\/lab" in helper
        assert "Installed-wheel bootstrap navigation failed." in spec
        assert "page.goto(bootstrapUrl" not in spec

    def test_installed_wheel_playwright_command_lists_the_dedicated_smoke(self) -> None:
        """The wheel smoke is opt-in and must not borrow the normal Vite suite."""
        completed = subprocess.run(
            [
                "pnpm",
                "--dir",
                str(REPO_ROOT / "frontend"),
                "run",
                "test:e2e:installed-wheel",
                "--list",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        assert "installed-wheel-lab.spec.ts" in completed.stdout

    def test_wheel_contains_static_learn_asset(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        assert "courseweave/static/learn/index.html" in wheel_contents
        index = wheel_contents["courseweave/static/learn/index.html"].decode()
        referenced = re.findall(r"/learn/assets/([^\"']+\.(?:js|css))", index)
        assert referenced
        assert all(
            re.fullmatch(r"index-[A-Za-z0-9_-]{8,}\.(?:js|css)", asset)
            for asset in referenced
        )
        for asset in referenced:
            assert f"courseweave/static/learn/assets/{asset}" in wheel_contents
        actual = sorted(name.rsplit("/", 1)[1] for name in wheel_contents if name.startswith("courseweave/static/learn/assets/"))
        assert actual == sorted(referenced)

    def test_wheel_contains_static_author_asset(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        assert "courseweave/static/author/index.html" in wheel_contents
        index = wheel_contents["courseweave/static/author/index.html"].decode()
        references = re.findall(r"(?:src|href)=[\"']([^\"']+)[\"']", index)
        assert references
        for reference in references:
            match = re.fullmatch(
                r"/author/assets/([A-Za-z0-9._-]+\.(?:js|css))", reference
            )
            assert match is not None, reference
            assert re.fullmatch(
                r"index-[A-Za-z0-9_-]{8,}\.(?:js|css)", match.group(1)
            )
            assert (
                f"courseweave/static/author/assets/{match.group(1)}" in wheel_contents
            )
        actual = sorted(name.rsplit("/", 1)[1] for name in wheel_contents if name.startswith("courseweave/static/author/assets/"))
        assert actual == sorted(match.group(1) for reference in references if (match := re.fullmatch(r"/author/assets/([A-Za-z0-9._-]+\.(?:js|css))", reference)))
        for forbidden in (
            "127.0.0.1",
            "localhost",
            "test-capability",
            "browser-test-capability",
            "capability_token",
            "capabilityToken",
        ):
            assert forbidden not in index


class TestAuthorStaticRoute:
    def test_author_mount_does_not_mask_api_routes(self, tmp_path: Path) -> None:
        client = TestClient(create_app(tmp_path, capability_token="packaging-token"))
        author = client.get("/author/")
        api = client.get("/api/not-an-author-page", headers={"Authorization": "Bearer packaging-token"})

        assert author.status_code == 200
        assert "CourseWeave Author" in author.text
        assert api.status_code == 404
        assert "CourseWeave Author" not in api.text

    def test_author_lock_preserves_the_lab_react_18_peer_context(self) -> None:
        lock = FRONTEND_LOCK.read_text(encoding="utf-8")
        lab = lock.split("  packages/lab:\n", 1)[1].split("\n  packages/ui:", 1)[0]
        assert "version: 4.6.3(react@18.3.1)" in lab
        assert "react@19.2.8" not in lab
        assert "react-dom@18.3.1(react@18.3.1)" in lock

    def test_frontend_allows_only_font_awesome_to_run_its_known_build_script(self) -> None:
        workspace = FRONTEND_WORKSPACE.read_text(encoding="utf-8")
        assert "onlyBuiltDependencies:\n  - '@fortawesome/fontawesome-free'\n" in workspace
        assert "ignoredBuiltDependencies" not in workspace

    def test_wheel_contains_labextension_package_metadata(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        metadata = json.loads(wheel_contents["courseweave/labextension/package.json"])
        assert metadata["dependencies"]["@jupyterlab/apputils"] == "~4.7.3"
        jupyterlab = metadata["jupyterlab"]
        assert jupyterlab["extension"]
        build = jupyterlab["_build"]
        assert re.fullmatch(r"static/remoteEntry\.[0-9a-f]+\.js", build["load"])
        assert build["extension"] == "./extension"

    def test_wheel_contains_federated_entry(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        entries = [name for name in wheel_contents if REMOTE_ENTRY_RE.fullmatch(name)]
        assert len(entries) == 1, entries
        metadata = json.loads(
            wheel_contents["courseweave/labextension/package.json"]
        )
        assert entries[0].endswith(metadata["jupyterlab"]["_build"]["load"])

    def test_wheel_contains_labextension_schema(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        assert (
            "courseweave/labextension/schemas/@courseweave/lab/plugin.json"
            in wheel_contents
        )

    def test_wheel_registers_scoped_labextension_for_jupyter_discovery(
        self, wheel_contents: dict[str, bytes]
    ) -> None:
        shared = [
            name for name in wheel_contents if SHARED_LABEXTENSION_PACKAGE_RE.match(name)
        ]
        assert len(shared) == 1, sorted(
            name for name in wheel_contents if "share/jupyter" in name
        )
        metadata = json.loads(wheel_contents[shared[0]])
        assert metadata["name"] == "@courseweave/lab"
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
    @staticmethod
    def _assert_no_retained_values(wheel_contents: dict[str, bytes], forbidden: tuple[bytes, ...]) -> None:
        for name, data in wheel_contents.items():
            for marker in forbidden:
                assert marker not in data, (name, marker)

    def test_no_capability_or_token_can_be_retained_in_any_wheel_member(self, wheel_contents: dict[str, bytes]) -> None:
        canary_capability = f"courseweave-capability-canary-{uuid.uuid4().hex}".encode()
        canary_token = f"courseweave-token-canary-{uuid.uuid4().hex}".encode()
        forbidden = (canary_capability, canary_token, b"browser-test-capability", b"test-capability", b"op://")
        with pytest.raises(AssertionError):
            self._assert_no_retained_values({'synthetic-runtime-config': canary_capability}, (canary_capability,))
        self._assert_no_retained_values(wheel_contents, forbidden)

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
        """Generated assets never embed a capability value.

        The trusted parent-to-child runtime protocol necessarily names its
        ``capabilityToken`` field in the Lab bundle; the field name is not a
        credential. This gate rejects actual environment/test values instead.
        """
        for data in _bridge_javascript(wheel_contents):
            assert b"capability_token" not in data
            assert b"COURSEWEAVE_CAPABILITY_TOKEN" not in data
            assert b"browser-test-capability" not in data

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


class TestFederatedSettingsDiscovery:
    """Integration proof through JupyterLab-server's own settings discovery.

    ``jupyterlab_server.get_settings`` is the exact code path the settings
    handler uses to list plugins from federated labextensions: plugin IDs are
    derived from the shipped schema path (``schemas/<name>/<plugin>.json`` →
    ``<name>:<plugin>``). The runtime plugin ID and ``registry.load()`` target
    must match that identity exactly.
    """

    def test_plugin_identity_loads_and_exposes_service_origin(
        self,
        installed_labextensions: Path,
        wheel_contents: dict[str, bytes],
        tmp_path: Path,
    ) -> None:
        from jupyterlab_server.settings_utils import get_settings

        # Empty but existing core/user trees: the federated branch must still
        # discover our shipped schemas.
        schemas_dir = tmp_path / "schemas"
        settings_dir = tmp_path / "settings"
        schemas_dir.mkdir()
        settings_dir.mkdir()
        result, _warnings = get_settings(
            app_settings_dir=str(tmp_path),
            schemas_dir=str(schemas_dir),
            settings_dir=str(settings_dir),
            labextensions_path=[str(installed_labextensions)],
        )
        plugins = {plugin["id"]: plugin for plugin in result["settings"]}
        assert PLUGIN_ID in plugins, sorted(plugins)
        schema = plugins[PLUGIN_ID]["schema"]
        default = schema["properties"]["serviceOrigin"]["default"]
        assert default == "http://127.0.0.1:8765"

        # The built bridge must use the very same runtime identity.
        bundle = _bridge_javascript(wheel_contents)
        assert any(PLUGIN_ID.encode() in data for data in bundle), (
            f"built bridge does not use the {PLUGIN_ID} runtime identity"
        )


class TestActivationOrder:
    def test_command_registration_awaits_service_origin_resolution(self) -> None:
        """No window may exist where the command can create a default-origin
        guide before a custom origin resolves: registration, guard install,
        and initial open must all follow the awaited resolution."""
        source = LAB_ENTRY_TS.read_text(encoding="utf-8")
        resolution = source.index("await resolveServiceOrigin")
        registration = source.index("app.commands.addCommand")
        guard = source.index("installOriginGuard(serviceOrigin);")
        open_call = source.rindex("openGuide();")
        assert resolution < registration, (
            "command registered before service origin resolution completed"
        )
        assert registration < guard < open_call
        assert "async (" in source or "async:" in source or "Promise<void>" in source


def test_sdist_contains_source_rebuild_and_validation_inputs(tmp_path):
    import tarfile
    from hatchling.builders.sdist import SdistBuilder
    archive_path = next(SdistBuilder(str(REPO_ROOT)).build(directory=str(tmp_path)))
    required = [
        'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/pnpm-workspace.yaml',
        'frontend/tsconfig.base.json', 'frontend/vitest.config.ts',
        'frontend/apps/learn/src/app.tsx', 'frontend/apps/learn/vite.config.ts',
        'frontend/apps/author/src/app.tsx', 'frontend/apps/author/vite.config.ts',
        'frontend/packages/ui/src/index.tsx', 'frontend/packages/lab/src/index.ts',
        'frontend/scripts/verify-build-determinism.mjs', 'uv.lock',
        'examples/minimal-course/courseweave.json', 'examples/minimal-course/lesson.md',
        'examples/cli-course/courseweave.json', 'examples/cli-course/lesson.md',
        'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md',
        '.github/workflows/verify.yml',
        THIRD_PARTY_NOTICE,
    ]
    with tarfile.open(archive_path) as archive:
        names = {name.partition('/')[2] for name in archive.getnames()}
        assert set(required) <= names
        assert not any('/node_modules/' in name or '/test-results/' in name for name in names)
        assert not any(
            name.startswith('frontend/packages/lab/lib/') for name in names
        )
        workstation_roots = (
            re.compile(
                rb"/Users/[A-Za-z0-9._-]+/"
                rb"(?:Desktop|Documents|Projects|workspace|education)/"
            ),
            re.compile(rb"/Volumes/[A-Za-z0-9._-]+/(?:workspace|education)/"),
        )
        leaked_docs = []
        for member in archive.getmembers():
            relative = member.name.partition('/')[2]
            if not relative.startswith('docs/') or not member.isfile():
                continue
            extracted = archive.extractfile(member)
            assert extracted is not None
            contents = extracted.read()
            if any(pattern.search(contents) for pattern in workstation_roots):
                leaked_docs.append(relative)
        assert not leaked_docs, leaked_docs
        notice_member = next(
            member
            for member in archive.getmembers()
            if member.name.partition('/')[2] == THIRD_PARTY_NOTICE
        )
        notice_file = archive.extractfile(notice_member)
        assert notice_file is not None
        notice = notice_file.read()
        for component in (
            b"React 19.2.8",
            b"ReactDOM 19.2.8",
            b"scheduler 0.27.0",
        ):
            assert component in notice
        assert REACT_MIT_LICENSE in notice
