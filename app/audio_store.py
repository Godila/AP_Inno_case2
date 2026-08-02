import time
import uuid
from pathlib import Path

EXTENSIONS = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
}


class UnsupportedAudio(ValueError):
    pass


class AudioTooLarge(ValueError):
    pass


class AudioStore:
    """Хранит записи под неугадываемыми именами и чистит их по TTL."""

    def __init__(self, directory: str, max_bytes: int, ttl_hours: int):
        self.directory = Path(directory)
        self.max_bytes = max_bytes
        self.ttl_seconds = ttl_hours * 3600
        self.directory.mkdir(parents=True, exist_ok=True)

    def save(self, content: bytes, content_type: str) -> str:
        base_type = (content_type or "").split(";")[0].strip().lower()
        if base_type not in EXTENSIONS:
            raise UnsupportedAudio(base_type)
        if len(content) > self.max_bytes:
            raise AudioTooLarge(len(content))

        name = f"{uuid.uuid4().hex}{EXTENSIONS[base_type]}"
        (self.directory / name).write_bytes(content)
        return name

    def path(self, name: str) -> Path:
        candidate = (self.directory / name).resolve()
        if candidate.parent != self.directory.resolve():
            raise ValueError("invalid audio name")
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
