"""Shared bounded lexical types; filesystem authority lives in engine.paths."""
from __future__ import annotations

from datetime import date
import re
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import AfterValidator, Field


def local_path(value: str, *, allow_root: bool = False) -> str:
    if allow_root and value == '.':
        return value
    if (not value or len(value) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or '\\' in value or ':' in value or value.startswith('/')
            or any(p in {'', '.', '..'} for p in value.split('/'))):
        raise ValueError('local path must be a normalized relative path')
    return value


def https_url(value: str) -> str:
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value) or '\\' in value:
        raise ValueError('HTTPS URL contains invalid characters')
    if re.search(r'%(?![0-9A-Fa-f]{2})', value):
        raise ValueError('invalid URL percent encoding')
    try:
        url = urlsplit(value)
        port = url.port
        if url.scheme != 'https' or not url.hostname or url.username is not None or url.password is not None:
            raise ValueError('HTTPS URL requires a host and no credentials')
        if port == 0 or '%' in url.netloc:
            raise ValueError('invalid HTTPS authority')
    except ValueError:
        raise ValueError('invalid HTTPS URL') from None
    return value


def reviewed_date(value: str) -> str:
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('reviewed date must use YYYY-MM-DD')
    date.fromisoformat(value)
    return value


def workspace_glob(value: str) -> str:
    local_path(value)
    if value.startswith('!') or '{' in value or '}' in value:
        raise ValueError('workspace globs do not support negation or brace expansion')
    return value


# Compiled Python patterns keep full lexical grammar in generated JSON Schema.
# (?![\s\S]) is an absolute end assertion, unlike $ before a trailing newline.
_PATH = r'^(?!/)(?![\s\S]*[:\\\x00-\x1f\x7f])(?![\s\S]*(?:^|/)(?:\.{1,2})(?:/|$))[^/]+(?:/[^/]+)*(?![\s\S])'
_URL = r'^(?![\s\S]*[\x00-\x20\x7f\\])https://(?![^/?#]*@)(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::[0-9]+)?(?:[/?#][\s\S]*)?(?![\s\S])'
LocalPath = Annotated[str, Field(min_length=1, max_length=1024, pattern=re.compile(_PATH)), AfterValidator(local_path)]
DirectoryPath = Annotated[str, Field(min_length=1, max_length=1024, pattern=re.compile(r'^(?:\.(?![\s\S])|' + _PATH + ')')), AfterValidator(lambda v: local_path(v, allow_root=True))]
HttpsUrl = Annotated[str, Field(min_length=1, max_length=2048, pattern=re.compile(_URL), json_schema_extra={'format': 'uri'}), AfterValidator(https_url)]
ReviewedDate = Annotated[str, Field(pattern=re.compile(r'^\d{4}-\d{2}-\d{2}(?![\s\S])'), json_schema_extra={'format': 'date'}), AfterValidator(reviewed_date)]
WorkspaceGlob = Annotated[str, Field(min_length=1, max_length=1024, pattern=re.compile(r'^(?![!])(?![\s\S]*[{}])' + _PATH)), AfterValidator(workspace_glob)]
NotebookCellId = Annotated[str, Field(min_length=1, max_length=64, pattern=re.compile(r'^[A-Za-z0-9_-]+(?![\s\S])'))]
CommandToken = Annotated[str, Field(min_length=1, max_length=4096, pattern=re.compile(r'^[^\x00]+(?![\s\S])'))]
