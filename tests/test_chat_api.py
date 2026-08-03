import json

import httpx
import pytest

from app.chat_api import ChatApiClient, ChatApiError


def client_with(handler):
    return ChatApiClient(
        base_url="https://bot.example",
        token="TOKEN",
        timeout=5.0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_send_query_posts_expected_payload():
    captured = {}

    def handler(request):
        captured["url"] = str(request.url)
        captured["json"] = json.loads(request.content)
        return httpx.Response(200, json={"data": {"replies": []}})

    api = client_with(handler)
    result = api.send_query("client-1", "дача из бревна", {"audioUrl": "https://demo/a.wav"})

    assert captured["url"] == "https://bot.example/chatapi/TOKEN"
    assert captured["json"] == {
        "clientId": "client-1",
        "query": "дача из бревна",
        "data": {"audioUrl": "https://demo/a.wav"},
    }
    assert result == {"data": {"replies": []}}


def test_send_query_without_data_omits_field():
    captured = {}

    def handler(request):
        captured["json"] = json.loads(request.content)
        return httpx.Response(200, json={})

    client_with(handler).send_query("client-1", "привет", None)

    assert "data" not in captured["json"]


def test_send_event_posts_event_field():
    captured = {}

    def handler(request):
        captured["json"] = json.loads(request.content)
        return httpx.Response(200, json={})

    client_with(handler).send_event("client-1", "reset")

    assert captured["json"] == {"clientId": "client-1", "event": "reset"}


def test_non_200_raises():
    api = client_with(lambda request: httpx.Response(502, text="bad gateway"))
    with pytest.raises(ChatApiError):
        api.send_query("client-1", "привет", None)


def test_timeout_raises_chat_api_error():
    def handler(request):
        raise httpx.TimeoutException("too slow", request=request)

    with pytest.raises(ChatApiError):
        client_with(handler).send_query("client-1", "привет", None)
