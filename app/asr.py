import base64

import httpx


class AsrError(RuntimeError):
    pass


# Говорящий один, поэтому диаризация и сегментация только мешают: с ними в text
# приходят метки спикеров и тайминги, и агент принимает их за часть реплики.
RECOGNITION_CONFIG = {"enable_diarization": False, "enable_segmentation": False}


class CailaAsrClient:
    """Распознавание речи моделью sber-gigaam в Caila: аудио уходит одним base64."""

    def __init__(self, api_key: str, url: str, timeout: float, http_client: httpx.Client = None):
        self.api_key = api_key
        self.url = url
        self.timeout = timeout
        self._client = http_client or httpx.Client(timeout=timeout)

    def recognize(self, audio: bytes) -> str:
        if not self.api_key:
            raise AsrError("asr api key is not configured")

        payload = {
            "data": {"audio_base64": base64.b64encode(audio).decode("ascii")},
            "config": RECOGNITION_CONFIG,
        }
        headers = {"MLP-API-KEY": self.api_key}
        try:
            response = self._client.post(self.url, json=payload, headers=headers, timeout=self.timeout)
        except httpx.TimeoutException as error:
            raise AsrError("asr timeout") from error
        except httpx.HTTPError as error:
            raise AsrError(f"asr transport error: {error}") from error

        if response.status_code != 200:
            raise AsrError(f"asr status {response.status_code}")

        text = response.json().get("text")
        return text.strip() if isinstance(text, str) else ""
