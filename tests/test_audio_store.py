import os
import time

import pytest

from app.audio_store import AudioStore, AudioTooLarge, UnsupportedAudio


def make_store(tmp_path, max_bytes=1024, ttl_hours=24):
    return AudioStore(directory=str(tmp_path), max_bytes=max_bytes, ttl_hours=ttl_hours)


def test_save_returns_name_with_extension(tmp_path):
    store = make_store(tmp_path)
    name = store.save(b"audio-bytes", "audio/webm")
    assert name.endswith(".webm")
    assert (tmp_path / name).read_bytes() == b"audio-bytes"


def test_content_type_with_codec_suffix_is_accepted(tmp_path):
    store = make_store(tmp_path)
    name = store.save(b"a", "audio/webm;codecs=opus")
    assert name.endswith(".webm")


def test_names_are_unique(tmp_path):
    store = make_store(tmp_path)
    assert store.save(b"a", "audio/wav") != store.save(b"a", "audio/wav")


def test_rejects_unsupported_content_type(tmp_path):
    store = make_store(tmp_path)
    with pytest.raises(UnsupportedAudio):
        store.save(b"a", "application/pdf")


def test_rejects_too_large_file(tmp_path):
    store = make_store(tmp_path, max_bytes=4)
    with pytest.raises(AudioTooLarge):
        store.save(b"12345", "audio/wav")


def test_path_rejects_traversal(tmp_path):
    store = make_store(tmp_path)
    with pytest.raises(ValueError):
        store.path("../secret.wav")


def test_path_raises_for_missing_file(tmp_path):
    store = make_store(tmp_path)
    with pytest.raises(FileNotFoundError):
        store.path("nothing.wav")


def test_purge_removes_expired_only(tmp_path):
    store = make_store(tmp_path, ttl_hours=1)
    fresh = store.save(b"a", "audio/wav")
    old = store.save(b"b", "audio/wav")
    old_time = time.time() - 7200
    os.utime(tmp_path / old, (old_time, old_time))

    removed = store.purge_expired()

    assert removed == 1
    assert (tmp_path / fresh).exists()
    assert not (tmp_path / old).exists()
