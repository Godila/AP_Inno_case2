import base64
import io

from fastapi.testclient import TestClient

from app.asr import AsrError
from app.chat_api import ChatApiError
from app.main import create_app


class FakeChatApi:
    def __init__(self, response=None, error=None):
        self.response = response or {"data": {"replies": [{"type": "text", "text": "ок"}]}}
        self.error = error
        self.calls = []

    def send_query(self, client_id, query, data=None):
        self.calls.append(("query", client_id, query, data))
        if self.error:
            raise self.error
        return self.response

    def send_event(self, client_id, event, data=None):
        self.calls.append(("event", client_id, event, data))
        if self.error:
            raise self.error
        return self.response


class FakeAsr:
    def __init__(self, text="дача из бревна", error=None):
        self.text = text
        self.error = error
        self.calls = []

    def recognize(self, audio):
        self.calls.append(audio)
        if self.error:
            raise self.error
        return self.text


def build(tmp_path, chat_api, asr=None, policy_token="secret"):
    app = create_app(
        chat_api=chat_api,
        asr=asr or FakeAsr(),
        audio_dir=str(tmp_path / "audio"),
        public_base_url="https://demo.example",
        max_audio_bytes=1024,
        audio_ttl_hours=24,
        policy_dir=str(tmp_path / "policy"),
        policy_token=policy_token,
        max_policy_bytes=1024,
        policy_ttl_hours=24,
    )
    return TestClient(app)


def test_upload_returns_public_url(tmp_path):
    client = build(tmp_path, FakeChatApi())
    files = {"file": ("voice.webm", io.BytesIO(b"audio"), "audio/webm")}

    response = client.post("/api/audio", files=files)

    assert response.status_code == 200
    url = response.json()["audioUrl"]
    assert url.startswith("https://demo.example/audio/")
    assert url.endswith(".webm")


def test_upload_recognizes_speech(tmp_path):
    asr = FakeAsr(text="дом сто квадратов")
    client = build(tmp_path, FakeChatApi(), asr)
    files = {"file": ("voice.webm", io.BytesIO(b"audio-bytes"), "audio/webm")}

    response = client.post("/api/audio", files=files)

    assert response.json()["text"] == "дом сто квадратов"
    assert asr.calls == [b"audio-bytes"]


def test_upload_returns_502_when_asr_fails(tmp_path):
    client = build(tmp_path, FakeChatApi(), FakeAsr(error=AsrError("asr timeout")))
    files = {"file": ("voice.webm", io.BytesIO(b"audio"), "audio/webm")}

    response = client.post("/api/audio", files=files)

    assert response.status_code == 502
    assert "error" in response.json()


def test_uploaded_file_is_served(tmp_path):
    client = build(tmp_path, FakeChatApi())
    files = {"file": ("voice.wav", io.BytesIO(b"audio-bytes"), "audio/wav")}
    name = client.post("/api/audio", files=files).json()["audioUrl"].rsplit("/", 1)[1]

    response = client.get(f"/audio/{name}")

    assert response.status_code == 200
    assert response.content == b"audio-bytes"


def test_upload_rejects_large_file(tmp_path):
    client = build(tmp_path, FakeChatApi())
    files = {"file": ("voice.wav", io.BytesIO(b"x" * 2048), "audio/wav")}

    assert client.post("/api/audio", files=files).status_code == 413


def test_upload_rejects_non_audio(tmp_path):
    client = build(tmp_path, FakeChatApi())
    files = {"file": ("doc.pdf", io.BytesIO(b"x"), "application/pdf")}

    assert client.post("/api/audio", files=files).status_code == 415


def test_missing_audio_returns_404(tmp_path):
    client = build(tmp_path, FakeChatApi())
    assert client.get("/audio/unknown.wav").status_code == 404


def test_message_with_text_is_forwarded(tmp_path):
    chat_api = FakeChatApi()
    client = build(tmp_path, chat_api)

    response = client.post("/api/message", json={"clientId": "c1", "text": "дача из бревна"})

    assert response.status_code == 200
    assert chat_api.calls == [("query", "c1", "дача из бревна", None)]


def test_message_without_text_is_rejected(tmp_path):
    client = build(tmp_path, FakeChatApi())
    assert client.post("/api/message", json={"clientId": "c1"}).status_code == 422


def test_reset_sends_event(tmp_path):
    chat_api = FakeChatApi()
    client = build(tmp_path, chat_api)

    client.post("/api/reset", json={"clientId": "c1"})

    assert chat_api.calls == [("event", "c1", "reset", None)]


def test_chat_api_failure_returns_502(tmp_path):
    client = build(tmp_path, FakeChatApi(error=ChatApiError("timeout")))

    response = client.post("/api/message", json={"clientId": "c1", "text": "привет"})

    assert response.status_code == 502
    assert "error" in response.json()


def test_policy_upload_returns_public_url(tmp_path):
    client = build(tmp_path, FakeChatApi())
    body = {"pdfBase64": base64.b64encode(b"%PDF-1.4 demo").decode("ascii")}

    response = client.post("/api/policy", json=body, headers={"X-Policy-Token": "secret"})

    assert response.status_code == 200
    url = response.json()["url"]
    assert url.startswith("https://demo.example/policy/")

    stored = client.get("/policy/" + url.rsplit("/", 1)[1])
    assert stored.status_code == 200
    assert stored.content == b"%PDF-1.4 demo"
    assert stored.headers["content-type"] == "application/pdf"


def test_policy_upload_requires_token(tmp_path):
    client = build(tmp_path, FakeChatApi())
    body = {"pdfBase64": base64.b64encode(b"%PDF").decode("ascii")}

    assert client.post("/api/policy", json=body).status_code == 403
    assert client.post("/api/policy", json=body, headers={"X-Policy-Token": "wrong"}).status_code == 403


def test_policy_upload_refused_without_configured_token(tmp_path):
    client = build(tmp_path, FakeChatApi(), policy_token="")
    body = {"pdfBase64": base64.b64encode(b"%PDF").decode("ascii")}

    assert client.post("/api/policy", json=body, headers={"X-Policy-Token": ""}).status_code == 403


def test_policy_upload_rejects_broken_base64(tmp_path):
    client = build(tmp_path, FakeChatApi())

    response = client.post("/api/policy", json={"pdfBase64": "not base64!"}, headers={"X-Policy-Token": "secret"})

    assert response.status_code == 422


def test_policy_upload_rejects_oversized_file(tmp_path):
    client = build(tmp_path, FakeChatApi())
    body = {"pdfBase64": base64.b64encode(b"x" * 2048).decode("ascii")}

    response = client.post("/api/policy", json=body, headers={"X-Policy-Token": "secret"})

    assert response.status_code == 413


def test_missing_policy_gives_404(tmp_path):
    client = build(tmp_path, FakeChatApi())

    assert client.get("/policy/deadbeef.pdf").status_code == 404


def test_policy_upload_stores_record_for_client(tmp_path):
    client = build(tmp_path, FakeChatApi())
    body = {
        "pdfBase64": base64.b64encode(b"%PDF").decode("ascii"),
        "clientId": "demo-abc",
        "policy": {"number": "ПА-2026-000004", "issuedAt": "03.08.2026"},
    }

    url = client.post("/api/policy", json=body, headers={"X-Policy-Token": "secret"}).json()["url"]

    stored = client.get("/api/policy/latest", params={"clientId": "demo-abc"}).json()["policy"]
    assert stored["number"] == "ПА-2026-000004"
    assert stored["pdfUrl"] == url


def test_latest_policy_is_404_for_unknown_client(tmp_path):
    client = build(tmp_path, FakeChatApi())

    assert client.get("/api/policy/latest", params={"clientId": "demo-none"}).status_code == 404


def test_latest_policy_rejects_unsafe_client_id(tmp_path):
    client = build(tmp_path, FakeChatApi())

    assert client.get("/api/policy/latest", params={"clientId": "../etc"}).status_code == 422


def test_archive_clear_requires_token(tmp_path):
    client = build(tmp_path, FakeChatApi())

    assert client.delete("/api/policy/archive").status_code == 403


def test_archive_clear_removes_everything(tmp_path):
    client = build(tmp_path, FakeChatApi())
    for number in ("ПА-2026-000001", "ПА-2026-000002"):
        client.post(
            "/api/policy",
            json={
                "pdfBase64": base64.b64encode(b"%PDF").decode("ascii"),
                "clientId": "demo-abc",
                "policy": {"number": number},
            },
            headers={"X-Policy-Token": "secret"},
        )

    response = client.delete("/api/policy/archive", headers={"X-Policy-Token": "secret"})

    assert response.json() == {"removed": 2}
    assert client.get("/api/policy/archive").json()["policies"] == []


def test_archive_clear_removes_one_policy(tmp_path):
    client = build(tmp_path, FakeChatApi())
    for number in ("ПА-2026-000001", "ПА-2026-000002"):
        client.post(
            "/api/policy",
            json={
                "pdfBase64": base64.b64encode(b"%PDF").decode("ascii"),
                "clientId": "demo-abc",
                "policy": {"number": number},
            },
            headers={"X-Policy-Token": "secret"},
        )

    response = client.delete(
        "/api/policy/archive",
        params={"number": "ПА-2026-000001"},
        headers={"X-Policy-Token": "secret"},
    )

    assert response.json() == {"removed": 1}
    left = client.get("/api/policy/archive").json()["policies"]
    assert [item["number"] for item in left] == ["ПА-2026-000002"]
