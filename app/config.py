import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    chat_api_base: str
    chat_api_token: str
    public_base_url: str
    audio_dir: str
    max_audio_bytes: int
    audio_ttl_hours: int
    chat_timeout_seconds: float
    asr_api_key: str
    asr_url: str
    asr_timeout_seconds: float
    policy_dir: str
    policy_token: str
    max_policy_bytes: int
    policy_ttl_hours: int


def load_config() -> Config:
    return Config(
        chat_api_base=os.getenv("CHAT_API_BASE", "https://bot.jaicp.com"),
        chat_api_token=os.getenv("CHAT_API_TOKEN", ""),
        public_base_url=os.getenv("PUBLIC_BASE_URL", "http://localhost:8000"),
        audio_dir=os.getenv("AUDIO_DIR", "./data/audio"),
        max_audio_bytes=int(os.getenv("MAX_AUDIO_BYTES", str(10 * 1024 * 1024))),
        audio_ttl_hours=int(os.getenv("AUDIO_TTL_HOURS", "24")),
        chat_timeout_seconds=float(os.getenv("CHAT_TIMEOUT_SECONDS", "60")),
        asr_api_key=os.getenv("ASR_API_KEY", ""),
        asr_url=os.getenv(
            "ASR_URL",
            "https://caila.io/api/mlpgate/account/jay/model/sber-gigaam/predict-with-config",
        ),
        asr_timeout_seconds=float(os.getenv("ASR_TIMEOUT_SECONDS", "120")),
        policy_dir=os.getenv("POLICY_DIR", "./data/policy"),
        policy_token=os.getenv("POLICY_TOKEN", ""),
        max_policy_bytes=int(os.getenv("MAX_POLICY_BYTES", str(5 * 1024 * 1024))),
        policy_ttl_hours=int(os.getenv("POLICY_TTL_HOURS", "24")),
    )
