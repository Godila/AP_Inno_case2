import time

import pytest

from app.policy_store import PolicyStore, PolicyTooLarge


def build(tmp_path, max_bytes=1024, ttl_hours=24):
    return PolicyStore(directory=str(tmp_path), max_bytes=max_bytes, ttl_hours=ttl_hours)


def test_save_returns_random_pdf_name(tmp_path):
    store = build(tmp_path)
    first = store.save(b"%PDF-1.4 one")
    second = store.save(b"%PDF-1.4 two")
    assert first != second
    assert first.endswith(".pdf")
    assert store.path(first).read_bytes() == b"%PDF-1.4 one"


def test_save_rejects_oversized_file(tmp_path):
    store = build(tmp_path, max_bytes=4)
    with pytest.raises(PolicyTooLarge):
        store.save(b"12345")


def test_path_rejects_escape(tmp_path):
    store = build(tmp_path)
    with pytest.raises(ValueError):
        store.path("../secret.pdf")


def test_path_reports_missing_file(tmp_path):
    store = build(tmp_path)
    with pytest.raises(FileNotFoundError):
        store.path("nope.pdf")


def test_purge_removes_only_expired(tmp_path):
    store = build(tmp_path, ttl_hours=1)
    fresh = store.save(b"fresh")
    old = store.save(b"old")
    stale = time.time() - 2 * 3600
    import os

    os.utime(tmp_path / old, (stale, stale))
    assert store.purge_expired() == 1
    assert store.path(fresh).is_file()
    with pytest.raises(FileNotFoundError):
        store.path(old)
