import time

import pytest

from app.policy_store import InvalidClientId, PolicyStore, PolicyTooLarge


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


def test_record_round_trip(tmp_path):
    store = build(tmp_path)
    store.save_record("demo-abc", {"number": "ПА-2026-000004", "pdfUrl": "https://x/y.pdf"})
    assert store.latest("demo-abc")["number"] == "ПА-2026-000004"


def test_archive_keeps_newest_first(tmp_path):
    store = build(tmp_path)
    store.save_record("demo-abc", {"number": "ПА-2026-000001"})
    store.save_record("demo-xyz", {"number": "ПА-2026-000002"})
    numbers = [item["number"] for item in store.archive()]
    assert numbers == ["ПА-2026-000002", "ПА-2026-000001"]


def test_latest_picks_own_client(tmp_path):
    store = build(tmp_path)
    store.save_record("demo-abc", {"number": "ПА-2026-000001"})
    store.save_record("demo-xyz", {"number": "ПА-2026-000002"})
    assert store.latest("demo-abc")["number"] == "ПА-2026-000001"


def test_archive_is_capped(tmp_path):
    store = build(tmp_path)
    for index in range(PolicyStore.ARCHIVE_LIMIT + 5):
        store.save_record("demo-abc", {"number": str(index)})
    assert len(store.archive()) == PolicyStore.ARCHIVE_LIMIT
    assert store.archive()[0]["number"] == str(PolicyStore.ARCHIVE_LIMIT + 4)


def test_purge_keeps_archive(tmp_path):
    import os

    store = build(tmp_path, ttl_hours=1)
    store.save_record("demo-abc", {"number": "ПА-2026-000001"})
    archive = tmp_path / "records" / "archive.json"
    stale = time.time() - 2 * 3600
    os.utime(archive, (stale, stale))
    store.purge_expired()
    assert store.archive()[0]["number"] == "ПА-2026-000001"


def test_record_rejects_unsafe_client_id(tmp_path):
    store = build(tmp_path)
    with pytest.raises(InvalidClientId):
        store.save_record("../evil", {})
    with pytest.raises(InvalidClientId):
        store.latest("a/b")


def test_latest_reports_missing_client(tmp_path):
    store = build(tmp_path)
    with pytest.raises(FileNotFoundError):
        store.latest("demo-none")
