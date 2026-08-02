from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.asr import AsrError, CailaAsrClient
from app.audio_store import AudioStore, AudioTooLarge, UnsupportedAudio
from app.chat_api import ChatApiClient, ChatApiError
from app.config import load_config

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class MessageIn(BaseModel):
    clientId: str
    text: Optional[str] = None


class ResetIn(BaseModel):
    clientId: str


def create_app(chat_api, asr, audio_dir, public_base_url, max_audio_bytes, audio_ttl_hours) -> FastAPI:
    app = FastAPI(title="Voice insurance demo proxy")
    store = AudioStore(directory=audio_dir, max_bytes=max_audio_bytes, ttl_hours=audio_ttl_hours)
    base_url = public_base_url.rstrip("/")

    @app.post("/api/audio")
    async def upload_audio(file: UploadFile = File(...)):
        content = await file.read()
        try:
            name = store.save(content, file.content_type)
        except UnsupportedAudio:
            raise HTTPException(status_code=415, detail="unsupported audio type")
        except AudioTooLarge:
            raise HTTPException(status_code=413, detail="file too large")
        store.purge_expired()

        try:
            text = asr.recognize(content)
        except AsrError as error:
            return JSONResponse(status_code=502, content={"error": str(error)})

        return {"audioUrl": f"{base_url}/audio/{name}", "text": text}

    @app.get("/audio/{name}")
    def get_audio(name: str):
        try:
            path = store.path(name)
        except (FileNotFoundError, ValueError):
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(path)

    @app.post("/api/message")
    def send_message(payload: MessageIn):
        if not payload.text:
            raise HTTPException(status_code=422, detail="text is required")

        try:
            return chat_api.send_query(payload.clientId, payload.text)
        except ChatApiError as error:
            return JSONResponse(status_code=502, content={"error": str(error)})

    @app.post("/api/reset")
    def reset_session(payload: ResetIn):
        try:
            return chat_api.send_event(payload.clientId, "reset")
        except ChatApiError as error:
            return JSONResponse(status_code=502, content={"error": str(error)})

    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

    return app


def build_default_app() -> FastAPI:
    config = load_config()
    chat_api = ChatApiClient(
        base_url=config.chat_api_base,
        token=config.chat_api_token,
        timeout=config.chat_timeout_seconds,
    )
    asr = CailaAsrClient(
        api_key=config.asr_api_key,
        url=config.asr_url,
        timeout=config.asr_timeout_seconds,
    )
    return create_app(
        chat_api=chat_api,
        asr=asr,
        audio_dir=config.audio_dir,
        public_base_url=config.public_base_url,
        max_audio_bytes=config.max_audio_bytes,
        audio_ttl_hours=config.audio_ttl_hours,
    )


app = build_default_app()
