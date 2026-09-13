"""Retained fix1 lexical matrix, adapted to v2 and numeric legacy IDs."""
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError
import pytest
from courseweave.contracts import CourseManifest, manifest_schema
from test_v2_models import _manifest


def empty_phase():
    data = _manifest()
    data['runtime'] = {'type': 'jupyter', 'kernel': {'type': 'python_uv_project'}}
    return data


def schema_errors(document):
    return list(Draft202012Validator(manifest_schema(), format_checker=FormatChecker()).iter_errors(document))


HTTPS_PREFIX = "https://example.org/"


@pytest.mark.parametrize(
    ("grammar", "value", "accepted"),
    [
        ("slug", "a", True),
        ("slug", "a1-b2", True),
        ("slug", "a" * 80, True),
        ("slug", "", False),
        ("slug", "1bad", True),
        ("slug", "Bad", False),
        ("slug", "bad-", False),
        ("slug", "bad\n", False),
        ("slug", "a" * 81, False),
        ("custom_id", "a.b/c", True),
        ("custom_id", "example.org/structured-debate", True),
        ("custom_id", "a." + "b" * 156 + "/c", True),
        ("custom_id", "example/debate", False),
        ("custom_id", "Example.org/debate", False),
        ("custom_id", "example.org/debate_1", False),
        ("custom_id", "example.org/debate\n", False),
        ("custom_id", "a." + "b" * 157 + "/c", False),
        ("path", "a", True),
        ("path", "notes/lesson.md", True),
        ("path", "a" * 1024, True),
        ("path", "", False),
        ("path", "/etc/passwd", False),
        ("path", "C:/course/file", False),
        ("path", "notes\\lesson.md", False),
        ("path", "notes/\x00lesson.md", False),
        ("path", "notes//lesson.md", False),
        ("path", ".", False),
        ("path", "..", False),
        ("path", "notes/./lesson.md", False),
        ("path", "notes/../lesson.md", False),
        ("path", "notes/", False),
        ("path", "a" * 1025, False),
        ("cwd", ".", True),
        ("cwd", "workspace", True),
        ("cwd", "..", False),
        ("glob", "*", True),
        ("glob", "notes/**/*.md", True),
        ("glob", "literal[abc]?.md", True),
        ("glob", "notes/!important.md", True),
        ("glob", "a" * 1024, True),
        ("glob", "", False),
        ("glob", "/notes/*.md", False),
        ("glob", "C:/notes/*.md", False),
        ("glob", "notes\\*.md", False),
        ("glob", "notes/\x00*.md", False),
        ("glob", "notes//*.md", False),
        ("glob", "notes/../*.md", False),
        ("glob", "notes/", False),
        ("glob", "!notes/*.md", False),
        ("glob", "notes/{a,b}.md", False),
        ("glob", "a" * 1025, False),
        ("url", "https://example.org", True),
        ("url", "https://example.org:8443/a?q=1#part", True),
        ("url", "https://[2001:db8::1]/video", True),
        ("url", HTTPS_PREFIX + "a" * (2048 - len(HTTPS_PREFIX)), True),
        ("url", "http://example.org", False),
        ("url", "//example.org", False),
        ("url", "https:///missing-host", False),
        ("url", "https://user@example.org/", False),
        ("url", "https://user:secret@example.org/", False),
        ("url", HTTPS_PREFIX + "a" * (2049 - len(HTTPS_PREFIX)), False),
        ("notebook_id", "a", True),
        ("notebook_id", "A0_-", True),
        ("notebook_id", "a" * 64, True),
        ("notebook_id", "", False),
        ("notebook_id", "a" * 65, False),
        ("notebook_id", "cell.id", False),
        ("notebook_id", "cell id", False),
        ("notebook_id", "célula", False),
        ("notebook_id", "cell_id\n", False),
        ("token", "x", True),
        ("token", " ", True),
        ("token", "x" * 4096, True),
        ("token", "", False),
        ("token", "x" * 4097, False),
        ("token", "bad\x00token", False),
    ],
)
def test_lexical_grammar_accept_reject_matrix(
    grammar: str, value: str, accepted: bool
) -> None:
    document = empty_phase()
    phase = document["modules"][0]["phases"][0]
    if grammar == "slug":
        document["id"] = value
    elif grammar == "custom_id":
        phase["experience"] = {"type": "custom", "id": value}
    elif grammar == "path":
        phase["surfaces"] = [
            {
                "id": "surface",
                "purpose": "primary",
                "type": "markdown",
                "label": "Lesson",
                "path": value,
            }
        ]
    elif grammar == "cwd":
        phase["surfaces"] = [
            {
                "id": "terminal",
                "purpose": "primary",
                "type": "terminal",
                "label": "Terminal",
                "command": ["uv"],
                "cwd": value,
            }
        ]
    elif grammar == "glob":
        document["policies"]["workspace_write_globs"] = [value]
    elif grammar == "url":
        phase["surfaces"] = [
            {
                "id": "link",
                "purpose": "reference",
                "type": "external",
                "label": "Reference",
                "url": value,
            }
        ]
    elif grammar == "notebook_id":
        phase["surfaces"] = [
            {
                "id": "notebook",
                "purpose": "primary",
                "type": "notebook",
                "label": "Notebook",
                "path": "lesson.ipynb",
                "selector": {"type": "cell_ids", "values": [value]},
            }
        ]
    elif grammar == "token":
        phase["surfaces"] = [
            {
                "id": "terminal",
                "purpose": "primary",
                "type": "terminal",
                "label": "Terminal",
                "command": [value],
                "cwd": ".",
            }
        ]
    else:
        raise AssertionError(grammar)

    assert (schema_errors(document) == []) is accepted
    if accepted:
        CourseManifest.model_validate(document)
    else:
        with pytest.raises(ValidationError):
            CourseManifest.model_validate(document)
