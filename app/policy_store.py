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

    Рядом с бланком лежит запись о последнем полисе клиента. Она нужна потому,
    что реплики функции выпуска до канала не доезжают, и страница забирает
    реквизиты отсюда, а не из диалога.
    """

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

    def _record_path(self, client_id: str) -> Path:
        if not CLIENT_ID.match(client_id or ""):
            raise InvalidClientId(client_id)
        return self.records / f"{client_id}.json"

    def save_record(self, client_id: str, record: dict) -> None:
        path = self._record_path(client_id)
        path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

    def latest(self, client_id: str) -> dict:
        path = self._record_path(client_id)
        if not path.is_file():
            raise FileNotFoundError(client_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def purge_expired(self, now: float = None) -> int:
        moment = now if now is not None else time.time()
        removed = 0
        for folder in (self.directory, self.records):
            for item in folder.iterdir():
                if item.is_file() and moment - item.stat().st_mtime > self.ttl_seconds:
                    item.unlink()
                    removed += 1
        return removed
