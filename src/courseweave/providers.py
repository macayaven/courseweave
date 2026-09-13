"""Explicit, provider-neutral model configuration.

Credentials are supplied only by the caller's environment mapping.  This
module never reads or writes course files and deliberately exposes only
redacted outcomes for provider requests.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Literal, Mapping

import httpx2
from pydantic_ai import Agent, ModelHTTPError
from pydantic_ai.usage import UsageLimits
from pydantic_ai.messages import ModelResponse
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.openai import OpenAIProvider

ProviderName = Literal["openai", "anthropic"]
ProviderResultStatus = Literal["configured", "not_configured"]
ProviderCallStatus = Literal["ok", "provider_error"]
ProviderFailureKind = Literal[
    "authentication", "timeout", "malformed_response", "unsupported", "request",
    "rate_limited", "refusal", "truncated", "cancelled", "input_limit"
]


@dataclass(frozen=True)
class ProviderCapabilities:
    version: str = "capabilities-v1"
    text: bool = True
    streaming: bool = True
    tools: bool = True
    structured_output: Literal["none", "tool", "native"] = "tool"


PROFILES = {
    "stream-tools-v1": ProviderCapabilities(),
    "text-only-v1": ProviderCapabilities(streaming=False, tools=False, structured_output="none"),
    "tools-v1": ProviderCapabilities(streaming=False),
}


class ProviderCompletionError(ValueError):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(kind)


def validate_completion(response) -> None:
    reason = getattr(response, "finish_reason", None)
    if reason in {"length", "max_tokens"}:
        raise ProviderCompletionError("truncated")
    if reason in {"content_filter", "refusal"}:
        raise ProviderCompletionError("refusal")


@dataclass(frozen=True)
class ProviderConfig:
    """Configuration read from an explicit environment-like mapping."""

    provider: str | None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = field(default=None, repr=False)
    timeout_seconds: float | None = None
    profile: str = "stream-tools-v1"
    max_input_chars: int = 65536
    max_output_tokens: int = 4096
    run_timeout_seconds: float = 90.0

    def __post_init__(self):
        if self.profile not in PROFILES:
            raise ValueError("Unknown provider capability profile")
        for value in (self.timeout_seconds, self.run_timeout_seconds):
            if value is not None and (not math.isfinite(value) or value <= 0):
                raise ValueError("Provider deadline must be finite and positive")
        if not 1 <= self.max_input_chars <= 262144 or not 1 <= self.max_output_tokens <= 16384:
            raise ValueError("Provider limits are out of bounds")

    @property
    def capabilities(self) -> ProviderCapabilities:
        return PROFILES[self.profile]

    @property
    def fingerprint(self) -> str:
        public = {"provider": self.provider, "model": self.model, "profile": self.profile,
                  "timeout": self.timeout_seconds, "run_timeout": self.run_timeout_seconds,
                  "input": self.max_input_chars, "output": self.max_output_tokens}
        return hashlib.sha256(json.dumps(public, sort_keys=True).encode()).hexdigest()


    @classmethod
    def from_mapping(cls, values: Mapping[str, object]) -> ProviderConfig:
        """Build configuration without reading process environment implicitly."""
        provider = _nonempty(values.get("COURSEWEAVE_PROVIDER"))
        prefix = provider.upper() if provider else ""
        timeout = values.get("COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS")
        if timeout is None:
            timeout = values.get("timeout_seconds")
        try:
            timeout_seconds = float(timeout) if timeout is not None else None
        except (TypeError, ValueError):
            raise ValueError("Invalid provider timeout") from None
        return cls(
            provider=provider,
            model=_nonempty(values.get(f"{prefix}_MODEL")),
            base_url=_nonempty(values.get(f"{prefix}_BASE_URL")),
            api_key=_nonempty(values.get(f"{prefix}_API_KEY")),
            timeout_seconds=timeout_seconds,
            profile=_nonempty(values.get("COURSEWEAVE_PROVIDER_PROFILE")) or "text-only-v1",
            run_timeout_seconds=float(values.get("COURSEWEAVE_PROVIDER_RUN_TIMEOUT_SECONDS", 90)),
            max_input_chars=int(values.get("COURSEWEAVE_PROVIDER_MAX_INPUT_CHARS", 65536)),
            max_output_tokens=int(values.get("COURSEWEAVE_PROVIDER_MAX_OUTPUT_TOKENS", 4096)),
        )

    @classmethod
    def from_environ(cls, values: Mapping[str, object]) -> ProviderConfig:
        """Alias that makes environment call sites self-documenting."""
        return cls.from_mapping(values)

    @property
    def credential_status(self) -> Literal["SET", "MISSING"]:
        return "SET" if self.api_key else "MISSING"

    @property
    def base_url_status(self) -> Literal["SET", "MISSING"]:
        return "SET" if self.base_url else "MISSING"

    @property
    def missing(self) -> tuple[str, ...]:
        if self.provider not in {"openai", "anthropic"}:
            return ("COURSEWEAVE_PROVIDER",)
        prefix = self.provider.upper()
        return tuple(
            name
            for name, value in (
                (f"{prefix}_MODEL", self.model),
                (f"{prefix}_API_KEY", self.api_key),
            )
            if not value
        )


@dataclass(frozen=True)
class ProviderFailure:
    """A provider error safe to show in a learner-facing UI."""

    kind: ProviderFailureKind
    message: str


@dataclass(frozen=True)
class ProviderCallResult:
    status: ProviderCallStatus
    content: str | None = None
    failure: ProviderFailure | None = None


@dataclass(frozen=True)
class ModelResult:
    """The result of lazy provider/model construction."""

    status: ProviderResultStatus
    adapter: ProviderAdapter | None = None
    missing: tuple[str, ...] = ()


@dataclass
class ProviderAdapter:
    """Runs a configured Pydantic AI model and normalizes provider failures."""

    model: OpenAIChatModel | AnthropicModel
    http_client: httpx2.AsyncClient | None = field(default=None, repr=False)
    config: ProviderConfig = field(default_factory=lambda: ProviderConfig(provider=None), repr=False)

    async def aclose(self) -> None:
        """Close the per-run timeout client exactly once when this adapter owns it."""
        if self.http_client is not None:
            client, self.http_client = self.http_client, None
            await client.aclose()

    async def complete(self, prompt: str, *, stream: bool = False) -> ProviderCallResult:
        """Return provider text or a typed, credential-safe failure."""
        try:
            if len(prompt) > self.config.max_input_chars:
                raise ProviderCompletionError('input_limit')
            agent = Agent(self.model, model_settings={'max_tokens': self.config.max_output_tokens}, retries=0)
            async with asyncio.timeout(self.config.run_timeout_seconds):
                if stream and self.config.capabilities.streaming:
                    async with agent.run_stream(prompt, usage_limits=UsageLimits(request_limit=4, tool_calls_limit=2)) as result:
                        chunks = [chunk async for chunk in result.stream_text(delta=True)]
                        await result.get_output()
                        validate_completion(result.response)
                        return ProviderCallResult(status="ok", content="".join(chunks))
                result = await agent.run(prompt, usage_limits=UsageLimits(request_limit=4, tool_calls_limit=2))
                for message in result.new_messages():
                    if isinstance(message, ModelResponse):
                        validate_completion(message)
                return ProviderCallResult(status="ok", content=result.output)
        except Exception as exc:  # Provider SDKs use different concrete error classes.
            return ProviderCallResult(status="provider_error", failure=_failure_for(exc))
        finally:
            await self.aclose()

    def complete_sync(self, prompt: str, *, stream: bool = False) -> ProviderCallResult:
        """Synchronous convenience seam for CLI and integration callers."""
        return asyncio.run(self.complete(prompt, stream=stream))


def create_model(config: ProviderConfig) -> ModelResult:
    """Lazily construct the configured Pydantic AI model or describe what is absent."""
    if config.missing:
        return ModelResult(status="not_configured", missing=config.missing)

    http_client = (
        httpx2.AsyncClient(timeout=config.timeout_seconds)
        if config.timeout_seconds is not None
        else None
    )
    try:
        if config.provider == "openai":
            provider = OpenAIProvider(
                base_url=config.base_url,
                api_key=config.api_key,
                http_client=http_client,
            )
            model = OpenAIChatModel(config.model, provider=provider, profile={"supports_tools": config.capabilities.tools, "supports_json_schema_output": config.capabilities.structured_output == "native", "supports_json_object_output": config.capabilities.structured_output == "native"})
        else:
            provider = AnthropicProvider(
                base_url=config.base_url,
                api_key=config.api_key,
                http_client=http_client,
            )
            model = AnthropicModel(config.model, provider=provider)
    except BaseException:
        if http_client is not None:
            _close_construction_client(http_client)
        raise
    return ModelResult(status="configured", adapter=ProviderAdapter(model, http_client, config))


def _close_construction_client(client: httpx2.AsyncClient) -> None:
    """Close a just-created client in either sync or async factory callers."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(client.aclose())
    else:
        loop.create_task(client.aclose())


def _nonempty(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _failure_for(exc: Exception) -> ProviderFailure:
    """Classify only stable, safe error properties; never reflect upstream text."""
    if isinstance(exc, ProviderCompletionError):
        return ProviderFailure(exc.kind, {"refusal": "The provider declined this request.", "truncated": "The provider response was incomplete.", "input_limit": "This request and its required teaching context exceed the input limit."}.get(exc.kind, "The provider returned a malformed response."))
    if isinstance(exc, ModelHTTPError) and exc.status_code == 429:
        return ProviderFailure("rate_limited", "The provider is rate limited; try again later.")
    if isinstance(exc, ModelHTTPError) and exc.status_code in {401, 403}:
        return ProviderFailure("authentication", "The provider rejected the configured credential.")
    if (
        isinstance(exc, (TimeoutError, httpx2.TimeoutException))
        or "timeout" in type(exc).__name__.lower()
        or "timeout" in str(exc).lower()
        or "timed out" in str(exc).lower()
    ):
        return ProviderFailure("timeout", "The provider request timed out.")
    name = type(exc).__name__.lower()
    if "json" in name or "validation" in name or "decode" in name or "unexpectedmodelbehavior" in name:
        return ProviderFailure("malformed_response", "The provider returned a malformed response.")
    if "unsupported" in str(exc).lower() or "tool" in str(exc).lower():
        return ProviderFailure("unsupported", "The provider does not support this request.")
    return ProviderFailure("request", "The provider request failed.")
