"""Bounded research policy/transport tests. Default tests never use live network."""
import pytest
import gzip
import socket
import ssl
import threading
import time

from courseweave.author.contracts import OriginRule, ResearchPolicy


def policy():
    return ResearchPolicy(mode="allow_only", allow=(OriginRule(origin="https://docs.example.org", path_prefix="/course"),),
        deny=(OriginRule(origin="https://docs.example.org", path_prefix="/course/answers"),))


@pytest.mark.parametrize("url,allowed", [
    ("https://docs.example.org/course/intro", True),
    ("https://DOCS.EXAMPLE.ORG:443/course", True),
    ("https://docs.example.org/coursework/private", False),
    ("https://docs.example.org/course/answers", False),
    ("https://docs.example.org/course/answers/key", False),
    ("https://docs.example.org/course/intro/../answers", False),
    ("https://docs.example.org/course/%61nswers", False),
    ("https://docs.example.org/course/%2e%2e/private", False),
    ("https://docs.example.org/course/%252e%252e/private", False),
    ("https://docs.example.org.evil.example/course", False),
    ("http://docs.example.org/course/intro", False),
    ("https://user:password@docs.example.org/course", False),
    ("https://docs.example.org:444/course", False),
    ("https://docs.example.org/course\\answers", False),
    ("https://docs.example.org/course/%5canswers", False),
    ("https://docs.example.org/course/\nintro", False),
])
def test_exact_origin_normalized_path_and_deny_precedence(url, allowed):
    assert policy().permits(url) is allowed


@pytest.mark.parametrize("url", ["file:///private", "https://localhost/", "https://host.local/", "https://127.0.0.1/",
    "https://169.254.169.254/", "https://10.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/",
    "https://224.0.0.1/", "https://0.0.0.0/", "https://2130706433/", "https://0177.0.0.1/",
    "https://[2001:db8::1]/", "https://example.org/%zz"])
def test_public_web_never_permits_local_reserved_or_ambiguous_destinations(url):
    assert not ResearchPolicy(mode="public_web").permits(url)


def test_normalized_url_is_the_exact_url_used_for_policy_and_transport():
    from courseweave.author.sources import normalize_url
    assert normalize_url("https://DOCS.EXAMPLE.ORG.:443/course/a/../intro#part") == "https://docs.example.org/course/intro"
    assert normalize_url("https://docs.example.org/course/%69ntro?q=a%20b") == "https://docs.example.org/course/intro?q=a%20b"


def test_ipv6_origin_alias_cannot_escape_an_explicit_deny():
    rule = OriginRule(origin="https://[2606:4700:4700::1111]")
    selected = ResearchPolicy(mode="public_web", deny=(rule,))
    assert not selected.permits("https://[2606:4700:4700:0:0:0:0:1111]/")


@pytest.mark.parametrize("address", ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.0.2.1", "224.0.0.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "2001:db8::1"])
def test_resolved_addresses_require_public_unicast(address):
    from courseweave.author.sources import public_address
    assert not public_address(address)


def test_public_ipv4_and_ipv6_addresses_are_supported_without_lookup():
    from courseweave.author.sources import public_address
    assert public_address("8.8.8.8") and public_address("2606:4700:4700::1111")


class FakeSocket:
    def __init__(self):
        self.address = None
        self.closed = threading.Event()
    def settimeout(self, timeout):
        assert timeout > 0
    def connect(self, address):
        self.address = address
    def getpeername(self):
        return self.address
    def shutdown(self, _how):
        self.closed.set()
    def close(self):
        self.closed.set()


class FakeTLS:
    check_hostname = True
    verify_mode = ssl.CERT_REQUIRED
    def __init__(self):
        self.hostname = None
    def wrap_socket(self, sock, *, server_hostname):
        self.hostname = server_hostname
        return sock


class FakeResponse:
    status = 200
    def __init__(self, content=b"A public source.", headers=None):
        self.content = content
        self.headers = {"content-type": "text/plain", **(headers or {})}
    def getheaders(self):
        return list(self.headers.items())
    def read1(self, amount):
        result, self.content = self.content[:amount], self.content[amount:]
        return result


class FakeConnection:
    def __init__(self, response, slow_headers=False):
        self.response, self.slow_headers = response, slow_headers
        self.requested = None
        self.sock = None
    def request(self, method, path, *, headers):
        self.requested = (method, path, headers)
    def getresponse(self):
        if self.slow_headers:
            assert self.sock.closed.wait(1), "Absolute deadline did not close the socket"
            raise OSError("closed")
        return self.response
    def close(self):
        if self.sock:
            self.sock.close()


def transport(response=None, *, addresses=("8.8.8.8",), resolver=None, slow_headers=False):
    from courseweave.author.sources import PublicHttpsTransport
    raw, tls = FakeSocket(), FakeTLS()
    connection = FakeConnection(response or FakeResponse(), slow_headers)
    calls = []
    def resolve(*args, **kwargs):
        calls.append(args)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443)) for ip in addresses]
    client = PublicHttpsTransport(resolver=resolver or resolve, socket_factory=lambda *args: raw,
        tls_context=tls, connection_factory=lambda *args, **kwargs: connection)
    return client, raw, tls, connection, calls


def test_connection_pins_the_validated_address_and_preserves_tls_hostname(monkeypatch):
    from courseweave.author.sources import ResearchControl
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:12345")
    client, raw, tls, connection, calls = transport()
    response = client.get("https://DOCS.EXAMPLE.ORG/course/a/../intro#part", ResearchControl.seconds(10))
    assert raw.address == ("8.8.8.8", 443)
    assert tls.hostname == "docs.example.org" and len(calls) == 1
    assert connection.requested[:2] == ("GET", "/course/intro")
    assert connection.requested[2]["Host"] == "docs.example.org"
    assert "Authorization" not in connection.requested[2] and "Cookie" not in connection.requested[2]
    assert raw.closed.is_set() and response.content == b"A public source."


@pytest.mark.parametrize("addresses", [("127.0.0.1",), ("8.8.8.8", "10.0.0.1"), ("169.254.169.254",)])
def test_every_resolved_address_must_be_public_before_any_connection(addresses):
    from courseweave.author.sources import ResearchControl, SourceError
    client, raw, _, _, _ = transport(addresses=addresses)
    with pytest.raises(SourceError, match="public"):
        client.get("https://docs.example.org/", ResearchControl.seconds(10))
    assert raw.address is None


def test_dns_rebinding_cannot_trigger_a_second_hostname_resolution():
    from courseweave.author.sources import ResearchControl
    queries = []
    def resolver(*args, **kwargs):
        queries.append(args)
        ip = "8.8.8.8" if len(queries) == 1 else "127.0.0.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443))]
    client, raw, _, _, _ = transport(resolver=resolver)
    client.get("https://docs.example.org/", ResearchControl.seconds(10))
    assert len(queries) == 1 and raw.address[0] == "8.8.8.8"


def test_cancelled_request_never_resolves_or_connects():
    from courseweave.author.sources import ResearchControl, ResearchCancelled
    control = ResearchControl.seconds(10)
    control.cancel.set()
    client, raw, _, _, calls = transport()
    with pytest.raises(ResearchCancelled):
        client.get("https://docs.example.org/", control)
    assert not calls and raw.address is None


def test_slow_dns_and_headers_respect_absolute_deadlines():
    from courseweave.author.sources import ResearchControl, ResearchLimit
    release = threading.Event()
    def resolver(*args, **kwargs):
        release.wait(1)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443))]
    try:
        client, raw, _, _, _ = transport(resolver=resolver)
        with pytest.raises(ResearchLimit):
            client.get("https://docs.example.org/", ResearchControl.seconds(0.03))
        assert raw.address is None
    finally:
        release.set()
    client, raw, _, _, _ = transport(slow_headers=True)
    with pytest.raises(ResearchLimit):
        client.get("https://docs.example.org/", ResearchControl.seconds(0.03))
    assert raw.closed.is_set()


@pytest.mark.parametrize("compressed", [False, True])
def test_response_limit_applies_to_decompressed_bytes(compressed):
    from courseweave.author.sources import ResearchControl, ResearchLimit
    content = b"a" * (2 * 1024 * 1024 + 1)
    response = FakeResponse(gzip.compress(content) if compressed else content,
        {"content-encoding": "gzip"} if compressed else {})
    client, raw, _, _, _ = transport(response)
    with pytest.raises(ResearchLimit):
        client.get("https://docs.example.org/", ResearchControl.seconds(10))
    assert raw.closed.is_set()


def test_valid_gzip_and_incomplete_stream_have_distinct_outcomes():
    from courseweave.author.sources import ResearchControl, SourceError
    raw = gzip.compress(b"Exact extracted bytes")
    client, *_ = transport(FakeResponse(raw, {"content-encoding": "gzip"}))
    assert client.get("https://docs.example.org/", ResearchControl.seconds(10)).content == b"Exact extracted bytes"
    client, *_ = transport(FakeResponse(raw[:-4], {"content-encoding": "gzip"}))
    with pytest.raises(SourceError, match="incomplete"):
        client.get("https://docs.example.org/", ResearchControl.seconds(10))


class ScriptedTransport:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []
    def get(self, url, control, **kwargs):
        control.check()
        self.calls.append((url, kwargs))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


def test_policy_is_checked_before_initial_fetch_and_each_redirect():
    from courseweave.author.sources import PublicFetcher, HttpResult
    transport = ScriptedTransport([HttpResult(302, {"location": "/course/answers"}, b"")])
    fetcher = PublicFetcher(transport=transport)
    denied = fetcher.fetch("https://other.example.org/course", policy())
    assert denied.status == "denied" and not transport.calls
    redirect = fetcher.fetch("https://docs.example.org/course/intro", policy())
    assert redirect.status == "denied" and len(transport.calls) == 1
    assert redirect.redirects == ("https://docs.example.org/course/answers",)


def test_redirect_limit_and_unavailable_source_never_retry():
    from courseweave.author.sources import PublicFetcher, HttpResult
    transport = ScriptedTransport([HttpResult(302, {"location": f"/course/{i}"}, b"") for i in range(4)])
    result = PublicFetcher(transport=transport).fetch("https://docs.example.org/course", policy())
    assert result.status == "limit_exceeded" and len(transport.calls) == 4 and len(result.redirects) == 3
    transport = ScriptedTransport([HttpResult(403, {}, b"Do not retain this server error page")])
    result = PublicFetcher(transport=transport).fetch("https://docs.example.org/course", policy())
    assert result.status == "unavailable" and result.content == b"" and len(transport.calls) == 1


def test_success_preserves_final_url_and_unsupported_media_is_explicit():
    from courseweave.author.sources import PublicFetcher, HttpResult
    transport = ScriptedTransport([HttpResult(302, {"location": "./intro#example"}, b""),
        HttpResult(200, {"content-type": "text/plain; charset=utf-8"}, b"Public text")])
    result = PublicFetcher(transport=transport).fetch("https://docs.example.org/course/", policy())
    assert result.status == "fetched" and result.final_url == "https://docs.example.org/course/intro"
    assert result.content == b"Public text" and result.retrieved_at.tzinfo is not None
    assert result.media_type == "text/plain; charset=utf-8"
    transport = ScriptedTransport([HttpResult(200, {"content-type": "application/pdf"}, b"PDF")])
    assert PublicFetcher(transport=transport).fetch("https://docs.example.org/course/", policy()).status == "unsupported"


def test_brave_adapter_is_optional_and_uses_only_its_separate_credential():
    import json
    from courseweave.author.sources import BraveSearch, HttpResult, SourceError
    transport = ScriptedTransport([HttpResult(200, {"content-type": "application/json"}, json.dumps({"web": {"results": [
        {"title": "Python docs", "url": "https://docs.example.org/course", "description": "Discovery snippet", "age": "2 days ago"}]}}).encode())])
    with pytest.raises(SourceError, match="not configured"):
        BraveSearch(None, transport=transport).search("Python validation", 5)
    assert not transport.calls
    search = BraveSearch("synthetic-search-credential", transport=transport)
    result = search.search("Python validation", 5)
    assert len(result) == 1 and result[0].query == "Python validation" and result[0].publication_date is None
    url, options = transport.calls[0]
    assert url.startswith("https://api.search.brave.com/res/v1/web/search?") and "count=5" in url
    assert "spellcheck=false" in url and "text_decorations=false" in url and "result_filter=web" in url
    assert options["headers"] == {"X-Subscription-Token": "synthetic-search-credential", "Accept": "application/json"}
    assert "synthetic-search-credential" not in url and "synthetic-search-credential" not in repr(search)


def test_brave_connector_query_bounds_are_visible_without_transport_or_truncation():
    from courseweave.author.sources import BraveSearch, SourceError
    transport = ScriptedTransport([])
    for query in ("x" * 601, "word " * 76):
        with pytest.raises(SourceError, match="600 characters and 75 words"):
            BraveSearch("synthetic", transport=transport).search(query, 10)
    assert not transport.calls


def test_brave_does_not_follow_redirects_or_include_raw_error_bodies():
    from courseweave.author.sources import BraveSearch, HttpResult, SourceError
    transport = ScriptedTransport([HttpResult(302, {"location": "https://other.example.org/"}, b"private error")])
    with pytest.raises(SourceError) as error:
        BraveSearch("synthetic", transport=transport).search("Python", 1)
    assert "private error" not in str(error.value) and len(transport.calls) == 1


def test_brave_empty_results_are_an_observed_empty_search():
    from courseweave.author.sources import BraveSearch, HttpResult
    client = ScriptedTransport([HttpResult(200, {}, b'{"query":{"original":"nothing"},"web":null}')])
    assert BraveSearch("synthetic", transport=client).search("nothing", 10) == ()


def test_html_extraction_has_stable_offsets_without_executable_or_hidden_content():
    from courseweave.author.sources import extract_source
    raw = b'''<html><head><title>Public example</title><style>hidden CSS</style></head>
      <body><h1>Numbers &amp; checks</h1><p>Check <b>every</b> row.</p>
      <script>raise secret()</script><div hidden>Hidden answer</div>
      <div aria-hidden="true">Also hidden</div><form><p>Form value</p></form>
      <pre>if value:\n    check(value)</pre><img alt="Two rows"></body></html>'''
    result = extract_source(raw, "text/html; charset=utf-8")
    assert result.status == "text" and result.title == "Public example"
    assert result.text == "Numbers & checks\nCheck every row.\nif value:\n    check(value)\nTwo rows\n"
    assert result.text[17:33] == "Check every row."
    assert result.version and extract_source(raw, "text/html").text == result.text
    assert all(value not in result.text for value in ("secret", "Hidden", "CSS", "Form value"))


@pytest.mark.parametrize("raw,status,notice", [
    (b'<title>Sign in</title><form><input type="password"></form>', "unavailable", "login"),
    (b'<div id="app"></div><script src="app.js"></script>', "unsupported", "JavaScript"),
    (b'<title>Just a moment...</title><p>Verify you are human</p>', "unavailable", "challenge"),
    (b'', "unavailable", "empty"),
])
def test_inaccessible_html_is_explicit_without_claimed_extraction(raw, status, notice):
    from courseweave.author.sources import extract_source
    result = extract_source(raw, "text/html")
    assert result.status == status and not result.text and notice.lower() in result.message.lower()


def test_text_decoding_preserves_offsets_and_rejects_binary_or_unknown_charset():
    from courseweave.author.sources import extract_source
    result = extract_source("# Café\r\n\r\nCheck x.\n".encode(), "text/markdown")
    assert result.text == "# Café\n\nCheck x.\n" and result.status == "text"
    assert extract_source(b"caf\xe9", "text/plain; charset=iso-8859-1").text == "café"
    assert extract_source(b"\x00secret", "text/plain").status == "unsupported"
    assert extract_source(b"PDF contents", "application/pdf").status == "unsupported"
    assert extract_source(b"unknown", "text/plain; charset=unicode_escape").status == "unsupported"


def test_extraction_is_bounded_for_input_and_nested_html():
    from courseweave.author.sources import extract_source
    assert extract_source(b"x" * (2 * 1024 * 1024 + 1), "text/plain").status == "unsupported"
    assert extract_source(b"<div>" * 1000 + b"text" + b"</div>" * 1000, "text/html").status == "unsupported"


def research_request(**kwargs):
    from courseweave.author.contracts import ResearchRequest
    return ResearchRequest(network_enabled=True, policy=policy(), **kwargs)


class SearchFixture:
    def __init__(self, count=10, error=None):
        self.calls, self.count, self.error = [], count, error
    def search(self, query, limit):
        from courseweave.author.contracts import SearchResult
        from datetime import datetime, timezone
        self.calls.append((query, limit))
        if self.error:
            raise self.error
        return tuple(SearchResult(url=f"https://docs.example.org/course/{query}/{n}", title=f"Result {n}",
            snippet="Discovery only", query=query, retrieved_at=datetime.now(timezone.utc)) for n in range(min(limit, self.count)))


class FetchFixture:
    def __init__(self, content=b"Public supporting text.", control=None):
        self.calls, self.content, self.control = [], content, control
    def fetch(self, url, policy):
        from courseweave.author.contracts import FetchResult
        from datetime import datetime, timezone
        self.calls.append(url)
        if self.control:
            self.control.cancel.set()
        return FetchResult(url=url, final_url=url, status="fetched", message="Fixture fetch", content=self.content,
            media_type="text/plain", retrieved_at=datetime.now(timezone.utc))


def private_project(tmp_path):
    from courseweave.author.project import create_project
    return create_project(None, tmp_path / "project", ())


def test_run_requires_explicit_network_enablement_and_policy_before_transport(tmp_path):
    from courseweave.author.sources import run_research, SourceError
    project, search, fetch = private_project(tmp_path), SearchFixture(), FetchFixture()
    with pytest.raises(SourceError, match="explicit"):
        run_research(project, {"network_enabled": False, "policy": {"mode": "public_web"}, "queries": ["q"]}, search=search, fetcher=fetch)
    report = run_research(project, research_request(urls=("https://denied.example.org/",)), search=search, fetcher=fetch)
    assert not search.calls and not fetch.calls and report.fetches[0].status == "denied"


def test_search_has_ten_total_results_and_does_not_automatically_fetch(tmp_path):
    from courseweave.author.sources import run_research
    search, fetch = SearchFixture(), FetchFixture()
    report = run_research(private_project(tmp_path), research_request(queries=("first", "second")), search=search, fetcher=fetch)
    assert report.status == "complete" and len(report.results) == 10
    assert [q for q, _ in search.calls] == ["first", "second"] and sum(limit for _, limit in search.calls) == 10
    assert not fetch.calls and not report.source_ids
    assert all(r.publication_date is None and r.policy_decision == "allowed" for r in report.results)


def test_optional_discovery_failure_does_not_replace_evidence_or_block_explicit_urls(tmp_path):
    from courseweave.author.sources import run_research, BraveSearch
    project, fetch = private_project(tmp_path), FetchFixture()
    report = run_research(project, research_request(queries=("query",), urls=("https://docs.example.org/course",)),
        search=BraveSearch(None, transport=ScriptedTransport([])), fetcher=fetch)
    assert report.status == "partial" and len(report.source_ids) == 1 and not report.results
    assert any("not configured" in notice for notice in report.notices)


def test_fetched_source_is_private_with_provenance_and_raw_and_text_hashes(tmp_path):
    from hashlib import sha256
    from courseweave.author.sources import run_research, read_research_report
    from courseweave.author.project import read_sources
    project = private_project(tmp_path)
    report = run_research(project, research_request(urls=("https://docs.example.org/course",)), fetcher=FetchFixture())
    record, = read_sources(project)
    assert record.source_id in report.source_ids and record.status == "candidate" and record.redistribution == "undecided"
    assert record.intended_use == "author_reference" and record.publication_date is None
    assert record.origin == record.final_url == "https://docs.example.org/course" and record.retrieved_at
    assert record.raw_sha256 == record.text_sha256 == sha256(b"Public supporting text.").hexdigest()
    assert (project.state_root / record.snapshot_path).read_bytes() == b"Public supporting text."
    assert not list(project.course_root.iterdir())
    restored = read_research_report(project, report.report_id)
    assert restored == report and not restored.fetches[0].content
    assert not report.fetches[0].content


def test_cancel_and_elapsed_limit_stop_subsequent_work_without_importing_incomplete_fetch(tmp_path):
    from courseweave.author.sources import run_research, ResearchControl
    from courseweave.author.project import read_sources
    project, control = private_project(tmp_path), ResearchControl.seconds(60)
    fetch = FetchFixture(control=control)
    request = research_request(urls=("https://docs.example.org/course/one", "https://docs.example.org/course/two"))
    report = run_research(project, request, fetcher=fetch, control=control)
    assert report.status == "cancelled" and len(fetch.calls) == 1 and not read_sources(project)
    expired = ResearchControl(deadline=0)
    report = run_research(project, request, fetcher=fetch, control=expired)
    assert report.status == "limit_exceeded" and len(fetch.calls) == 1


def test_refetch_preserves_unchanged_decisions_but_new_bytes_revoke_source_revision(tmp_path):
    from courseweave.author.sources import run_research
    from courseweave.author.project import read_sources, update_source
    from courseweave.store import CourseStore
    from contextlib import contextmanager
    project = private_project(tmp_path)
    class Lock:
        @contextmanager
        def author_lock(self):
            with CourseStore.author_project_lock(project.course_root, project.state_root / "transactions"):
                yield
    request = research_request(urls=("https://docs.example.org/course",))
    first = run_research(project, request, fetcher=FetchFixture())
    record, = read_sources(project)
    approved = update_source(project, Lock(), record.source_id, record.revision, {"status": "approved"})
    again = run_research(project, request, fetcher=FetchFixture())
    assert first.source_ids == again.source_ids and read_sources(project) == (approved,)
    changed = run_research(project, request, fetcher=FetchFixture(b"Changed content"))
    latest, = read_sources(project)
    assert changed.source_ids == first.source_ids and latest.revision > approved.revision and latest.status == "candidate"
    assert latest.redistribution == "undecided" and (project.state_root / record.snapshot_path).read_bytes() == b"Public supporting text."
    separate = run_research(project, research_request(urls=("https://docs.example.org/course/other",)), fetcher=FetchFixture(b"Changed content"))
    assert separate.source_ids != changed.source_ids and len(read_sources(project)) == 2


def test_local_html_reference_import_and_bounded_verified_excerpt_need_no_network(tmp_path):
    from courseweave.author.sources import import_reference, source_excerpt, SourceError
    project = private_project(tmp_path)
    original = tmp_path / "reference.html"
    original.write_bytes(b"<title>Reference</title><p>Inspect each row.</p>")
    before = original.read_bytes()
    record = import_reference(project, original)
    assert record.intended_use == "author_reference" and record.extraction == "text" and record.title == "Reference"
    assert record.status == "candidate" and record.redistribution == "undecided" and record.policy_decision == "local"
    assert original.read_bytes() == before and not list(project.course_root.iterdir())
    excerpt = source_excerpt(project, record.source_id, revision=record.revision, start=8, limit=5)
    assert excerpt["text"] == "each " and excerpt["start"] == 8 and excerpt["end"] == 13
    assert excerpt["total_characters"] == len("Inspect each row.\n")
    (project.state_root / record.snapshot_path).write_bytes(b"Changed saved source")
    with pytest.raises(SourceError, match="corrupt|changed"):
        source_excerpt(project, record.source_id, revision=record.revision)


def test_unsupported_local_attachment_is_metadata_and_reviewed_extract_has_separate_origin(tmp_path):
    from courseweave.author.sources import import_reference, source_excerpt
    project = private_project(tmp_path)
    path = tmp_path / "reference.pdf"
    path.write_bytes(b"%PDF-1.7 synthetic attachment")
    record = import_reference(project, path)
    assert record.extraction == "unsupported" and record.text_path is None
    assert source_excerpt(project, record.source_id, revision=0)["text"] == ""
    path = tmp_path / "reviewed-extract.md"
    path.write_text("Author-transcribed extract from reference.pdf, page 1.\n")
    extract = import_reference(project, path)
    assert extract.source_id != record.source_id and extract.extraction == "text"
    assert extract.origin.endswith("reviewed-extract.md")


def test_source_excerpt_is_revision_checked_and_private_imports_are_rejected(tmp_path):
    from courseweave.author.sources import import_reference, source_excerpt, SourceError
    from courseweave.author.project import ProjectError
    project = private_project(tmp_path)
    path = tmp_path / "reference.md"
    path.write_text("Reviewed source")
    record = import_reference(project, path)
    with pytest.raises(SourceError, match="revision|changed"):
        source_excerpt(project, record.source_id, revision=1)
    for start, limit in ((-1, 5), (0, 8001), (0, 0)):
        with pytest.raises(SourceError):
            source_excerpt(project, record.source_id, revision=0, start=start, limit=limit)
    private = tmp_path / ".env"
    private.write_text("Synthetic private input")
    with pytest.raises(ProjectError):
        import_reference(project, private)


def test_report_listing_is_bounded_and_saved_failures_survive_reopening(tmp_path):
    from courseweave.author.sources import run_research, list_research_reports, read_research_report
    project = private_project(tmp_path)
    reports = [run_research(project, research_request(urls=("https://denied.example.org/",)), fetcher=FetchFixture()) for _ in range(3)]
    assert list_research_reports(project, offset=1, limit=1) == (reports[1],)
    assert read_research_report(project, reports[0].report_id).fetches[0].status == "denied"


def test_research_deadline_also_bounds_waiting_for_a_busy_course_lock(tmp_path):
    from courseweave.author.sources import run_research, ResearchControl
    from courseweave.author.project import read_sources
    from courseweave.store import CourseStore
    project = private_project(tmp_path)
    finished = []
    with CourseStore.author_project_lock(project.course_root, project.state_root / "transactions"):
        control = ResearchControl.seconds(0.08)
        worker = threading.Thread(target=lambda: finished.append(run_research(project,
            research_request(urls=("https://docs.example.org/course",)), search=SearchFixture(), fetcher=FetchFixture(), control=control)))
        worker.start()
        worker.join(0.8)
        bounded = not worker.is_alive()
    worker.join(2)
    assert bounded, "A research run outlived its deadline while waiting for the course lock"
    assert finished[0].status == "limit_exceeded" and not read_sources(project)
