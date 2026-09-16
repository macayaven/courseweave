"""Explicit public source research. Policy is independent of model output.

Only normalized public HTTPS destinations can reach the transport. The source
registry and author review service remain the owners of saved source decisions.
"""
from __future__ import annotations

import ipaddress
import re
import json
import os
import http.client
import queue
import socket
import ssl
import threading
import time
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import Message
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable
from urllib.parse import quote, unquote, urlsplit, urlunsplit, urljoin, urlencode
from uuid import uuid4

from pydantic import ValidationError

from .contracts import OriginRule, ResearchPolicy, FetchResult, SearchResult, SourceRecord, SourceProvenance, SourceRevision, ResearchRequest, ResearchReport
from .project import ProjectError, atomic_bytes, atomic_json, read_private, read_sources, local_directory, MAX_FILES
from ..store import CourseStore


class SourceError(ProjectError):
    pass


class SourceDenied(SourceError):
    pass


class ResearchCancelled(SourceError):
    pass


class ResearchLimit(SourceError):
    pass


MAX_FETCH_BYTES = 2 * 1024 * 1024
_DNS_SLOTS = threading.BoundedSemaphore(4)


@dataclass
class ResearchControl:
    deadline: float
    cancel: threading.Event = field(default_factory=threading.Event)
    clock: Callable[[], float] = time.monotonic

    @classmethod
    def seconds(cls, seconds: float, *, clock=time.monotonic):
        return cls(clock() + seconds, clock=clock)

    def child(self, seconds: float):
        return ResearchControl(min(self.deadline, self.clock() + seconds), self.cancel, self.clock)

    def check(self) -> float:
        if self.cancel.is_set():
            raise ResearchCancelled("Research was cancelled.")
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise ResearchLimit("Research reached its elapsed-time limit.")
        return remaining


@dataclass(frozen=True)
class HttpResult:
    status: int
    headers: dict[str, str]
    content: bytes


def _resolve(host: str, control: ResearchControl, resolver) -> list:
    control.check()
    if not _DNS_SLOTS.acquire(blocking=False):
        raise SourceError("Public DNS lookup capacity is busy; try a later explicit request.")
    results = queue.Queue(maxsize=1)
    def work():
        try:
            results.put((True, resolver(host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)))
        except Exception:
            results.put((False, None))
        finally:
            _DNS_SLOTS.release()
    # A cancelled/expired libc lookup may finish only DNS, never HTTP. Daemon
    # workers are capped and cannot keep application shutdown waiting on DNS.
    worker = threading.Thread(target=work, name="courseweave-public-dns", daemon=True)
    try:
        worker.start()
    except RuntimeError:
        _DNS_SLOTS.release()
        raise SourceError("Public DNS lookup is unavailable.") from None
    while True:
        try:
            ok, addresses = results.get(timeout=min(0.05, control.check()))
            control.check()
            if not ok or not addresses or len(addresses) > 64:
                raise SourceError("Public DNS lookup is unavailable or exceeds its address limit.")
            if any(info[0] not in (socket.AF_INET, socket.AF_INET6) or not public_address(info[4][0]) for info in addresses):
                raise SourceDenied("Every DNS address must be public unicast.")
            return sorted(addresses, key=lambda info: info[0] != socket.AF_INET)
        except queue.Empty:
            continue


def _body(response, headers: dict, control: ResearchControl) -> bytes:
    encoding = headers.get("content-encoding", "identity").lower().strip()
    if encoding not in {"identity", "gzip", "deflate"}:
        raise SourceError("The source content encoding is unsupported.")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS) if encoding != "identity" else None
    output = bytearray()
    wire_bytes = 0
    try:
        while True:
            control.check()
            chunk = response.read1(16 * 1024)
            control.check()
            if not chunk:
                break
            wire_bytes += len(chunk)
            if wire_bytes > MAX_FETCH_BYTES + 65536:
                raise ResearchLimit("The source exceeds the download size limit.")
            part = decoder.decompress(chunk, MAX_FETCH_BYTES - len(output) + 1) if decoder else chunk
            output.extend(part)
            if len(output) > MAX_FETCH_BYTES or (decoder and decoder.unconsumed_tail):
                raise ResearchLimit("The source exceeds the 2 MiB decompressed size limit.")
            if decoder and decoder.unused_data:
                raise SourceError("Multiple or trailing compressed streams are unsupported.")
        if decoder and not decoder.eof:
            raise SourceError("The compressed source response is incomplete.")
        declared = headers.get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) != wire_bytes):
            raise SourceError("The source response is incomplete or has an invalid length.")
        return bytes(output)
    except zlib.error:
        raise SourceError("The compressed source response is invalid or incomplete.") from None


class PublicHttpsTransport:
    """One public pinned connection, no proxy, cookie jar, retry or redirect."""

    def __init__(self, *, resolver=socket.getaddrinfo, socket_factory=socket.socket,
                 tls_context=None, connection_factory=http.client.HTTPConnection):
        self.resolver, self.socket_factory = resolver, socket_factory
        self.tls = tls_context if tls_context is not None else ssl.create_default_context()
        self.connection_factory = connection_factory

    def get(self, url: str, control: ResearchControl, *, headers: dict[str, str] | None = None) -> HttpResult:
        control.check()
        selected = urlsplit(normalize_url(url))
        host = selected.hostname
        if not self.tls.check_hostname or self.tls.verify_mode != ssl.CERT_REQUIRED:
            raise SourceError("Public retrieval requires verified TLS hostnames.")
        extra = headers or {}
        if (any(key.lower() in {"host", "authorization", "cookie", "proxy-authorization"} for key in extra)
                or (any(key.lower() == "x-subscription-token" for key in extra) and host != "api.search.brave.com")
                or any(any(ord(char) < 32 or ord(char) == 127 for char in key + value) for key, value in extra.items())):
            raise SourceError("Source retrieval cannot inherit authentication headers.")
        addresses = _resolve(host, control, self.resolver)
        family, _, protocol, _, address = addresses[0]
        pinned_ip = address[0]
        destination = (pinned_ip, 443) if family == socket.AF_INET else (pinned_ip, 443, 0, 0)
        sock = self.socket_factory(family, socket.SOCK_STREAM, protocol)
        owned = [sock]
        finished = threading.Event()
        connection = None
        def close_owned():
            try:
                owned[0].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            owned[0].close()
        def watchdog():
            while not finished.wait(0.02):
                if control.cancel.is_set() or control.clock() >= control.deadline:
                    close_owned()
                    return
        watcher = threading.Thread(target=watchdog, name="courseweave-fetch-deadline", daemon=True)
        try:
            watcher.start()
            sock.settimeout(control.check())
            sock.connect(destination)
            if ipaddress.ip_address(sock.getpeername()[0]) != ipaddress.ip_address(pinned_ip):
                raise SourceDenied("The connected source differs from its validated address.")
            sock.settimeout(control.check())
            secured = self.tls.wrap_socket(sock, server_hostname=host)
            owned[0] = secured
            secured.settimeout(control.check())
            connection = self.connection_factory(host, 443, timeout=control.check())
            # An already-connected socket prevents HTTPConnection from making
            # a second unrestricted resolution or consulting a proxy.
            connection.sock = secured
            request_headers = {"Host": selected.netloc, "User-Agent": "CourseWeave-Author-Research",
                "Accept": "text/html, text/plain, text/markdown", "Accept-Encoding": "gzip, deflate", "Connection": "close", **extra}
            path = selected.path + ("?" + selected.query if selected.query else "")
            connection.request("GET", path, headers=request_headers)
            response = connection.getresponse()
            control.check()
            raw_headers = response.getheaders()
            if sum(len(key) + len(value) for key, value in raw_headers) > 65536:
                raise ResearchLimit("Source response headers exceed the supported limit.")
            retained = {}
            for key, value in raw_headers:
                key = key.lower()
                if key in {"content-type", "content-encoding", "content-length", "location"}:
                    if key in retained:
                        raise SourceError("Ambiguous duplicate source response headers.")
                    retained[key] = value.strip()
            content = _body(response, retained, control) if 200 <= response.status < 300 else b""
            return HttpResult(response.status, retained, content)
        except (OSError, http.client.HTTPException):
            control.check()
            raise SourceError("The public HTTPS source is unavailable.") from None
        finally:
            finished.set()
            if connection is not None:
                connection.close()
            else:
                close_owned()


def public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and (address.ipv4_mapped or address.sixtofour or address.teredo):
        return False
    return (address.is_global and not address.is_multicast and not address.is_reserved
            and not address.is_loopback and not address.is_link_local and not address.is_unspecified)


def _path(value: str) -> str:
    try:
        decoded = unquote(value, encoding="utf-8", errors="strict")
    except UnicodeError:
        raise SourceError("URL path encoding is unsupported.") from None
    # Reject ambiguous double decoding and separator/control aliases. The
    # canonical result is both compared with policy and sent on the wire.
    if "%" in decoded or "\\" in decoded or any(ord(char) < 32 or ord(char) == 127 for char in decoded):
        raise SourceError("Ambiguous URL path encoding is unsupported.")
    parts = []
    for part in decoded.split("/"):
        if part == "..":
            if parts:
                parts.pop()
        elif part not in {"", "."}:
            parts.append(part)
    path = "/" + "/".join(parts)
    if decoded.endswith("/") and parts:
        path += "/"
    return quote(path, safe="/!$&'()*+,-.:;=@_~")


def normalize_url(value: str) -> str:
    if (not isinstance(value, str) or not value or len(value) > 4096 or "\\" in value
            or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value)
            or re.search(r"%(?![0-9a-fA-F]{2})", value)):
        raise SourceError("Use a bounded, unambiguous public HTTPS URL.")
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() != "https" or parts.username is not None or parts.password is not None or parts.port not in (None, 443):
            raise ValueError()
        host = (parts.hostname or "").rstrip(".").encode("idna").decode("ascii").lower()
        if not host or len(host) > 253 or "%" in host:
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if ("." not in host or host.endswith((".localhost", ".local", ".internal", ".lan", ".home"))
                    or host.rsplit(".", 1)[-1].isdigit()
                    or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split("."))):
                raise ValueError()
        else:
            if not public_address(host):
                raise ValueError()
            host = address.compressed
            if ":" in host:
                host = "[" + host + "]"
        path = _path(parts.path)
        query = quote(parts.query, safe="!$&'()*+,-./:;=?@_%~")
        result = urlunsplit(("https", host, path, query, ""))
        if len(result) > 4096:
            raise ValueError()
        return result
    except (ValueError, UnicodeError):
        raise SourceError("Only public HTTPS origins on port 443 without user information are supported.") from None


def _rule(rule: OriginRule) -> tuple[str, str]:
    normalized = urlsplit(normalize_url(rule.origin))
    raw = urlsplit(rule.origin)
    if normalized.path != "/" or raw.query or raw.fragment or not rule.path_prefix.startswith("/") or "?" in rule.path_prefix or "#" in rule.path_prefix:
        raise SourceError("Policy rules require an HTTPS origin and a separate absolute path prefix.")
    if re.search(r"%(?![0-9a-fA-F]{2})", rule.path_prefix):
        raise SourceError("Policy path prefix is invalid.")
    return normalized.netloc, _path(rule.path_prefix).rstrip("/") or "/"


def validate_policy(policy: ResearchPolicy) -> None:
    for rule in (*policy.allow, *policy.deny):
        _rule(rule)


def policy_permits(policy: ResearchPolicy, url: str) -> bool:
    try:
        validate_policy(policy)
        normalized = urlsplit(normalize_url(url))
        def matches(rule):
            host, prefix = _rule(rule)
            return normalized.netloc == host and (prefix == "/" or normalized.path == prefix or normalized.path.startswith(prefix + "/"))
        return not any(matches(rule) for rule in policy.deny) and (policy.mode == "public_web" or any(matches(rule) for rule in policy.allow))
    except SourceError:
        return False


class PublicFetcher:
    """Up to three reviewed-policy redirects within one ten-second fetch."""

    def __init__(self, *, transport=None, control: ResearchControl | None = None):
        self.transport = transport if transport is not None else PublicHttpsTransport()
        self.control = control

    def fetch(self, url: str, policy: ResearchPolicy) -> FetchResult:
        control = self.control.child(10) if self.control is not None else ResearchControl.seconds(10)
        current, redirects, media = None, [], None
        def result(status, message, content=b""):
            return FetchResult(url=url, final_url=current, status=status, message=message,
                retrieved_at=datetime.now(timezone.utc), media_type=media, content=content, redirects=tuple(redirects))
        try:
            validate_policy(policy)
            current = normalize_url(url)
        except SourceError:
            return result("denied", "The URL or policy is invalid for public HTTPS research.")
        try:
            while True:
                control.check()
                if not policy.permits(current):
                    return result("denied", "The source or redirect destination is outside the selected research policy.")
                response = self.transport.get(current, control)
                control.check()
                if response.status in {301, 302, 303, 307, 308}:
                    if len(redirects) >= 3:
                        return result("limit_exceeded", "The source exceeded three redirects; no further request was made.")
                    location = response.headers.get("location")
                    if not location:
                        return result("unavailable", "The redirect did not provide a destination.")
                    try:
                        current = normalize_url(urljoin(current, location))
                    except SourceError:
                        return result("denied", "The redirect destination is not a supported public HTTPS URL.")
                    redirects.append(current)
                    continue
                if response.status != 200:
                    return result("unavailable", f"The source returned HTTP {response.status}; no retry or access bypass was attempted.")
                declared_media = response.headers.get("content-type", "")
                if len(declared_media) > 200:
                    return result("unsupported", "The source media-type declaration exceeds the supported limit.")
                media = declared_media
                if media.split(";", 1)[0].strip().lower() not in {"text/plain", "text/html", "text/markdown", "application/xhtml+xml"}:
                    return result("unsupported", "Only public HTML, Markdown and plain-text source content is supported. Supply a reviewed text extract for other formats.")
                if len(response.content) > MAX_FETCH_BYTES:
                    return result("limit_exceeded", "The source exceeds the 2 MiB decompressed size limit.")
                return result("fetched", "Public source retrieved. It remains unreviewed and unapproved.", response.content)
        except ResearchCancelled:
            return result("cancelled", "Source retrieval was cancelled; no subsequent request was made.")
        except ResearchLimit as exc:
            return result("limit_exceeded", str(exc))
        except SourceDenied as exc:
            return result("denied", str(exc))
        except SourceError as exc:
            return result("unavailable", str(exc))
        except Exception:
            return result("unavailable", "The public source could not be retrieved; no retry was attempted.")


class BraveSearch:
    """One optional author-owned Web Search API key; never a provider/browser key."""

    def __init__(self, api_key: str | None = None, *, transport=None, control: ResearchControl | None = None):
        self._api_key = api_key
        self.transport = transport if transport is not None else PublicHttpsTransport()
        self.control = control

    @classmethod
    def from_environ(cls, values=None, **kwargs):
        return cls((os.environ if values is None else values).get("BRAVE_SEARCH_API_KEY"), **kwargs)

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    def search(self, query: str, limit: int) -> tuple[SearchResult, ...]:
        if not self.configured:
            raise SourceError("Brave Search is not configured. Explicit public URL and local file workflows remain available.")
        if not isinstance(query, str) or not query.strip() or len(query) > 600 or len(query.split()) > 75:
            raise SourceError("Brave Search queries allow at most 600 characters and 75 words; edit the query before sending.")
        if type(limit) is not int or not 1 <= limit <= 10:
            raise SourceError("Retain between one and ten search results.")
        control = self.control.child(10) if self.control is not None else ResearchControl.seconds(10)
        control.check()
        url = "https://api.search.brave.com/res/v1/web/search?" + urlencode({"q": query, "count": limit,
            "result_filter": "web", "text_decorations": "false", "spellcheck": "false"})
        response = self.transport.get(url, control, headers={"X-Subscription-Token": self._api_key, "Accept": "application/json"})
        control.check()
        if response.status != 200:
            message = ("Brave Search rejected the credential or account access." if response.status in {401, 403}
                else "Brave Search is rate limited." if response.status == 429
                else "Brave Search is unavailable or returned an unsupported redirect.")
            raise SourceError(message + " No retry was attempted; explicit public URLs remain available.")
        if len(response.content) > MAX_FETCH_BYTES:
            raise ResearchLimit("The search response exceeds the 2 MiB size limit.")
        try:
            body = json.loads(response.content)
            if not isinstance(body, dict) or not ("web" in body or "query" in body):
                raise ValueError()
            web = body.get("web")
            rows = web.get("results", []) if web is not None else []
            if not isinstance(rows, list):
                raise ValueError()
            retrieved = datetime.now(timezone.utc)
            result = []
            for row in rows[:limit]:
                title, source_url, snippet = row["title"], row["url"], row.get("description", "")
                if any(not isinstance(value, str) for value in (title, source_url, snippet)) or not title.strip() or not source_url.strip():
                    raise ValueError()
                if len(snippet) > 4000:
                    snippet = snippet[:3970] + " [snippet truncated]"
                result.append(SearchResult(url=source_url, title=title[:500], snippet=snippet, query=query,
                    retrieved_at=retrieved, publication_date=None))
            return tuple(result)
        except (ValueError, KeyError, TypeError, AttributeError):
            raise SourceError("Brave Search returned invalid result data. No replacement results or retry were generated.") from None


@dataclass(frozen=True)
class Extraction:
    status: str
    text: str = ""
    title: str = ""
    version: str = "author-text-v1"
    message: str = ""


class _HTMLText(HTMLParser):
    """A bounded static text extractor. No layout, script or remote resources."""
    _void = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    _block = {"article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p", "pre", "section", "table", "tr", "ul"}
    _omit = {"head", "title", "script", "style", "template", "noscript", "form", "iframe", "object", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.parts, self.titles = [], [], []
        self.elements = 0
        self.password = self.script = False

    def newline(self):
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_starttag(self, tag, attrs):
        self.elements += 1
        if self.elements > 50000 or len(self.stack) >= 128:
            raise SourceError("HTML structure exceeds the supported extraction limit.")
        attributes = dict(attrs)
        inherited = self.stack[-1][1] if self.stack else False
        hidden = ("hidden" in attributes or attributes.get("aria-hidden", "").lower() == "true"
            or re.search(r"(?:display\s*:\s*none|visibility\s*:\s*hidden)", attributes.get("style", ""), re.I))
        suppressed = bool(inherited or tag in self._omit or hidden)
        if tag == "input" and attributes.get("type", "").lower() == "password":
            self.password = True
        self.script = self.script or tag == "script"
        if not suppressed:
            if tag in self._block:
                self.newline()
            if tag == "img" and attributes.get("alt"):
                self.handle_data(attributes["alt"])
        if tag not in self._void:
            self.stack.append((tag, suppressed))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self._void:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                if tag in self._block and not self.stack[index][1]:
                    self.newline()
                del self.stack[index:]
                break

    def handle_data(self, data):
        if any(tag == "title" for tag, _ in self.stack):
            self.titles.append(data)
        if self.stack and self.stack[-1][1]:
            return
        if not any(tag == "pre" for tag, _ in self.stack):
            data = re.sub(r"\s+", " ", data)
            if not self.parts or self.parts[-1].endswith("\n"):
                data = data.lstrip()
        if data:
            self.parts.append(data)


def extract_source(content: bytes, media_type: str | None) -> Extraction:
    """Offsets address the retained UTF-8 text, never the original HTML bytes."""
    if len(content) > MAX_FETCH_BYTES:
        return Extraction("unsupported", message="Source exceeds the 2 MiB text extraction limit.")
    header = Message()
    header["content-type"] = media_type or "application/octet-stream"
    mime = header.get_content_type().lower()
    if mime not in {"text/plain", "text/markdown", "text/html", "application/xhtml+xml"}:
        return Extraction("unsupported", message="This attachment has no supported text extraction. Supply a reviewed text extract with its provenance.")
    charset = header.get_content_charset()
    if charset is None and mime in {"text/html", "application/xhtml+xml"}:
        meta = re.search(rb'<meta\b[^>]{0,1024}\bcharset\s*=\s*[\x22\x27]?([a-zA-Z0-9_-]+)', content[:4096], re.I)
        charset = meta.group(1).decode("ascii").lower() if meta else None
    charset = (charset or "utf-8-sig").lower()
    if charset not in {"utf-8", "utf8", "utf-8-sig", "ascii", "us-ascii", "iso-8859-1", "latin-1", "windows-1252", "cp1252"}:
        return Extraction("unsupported", message="Source character encoding is unsupported. Supply a UTF-8 text extract.")
    try:
        text = content.decode(charset).replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeError:
        return Extraction("unsupported", message="Source text does not match its declared encoding. Supply a UTF-8 text extract.")
    if any(ord(char) < 32 and char not in "\n\t" for char in text):
        return Extraction("unsupported", message="Binary/control content is unsupported as source text.")
    if not text.strip():
        return Extraction("unavailable", message="The source is empty; no supporting text was found.")
    title = ""
    if mime in {"text/html", "application/xhtml+xml"}:
        parser = _HTMLText()
        try:
            parser.feed(text)
            parser.close()
        except (SourceError, ValueError, RecursionError):
            return Extraction("unsupported", message="HTML structure exceeds supported static text extraction. Supply a reviewed text extract.")
        title = re.sub(r"\s+", " ", "".join(parser.titles)).strip()[:500]
        text = re.sub(r"[ \t]+\n", "\n", "".join(parser.parts)).strip()
        if parser.password or (len(text) < 1500 and re.search(r"^(?:sign in|log in|login)\b", title, re.I)):
            return Extraction("unavailable", title=title, message="A login form was detected; authenticated content is unavailable.")
        if len(text) < 6000 and re.search(r"just a moment|verify you are human|checking your browser|access denied", title + "\n" + text, re.I):
            return Extraction("unavailable", title=title, message="An access challenge or blocked page was detected; no bypass was attempted.")
        if not text:
            return Extraction("unsupported" if parser.script else "unavailable", title=title,
                message="JavaScript-only or empty HTML has no supported static source text. Supply a reviewed text extract.")
        text += "\n"
    if len(text.encode("utf-8")) > MAX_FETCH_BYTES:
        return Extraction("unsupported", title=title, message="Extracted UTF-8 text exceeds the 2 MiB retention limit.")
    return Extraction("text", text=text, title=title,
        message="Static text retained; offsets refer to this extraction. Scripts, forms, hidden elements and styling are omitted; visual layout and linked resources are not interpreted."
            if mime in {"text/html", "application/xhtml+xml"} else "Text retained with line endings normalized to LF; offsets refer to this extraction.")


def save_source_snapshot(project, *, origin, content, extraction, title, policy_decision,
                         media_type=None, retrieved_at=None, final_url=None, intended_use="author_reference") -> SourceRecord:
    """Publish a source revision while the caller holds the canonical course lock."""
    digest = sha256(content).hexdigest()
    text_bytes = extraction.text.encode("utf-8") if extraction.status == "text" else None
    text_hash = sha256(text_bytes).hexdigest() if text_bytes is not None else None
    records = list(read_sources(project))
    index = next((i for i, record in enumerate(records) if record.origin == origin), None)
    previous = records[index] if index is not None else None
    if (previous and previous.raw_sha256 == digest and previous.text_sha256 == text_hash
            and previous.extractor_version == (extraction.version if text_bytes is not None else None)
            and previous.final_url == final_url):
        if (sha256(read_private(project.state_root, previous.snapshot_path, max_bytes=8 * 1024 * 1024)).hexdigest() != digest
                or (text_bytes is not None and (not previous.text_path or sha256(read_private(project.state_root, previous.text_path, max_bytes=MAX_FETCH_BYTES)).hexdigest() != text_hash))):
            raise SourceError("Saved source snapshot is corrupt; restore a verified backup before reusing it.")
        return previous
    if previous is None and len(records) >= MAX_FILES:
        raise SourceError("Source registry limit reached.")
    source_id = previous.source_id if previous else "source-" + uuid4().hex
    revision = previous.revision + 1 if previous else 0
    prefix = f"sources/{source_id}/snapshot-{uuid4().hex}"
    record = SourceRecord(source_id=source_id, revision=revision, title=(extraction.title or title)[:500], origin=origin,
        course_path=previous.course_path if previous else None,
        imported_at=datetime.now(timezone.utc), retrieved_at=retrieved_at, final_url=final_url, media_type=media_type,
        raw_sha256=digest, text_sha256=text_hash, extractor_version=extraction.version if text_bytes is not None else None,
        snapshot_path=prefix + "/raw", text_path=prefix + "/text.txt" if text_bytes is not None else None,
        policy_decision=policy_decision, extraction=extraction.status, extraction_note=extraction.message,
        intended_use=intended_use)
    atomic_bytes(project.state_root / record.snapshot_path, content)
    if text_bytes is not None:
        atomic_bytes(project.state_root / record.text_path, text_bytes)
    atomic_json(project.state_root / prefix / "record.json", record.model_dump(mode="json"))
    if index is None:
        records.append(record)
    else:
        records[index] = record
    # The atomic registry is the sole publication point. An interrupted
    # preparation can leave private orphan bytes, never a half source.
    atomic_json(project.state_root / "sources.json", [r.model_dump(mode="json") for r in records], replace=True)
    return record


def _report_names(project) -> list[str]:
    root = project.state_root / "research"
    names = []
    with local_directory(root, create=True) as fd:
        with os.scandir(fd) as entries:
            for index, entry in enumerate(entries):
                if index >= 1000:
                    raise SourceError("Research report directory limit reached; back up and manage saved reports.")
                if re.fullmatch(r"research-[a-f0-9]{32}\.json", entry.name):
                    names.append((entry.stat(follow_symlinks=False).st_mtime_ns, entry.name))
    return [name for _, name in sorted(names, reverse=True)]


def read_research_report(project, report_id: str) -> ResearchReport:
    if not re.fullmatch(r"research-[a-f0-9]{32}", report_id):
        raise SourceError("Choose a saved research report from this project.")
    try:
        report = ResearchReport.model_validate_json(read_private(project.state_root, f"research/{report_id}.json", max_bytes=1024 * 1024))
        if report.report_id != report_id or any(fetch.content for fetch in report.fetches):
            raise ValueError()
        return report
    except (ValueError, OSError):
        raise SourceError("Research report is unavailable or corrupt; restore a verified backup.") from None


def list_research_reports(project, *, offset=0, limit=20) -> tuple[ResearchReport, ...]:
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 20:
        raise SourceError("Choose a valid research report page of at most twenty reports.")
    return tuple(read_research_report(project, name[:-5]) for name in _report_names(project)[offset:offset + limit])


def import_reference(project, source_path: Path) -> SourceRecord:
    from .project import import_resource
    with CourseStore.author_project_lock(project.course_root, project.state_root / "transactions"):
        return import_resource(project, source_path, intended_use="author_reference")


def source_provenance(record: SourceRecord) -> SourceProvenance:
    data = record.model_dump(include=set(SourceProvenance.model_fields))
    if record.policy_decision == "local":
        data.update(origin="local:" + Path(record.origin).name, final_url=None)
    return SourceProvenance.model_validate(data)


def verified_source_text(project, record: SourceRecord) -> str:
    """Check both retained identities; caller owns any required course lock."""
    raw = read_private(project.state_root, record.snapshot_path, max_bytes=8 * 1024 * 1024)
    if sha256(raw).hexdigest() != record.raw_sha256:
        raise SourceError("Source snapshot is corrupt or changed; restore a verified backup.")
    if record.text_path:
        data = read_private(project.state_root, record.text_path, max_bytes=MAX_FETCH_BYTES)
        if sha256(data).hexdigest() != record.text_sha256:
            raise SourceError("Source text is corrupt or changed; restore a verified backup.")
        try:
            return data.decode("utf-8")
        except UnicodeError:
            raise SourceError("Source text is corrupt; restore a verified backup.") from None
    if record.extraction == "text":
        raise SourceError("Source text is unavailable; restore a verified backup.")
    return ""


def source_excerpt(project, source_id: str, *, revision: int, start=0, limit=8000) -> dict:
    if type(start) is not int or start < 0 or type(limit) is not int or not 1 <= limit <= 8000:
        raise SourceError("Choose a nonnegative text offset and at most 8,000 characters.")
    with CourseStore.author_project_lock(project.course_root, project.state_root / "transactions"):
        record = next((record for record in read_sources(project) if record.source_id == source_id), None)
        if record is None or record.revision != revision:
            raise SourceError("Source revision changed or is unavailable; reload source decisions.")
        text = verified_source_text(project, record)
        if start > len(text):
            raise SourceError("Text offset exceeds this source revision.")
        excerpt = text[start:start + limit]
        return {"source": record.model_dump(mode="json"), "text": excerpt, "start": start,
            "end": start + len(excerpt), "total_characters": len(text),
            "notice": record.extraction_note or "Offsets refer to the retained UTF-8 text; a matching quotation establishes provenance, not truth."}


def run_research(project, request, *, search=None, fetcher=None, control=None) -> ResearchReport:
    """One explicit, bounded run; discovery never chooses what to fetch."""
    try:
        request = ResearchRequest.model_validate(request)
        validate_policy(request.policy)
    except (ValidationError, SourceError):
        raise SourceError("Research needs explicit network enablement, a valid policy, and at most two queries/five URLs.") from None
    if len(_report_names(project)) >= 500:
        raise SourceError("Research report limit reached (500); back up and manage saved reports before a new run.")
    control = control.child(60) if control is not None else ResearchControl.seconds(60)
    started = datetime.now(timezone.utc)
    search = search if search is not None else BraveSearch.from_environ(control=control)
    fetcher = fetcher if fetcher is not None else PublicFetcher(control=control)
    results, fetches, source_ids, notices = [], [], [], []
    if request.queries:
        notices.append("Discovery results are temporary and are not saved in reports or backups. A new explicit search is required to see results again after reopening a report.")
    status, errors, completed = "complete", False, False
    seen = set()
    try:
        for index, query in enumerate(request.queries):
            control.check()
            limit = (10 - len(results)) // (len(request.queries) - index)
            try:
                rows = search.search(query, limit)
                control.check()
                completed = True
                for row in rows[:limit]:
                    try:
                        identity = normalize_url(row.url)
                    except SourceError:
                        identity = row.url
                    if identity in seen:
                        notices.append("A repeated search URL was omitted from this discovery response.")
                        continue
                    seen.add(identity)
                    allowed = request.policy.permits(row.url)
                    results.append(row.model_copy(update={"query": query, "policy_decision": "allowed" if allowed else "denied"}))
            except (ResearchCancelled, ResearchLimit):
                raise
            except SourceError as exc:
                errors = True
                notices.append(str(exc))
        seen.clear()
        for url in request.urls:
            control.check()
            try:
                identity = normalize_url(url)
            except SourceError:
                identity = url
            if identity in seen:
                notices.append("A repeated fetch URL was omitted; no duplicate network request was made.")
                continue
            seen.add(identity)
            if not request.policy.permits(url):
                result = FetchResult(url=url, status="denied", message="The source is outside the selected public HTTPS research policy.", retrieved_at=datetime.now(timezone.utc))
            else:
                result = fetcher.fetch(url, request.policy)
            fetches.append(result.model_copy(update={"content": b""}))
            # A cancellation after receiving bytes still prevents importing
            # them or beginning another fetch. Earlier complete work remains.
            control.check()
            if result.status == "fetched":
                extracted = extract_source(result.content, result.media_type)
                control.check()
                with CourseStore.author_project_lock(project.course_root, project.state_root / "transactions", check_wait=control.check):
                    control.check()
                    record = save_source_snapshot(project, origin=identity, content=result.content, extraction=extracted,
                        title=result.final_url or identity, policy_decision="allowed", media_type=result.media_type,
                        retrieved_at=result.retrieved_at, final_url=result.final_url)
                source_ids.append(record.source_id)
                result = result.model_copy(update={"source": SourceRevision.model_validate(record.model_dump(include={"source_id", "revision", "raw_sha256", "text_sha256", "extractor_version"})),
                    "status": "fetched" if extracted.status == "text" else extracted.status, "message": extracted.message})
            fetches[-1] = result.model_copy(update={"content": b""})
            errors = errors or result.status != "fetched"
            completed = completed or result.status == "fetched"
            if result.status == "cancelled":
                raise ResearchCancelled("Research was cancelled; subsequent work stopped.")
        control.check()
    except ResearchCancelled as exc:
        status = "cancelled"
        notices.append(str(exc))
    except ResearchLimit as exc:
        status = "limit_exceeded"
        notices.append(str(exc))
    except ProjectError as exc:
        errors = True
        notices.append(str(exc))
    except Exception:
        errors = True
        notices.append("Research could not finish; no retry or model replacement evidence was generated.")
    if status == "complete" and errors:
        status = "partial" if completed else "unavailable"
    report = ResearchReport(report_id="research-" + uuid4().hex, started_at=started, finished_at=datetime.now(timezone.utc),
        request=request, status=status, results=tuple(results), fetches=tuple(fetches), source_ids=tuple(source_ids), notices=tuple(notices[:32]))
    # Reports are immutable, uniquely named objects without a mutable index.
    # Publishing a terminal failure must not wait on an unrelated course edit.
    # The API admits only one active research run per Author home.
    if len(_report_names(project)) >= 500:
        raise SourceError("Research report limit reached; completed source snapshots remain in the private registry.")
    # Brave permits transient operation, not a durable search-result archive.
    # Keep the author's request and our outcome; return discovery only in memory.
    atomic_json(project.state_root / "research" / (report.report_id + ".json"), report.model_dump(mode="json", exclude={"results": True, "fetches": {"__all__": {"content"}}}))
    return report
