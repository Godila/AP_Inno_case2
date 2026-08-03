import base64
import json

import httpx
import pytest

from app.asr import AsrError, CailaAsrClient


def build(handler, api_key="test-key"):
    return CailaAsrClient(
        api_key=api_key,
        url="https://caila.test/predict",
        timeout=5,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_sends_base64_audio_with_api_key():
    seen = {}

    def handler(request):
        seen["key"] = request.headers.get("MLP-API-KEY")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"text": "дача из бревна"})

    assert build(handler).recognize(b"audio-bytes") == "дача из бревна"
    assert seen["key"] == "test-key"
    assert seen["body"]["data"] == {"audio_base64": base64.b64encode(b"audio-bytes").decode()}


def test_diarization_is_disabled():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"text": "дом кирпичный", "diarization_enabled": False})

    build(handler).recognize(b"x")
    assert seen["body"]["config"] == {"enable_diarization": False, "enable_segmentation": False}


def test_text_is_trimmed():
    def handler(request):
        return httpx.Response(200, json={"text": "  сто двадцать квадратов \n"})

    assert build(handler).recognize(b"x") == "сто двадцать квадратов"


def test_silence_returns_empty_string():
    def handler(request):
        return httpx.Response(200, json={"text": "", "audio_duration_seconds": 1.0})

    assert build(handler).recognize(b"x") == ""


def test_error_status_raises():
    def handler(request):
        return httpx.Response(401, json={"error": "unauthorized"})

    with pytest.raises(AsrError):
        build(handler).recognize(b"x")


def test_timeout_raises():
    def handler(request):
        raise httpx.TimeoutException("too slow")

    with pytest.raises(AsrError):
        build(handler).recognize(b"x")


def test_missing_key_raises_without_request():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"text": "ок"})

    with pytest.raises(AsrError):
        build(handler, api_key="").recognize(b"x")
    assert calls == []
