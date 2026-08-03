import json
import re
import time
import uuid
from pathlib import Path

CLIENT_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class PolicyTooLarge(ValueError):
    pass


class InvalidClientId(ValueError):
    pass


class PolicyStore:
    """Хранит бланки полисов под неугадываемыми именами и чистит их по TTL.

    Имя случайное, а не номер полиса: номер идет подряд и легко подбирается,
    а ссылка на бланк отдается без авторизации.

    Рядом с бланками лежит реестр выданных полисов. Он нужен потому, что реплики
    функции выпуска до канала не доезжают, и страница забирает реквизиты отсюда,
    а не из диалога. Он же показывается в интерфейсе как архив.
    """

    ARCHIVE_LIMIT = 50

    def __init__(self, directory: str, max_bytes: int, ttl_hours: int):
        self.directory = Path(directory)
        self.records = self.directory / "records"
        self.max_bytes = max_bytes
        self.ttl_seconds = ttl_hours * 3600
        self.directory.mkdir(parents=True, exist_ok=True)
        self.records.mkdir(parents=True, exist_ok=True)

    def save(self, content: bytes) -> str:
        if len(content) > self.max_bytes:
            raise PolicyTooLarge(len(content))
        name = f"{uuid.uuid4().hex}.pdf"
        (self.directory / name).write_bytes(content)
        return name

    def path(self, name: str) -> Path:
        candidate = (self.directory / name).resolve()
        if candidate.parent != self.directory.resolve():
            raise ValueError("invalid policy name")
        if not candidate.is_file():
            raise FileNotFoundError(name)
        return candidate

    def _archive_path(self) -> Path:
        return self.records / "archive.json"

    def archive(self) -> list:
        path = self._archive_path()
        if not path.is_file():
            return []
        return json.loads(path.read_text(encoding="utf-8"))

    def save_record(self, client_id: str, record: dict) -> None:
        if not CLIENT_ID.match(client_id or ""):
            raise InvalidClientId(client_id)
        entry = dict(record)
        entry["clientId"] = client_id
        items = [entry] + self.archive()
        self._archive_path().write_text(
            json.dumps(items[:self.ARCHIVE_LIMIT], ensure_ascii=False), encoding="utf-8"
        )

    def latest(self, client_id: str) -> dict:
        if not CLIENT_ID.match(client_id or ""):
            raise InvalidClientId(client_id)
        for entry in self.archive():
            if entry.get("clientId") == client_id:
                return entry
        raise FileNotFoundError(client_id)

    def purge_expired(self, now: float = None) -> int:
        """Чистит только бланки. Реестр не трогаем: он и есть ценность."""
        moment = now if now is not None else time.time()
        removed = 0
        for item in self.directory.iterdir():
            if item.is_file() and moment - item.stat().st_mtime > self.ttl_seconds:
                item.unlink()
                removed += 1
        return removed
