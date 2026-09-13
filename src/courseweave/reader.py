"""Course-bound HTML and static image bytes for the scripts-disabled reader."""
from html.parser import HTMLParser
from pathlib import Path
from posixpath import dirname, join, normpath
from urllib.parse import urlsplit

from courseweave.contracts.primitives import local_path
from courseweave.engine.paths import read_jailed
from courseweave.manifest import ManifestError, parse_manifest_bytes

_IMAGE_TYPES = {'.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg',
                '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif'}


class _Images(HTMLParser):
    def __init__(self, lesson: str):
        super().__init__()
        self.lesson = lesson
        self.paths: set[str] = set()

    def handle_starttag(self, tag, attrs):
        if tag != 'img':
            return
        raw = dict(attrs).get('src')
        if not raw or raw.startswith('/') or '%' in raw or '\\' in raw:
            return
        parsed = urlsplit(raw)
        if parsed.scheme or parsed.netloc or parsed.query:
            return
        path = normpath(join(dirname(self.lesson), parsed.path))
        try:
            local_path(path)
        except ValueError:
            return
        if Path(path).suffix.lower() in _IMAGE_TYPES:
            self.paths.add(path)


def read_reader_file(root: Path, path: str) -> tuple[bytes, str]:
    """Require a current HTML declaration or a local image referenced by one.

    Reads use descriptor-relative no-follow traversal; neither HTML nor image
    content is rewritten. The HTTP handler supplies a scripts-disabled CSP.
    """
    local_path(path)
    try:
        manifest = parse_manifest_bytes(read_jailed(root, "courseweave.json", max_bytes=1024*1024), root)
    except ManifestError:
        raise ValueError("reader_manifest_unavailable") from None
    lessons = {str(surface.path) for module in manifest.modules for phase in module.phases
               for surface in phase.surfaces if surface.type == 'html'}
    if path in lessons:
        return read_jailed(root, path, max_bytes=262144), 'text/html; charset=utf-8'
    media_type = _IMAGE_TYPES.get(Path(path).suffix.lower())
    if media_type is None:
        raise ValueError('reader_path_unavailable')
    for lesson in sorted(lessons):
        try:
            parser = _Images(lesson)
            parser.feed(read_jailed(root, lesson, max_bytes=262144).decode('utf-8'))
            parser.close()
        except (ValueError, UnicodeError):
            continue
        if path in parser.paths:
            return read_jailed(root, path, max_bytes=4*1024*1024), media_type
    raise ValueError('reader_path_unavailable')
