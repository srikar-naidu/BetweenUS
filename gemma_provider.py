"""Minimal structured-output provider for a local Gemma model served by Ollama."""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class GemmaProviderError(RuntimeError):
    """Raised when Ollama cannot return a valid structured response."""


@dataclass(frozen=True)
class OllamaConfig:
    base_url: str = "http://localhost:11434"
    model: str = "gemma4:e2b-it-q4_K_M"
    timeout_seconds: float = 120.0

    @classmethod
    def from_env(cls) -> OllamaConfig:
        """Read the Ollama endpoint and Gemma model from environment variables."""
        host = os.getenv("OLLAMA_HOST", "localhost:11434").rstrip("/")
        if not host.startswith(("http://", "https://")):
            host = f"http://{host}"
        return cls(
            base_url=host,
            model=os.getenv("GEMMA_MODEL", "gemma4:e2b-it-q4_K_M"),
        )


class OllamaGemmaProvider:
    """Calls Ollama's non-streaming chat API and returns parsed JSON objects."""

    def __init__(self, config: OllamaConfig | None = None) -> None:
        self.config = config or OllamaConfig.from_env()

    def generate_structured(
        self,
        *,
        task: str,
        context_packet: Mapping[str, Any],
        response_schema: Mapping[str, Any],
        images: Sequence[bytes] = (),
    ) -> dict[str, Any]:
        """Run one focused task against a compact packet and JSON Schema."""
        if not task.strip():
            raise ValueError("task must not be empty")

        system_prompt = (
            "You are the Between Us memory reasoning engine. Use only the supplied "
            "evidence. Never invent people, events, places, or relationships. "
            "Distinguish observations from interpretations, preserve uncertainty, "
            "and cite supplied fragment IDs. Return only data matching the JSON schema."
        )
        user_message: dict[str, Any] = {
            "role": "user",
            "content": json.dumps(
                {"task": task, "context_packet": context_packet},
                ensure_ascii=True,
            ),
        }
        if images:
            user_message["images"] = [
                base64.b64encode(image).decode("ascii") for image in images
            ]

        payload = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                user_message,
            ],
            "format": dict(response_schema),
            "options": {"temperature": 0},
            "stream": False,
        }
        request = Request(
            f"{self.config.base_url.rstrip('/')}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urlopen(request, timeout=self.config.timeout_seconds) as response:
                response_body = json.load(response)
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise GemmaProviderError(
                f"Ollama returned HTTP {error.code}: {detail}"
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            raise GemmaProviderError(f"Could not reach Ollama: {error}") from error
        except json.JSONDecodeError as error:
            raise GemmaProviderError("Ollama returned invalid JSON") from error

        try:
            content = response_body["message"]["content"]
            result = json.loads(content)
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise GemmaProviderError(
                "Ollama response did not contain valid JSON message content"
            ) from error

        if not isinstance(result, dict):
            raise GemmaProviderError("Ollama response must be a JSON object")
        return result