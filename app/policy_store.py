import time
import uuid
from pathlib import Path


class PolicyTooLarge(ValueError):
    pass


class PolicyStore:
    """Хранит бланки полисов под неугадываемыми именами и чистит их по TTL.

    Имя случайное, а не номер полиса: номер идет подряд и легко подбирается,
    а ссылка на бланк отдается без авторизации.
    """

    def __init__(self, directory: str, max_bytes: int, ttl_hours: int):
        self.directory = Path(directory)
        self.max_bytes = max_bytes
        self.ttl_seconds = ttl_hours * 3600
        self.directory.mkdir(parents=True, exist_ok=True)

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

    def purge_expired(self, now: float = None) -> int:
        moment = now if now is not None else time.time()
        removed = 0
        for item in self.directory.iterdir():
            if item.is_file() and moment - item.stat().st_mtime > self.ttl_seconds:
                item.unlink()
                removed += 1
        return removed
