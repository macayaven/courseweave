"""Descriptor-relative, no-follow inspection of course-local ordinary files.

No file contents are read by presence checks. Consumers that need authored
content use open_jailed, keeping traversal and reading on the same descriptor.
"""
from contextlib import contextmanager
from pathlib import Path
import os
import stat

from courseweave.contracts.primitives import local_path


class PathValidationError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def safe_traversal_supported() -> bool:
    return all(hasattr(os, name) for name in ('O_NOFOLLOW', 'O_DIRECTORY')) and os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd


@contextmanager
def open_jailed(root: Path, relative: str, *, directory: bool = False):
    """Yield an ordinary file/directory descriptor, rejecting symlinks and swaps."""
    local_path(relative, allow_root=directory)
    if not safe_traversal_supported():
        raise PathValidationError('unsupported_platform')
    descriptors = []
    try:
        parent = os.open(Path(root).resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(parent)
        parts = [] if relative == '.' else relative.split('/')
        for index, part in enumerate(parts):
            need_directory = index < len(parts) - 1 or directory
            before = os.stat(part, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(before.st_mode):
                raise PathValidationError('path_symlink_rejected')
            if not (stat.S_ISDIR(before.st_mode) if need_directory else stat.S_ISREG(before.st_mode)):
                raise PathValidationError('source_type_invalid')
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if need_directory:
                flags |= os.O_DIRECTORY
            opened = os.open(part, flags, dir_fd=parent)
            descriptors.append(opened)
            after = os.fstat(opened)
            if (before.st_dev, before.st_ino, before.st_mode) != (after.st_dev, after.st_ino, after.st_mode):
                raise PathValidationError('path_changed')
            parent = opened
        yield parent
    except FileNotFoundError:
        raise PathValidationError('source_missing') from None
    except OSError:
        raise PathValidationError('path_unavailable') from None
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def probe_path(root: Path, relative: str, *, directory: bool = False) -> str | None:
    """Return a redacted issue code or None, without reading content."""
    try:
        with open_jailed(root, relative, directory=directory):
            return None
    except PathValidationError as exc:
        return exc.code


def ordinary_file_present(root: Path, relative: str) -> bool:
    return probe_path(root, relative) is None


def read_jailed(root: Path, relative: str, *, max_bytes: int) -> bytes:
    with open_jailed(root, relative) as descriptor:
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            data = stream.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise PathValidationError('source_too_large')
        return data
