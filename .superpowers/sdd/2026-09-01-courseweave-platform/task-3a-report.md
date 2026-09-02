# Task 3A report: provider adapters and redacted doctor

## Implementation summary

- Added an explicit `ProviderConfig` that reads only a supplied environment-like
  mapping and reports missing provider/model/credential values without reading
  course files or exposing key values in its representation.
- Added lazy OpenAI Chat Completions and Anthropic Messages construction through
  Pydantic AI 2.37.0 provider/model constructors. `create_model` returns a
  structured `not_configured` result for incomplete configuration.
- Added `ProviderAdapter` text and streaming calls. It maps authentication,
  timeout, malformed-response, unsupported-capability, and generic request
  failures to typed, fixed redacted messages.
- Added `courseweave doctor --course-root PATH`, which validates the root and
  prints only provider, model, base-URL `SET`/`MISSING`, and credential
  `SET`/`MISSING`.
- Added a global pytest guard for both `httpx` and `httpx2` that makes direct
  traffic to `api.openai.com` or `api.anthropic.com` fail immediately.

## Files changed

- `src/courseweave/providers.py`
- `src/courseweave/cli.py`
- `tests/conftest.py`
- `tests/test_providers.py`

## RED evidence

Initial smallest provider/configuration RED command:

```text
$ uv run pytest tests/test_providers.py -q
ERROR tests/test_providers.py
ModuleNotFoundError: No module named 'courseweave.providers'
1 error in 0.67s
```

The first adapter implementation then exposed real integration defects in the
loopback canaries:

```text
$ uv run pytest tests/test_providers.py -q
4 failed, 8 passed in 10.02s
```

The failures showed that the Anthropic client appends `/v1/messages` to its
base URL and that timeout exceptions are wrapped as `ModelAPIError`.

The final unsupported-capability RED command:

```text
$ uv run pytest tests/test_providers.py -q
2 failed, 13 passed in 10.41s
```

Both OpenAI and Anthropic cases returned `request` before the explicit
unsupported-error mapper was added.

## GREEN and canary evidence

```text
$ uv run pytest tests/test_providers.py -q
15 passed in 10.25s

$ git diff --check && uv run pytest -q
143 passed in 14.20s
```

`tests/test_providers.py` starts real `ThreadingHTTPServer` loopback stubs and
uses the Pydantic AI adapters to make Chat Completions and Messages requests.
It verifies the exact local paths, normal and SSE streaming text, 401
authentication responses, delayed timeout responses, malformed bodies,
unsupported responses, configuration absence, CLI redaction, and the hosted
provider traffic guard. No hosted model request is permitted by the test seam.

## Self-review

- Configuration and result representations do not include credential values;
  every provider-facing failure uses a fixed message rather than upstream text.
- Custom base URLs remain explicit and are passed to the matching provider;
  the two SDKs' distinct base-URL conventions are covered by local canaries.
- The CLI reads provider state only for diagnostic output and does not print or
  persist a credential.
- `git diff --check` and the complete Python suite passed.

## Concerns

No blocking concerns. Hosted-provider calls were deliberately not canaried:
the global test guard makes such a call fail, and loopback protocol stubs cover
the adapter boundary without credentials or external network dependence.

## Fix round 1/5: loopback-only provider test transport

The original denylist guarded only asynchronous `httpx`/`httpx2` calls and two
hostnames. It could therefore miss synchronous SDK paths and arbitrary remote
custom base URLs. The test-wide guard now wraps `send` on `Client` and
`AsyncClient` for both libraries, permits only literal loopback IPs or
`localhost`, and preserves Starlette/ASGI in-process test transports. All other
HTTP client traffic fails before its transport is invoked.

The canaries cover OpenAI and Anthropic hosted names through the two async
variants, as well as a non-loopback `custom-provider.invalid` endpoint through
both sync and async variants. They use `MockTransport`, so the RED phase did
not create external traffic.

RED:

```text
$ uv run pytest tests/test_providers.py -q
6 failed, 14 passed in 11.02s
```

The two hosted cases still raised the old denylist message, while all four
remote-custom sync/async cases reached their mock transport rather than being
blocked.

GREEN:

```text
$ uv run pytest tests/test_providers.py -q
20 passed in 10.78s

$ git diff --check && uv run pytest -q
148 passed in 15.11s
```
