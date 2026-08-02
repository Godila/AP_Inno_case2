import httpx


class ChatApiError(RuntimeError):
    pass


class ChatApiClient:
    """Тонкая обертка над Chat API: только отправка запроса и события."""

    def __init__(self, base_url: str, token: str, timeout: float, http_client: httpx.Client = None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._client = http_client or httpx.Client(timeout=timeout)

    def _post(self, payload: dict) -> dict:
        url = f"{self.base_url}/chatapi/{self.token}"
        try:
            response = self._client.post(url, json=payload, timeout=self.timeout)
        except httpx.TimeoutException as error:
            raise ChatApiError("chat api timeout") from error
        except httpx.HTTPError as error:
            raise ChatApiError(f"chat api transport error: {error}") from error

        if response.status_code != 200:
            raise ChatApiError(f"chat api status {response.status_code}")
        return response.json()

    def send_query(self, client_id: str, query: str, data: dict = None) -> dict:
        payload = {"clientId": client_id, "query": query}
        if data:
            payload["data"] = data
        return self._post(payload)

    def send_event(self, client_id: str, event: str, data: dict = None) -> dict:
        payload = {"clientId": client_id, "event": event}
        if data:
            payload["data"] = data
        return self._post(payload)
