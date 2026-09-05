import hashlib
import io
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from google.api_core.exceptions import ServiceUnavailable
from PIL import Image
from pillow_heif import register_heif_opener

import fotovibe.app as app_module
from fotovibe.app import COOKIE, Settings, create_app
from fotovibe.storage import LocalStore

register_heif_opener()
ORIGIN = {"Origin": "https://testserver"}


class TestTaskStore:
    __test__ = False

    def __init__(self, tasks):
        self.tasks = tasks

    def enabled(self):
        return self.tasks


class MutableTestTaskStore:
    def __init__(self, tasks=()):
        self.tasks = [dict(task) for task in tasks]

    def enabled(self):
        return [{"id": task["id"], "text": task["text"]} for task in self.tasks if task["enabled"]]

    def all(self):
        return [dict(task) for task in self.tasks]

    def create(self, text):
        task = {"id": f"party-{len(self.tasks) + 1}", "text": text.strip(), "enabled": True}
        self.tasks.append(task)
        return dict(task)

    def upsert(self, task_id, text, enabled=True):
        for index, task in enumerate(self.tasks):
            if task["id"] == task_id:
                updated = {"id": task_id, "text": text.strip(), "enabled": enabled}
                self.tasks[index] = updated
                return dict(updated)
        raise ValueError("missing")

    def delete(self, task_id):
        before = len(self.tasks)
        self.tasks = [task for task in self.tasks if task["id"] != task_id]
        return len(self.tasks) != before


def picture(fmt="JPEG", color="red", orientation=None):
    # HEIF's encoder normalizes the orientation tag; provide already-oriented pixels.
    image = Image.new("RGB", (80, 120) if fmt == "HEIF" and orientation == 6 else (120, 80), color)
    output = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[274] = orientation
        exif[270] = "Private original metadata"
    image.save(output, fmt, exif=exif)
    return output.getvalue()


@pytest.fixture
def env(tmp_path):
    store = LocalStore(tmp_path)
    app = create_app(Settings("TEST-CODE", "test-signing-key"), store)
    client = TestClient(app, base_url="https://testserver")
    return client, app, store


def login(client):
    response = client.post("/api/session", json={"code": "test code"}, headers=ORIGIN)
    assert response.status_code == 200
    return response


def login_device(client, device_id):
    response = client.post(
        "/api/session",
        json={"code": "test code", "device_id": device_id},
        headers=ORIGIN,
    )
    assert response.status_code == 200
    return response


def upload(
    client,
    data=None,
    photo_id=None,
    task_id=None,
    task_token=None,
    client_metadata=None,
    include_photo_id=True,
):
    fields = {}
    if include_photo_id:
        fields["upload_id"] = photo_id or str(uuid.uuid4())
    if task_id is not None:
        fields["task_id"] = task_id
    if task_token is not None:
        fields["task_token"] = task_token
    if client_metadata is not None:
        fields["client_metadata"] = json.dumps(client_metadata)
    return client.post(
        "/api/photos",
        headers=ORIGIN,
        data=fields,
        files={"photo": ("photo.jpg", data if data is not None else picture(), "image/jpeg")},
    )


def raw_upload(
    client,
    data=None,
    photo_id=None,
    task_id=None,
    task_token=None,
    client_metadata=None,
    content_type="image/jpeg",
):
    headers = {
        **ORIGIN,
        "Content-Type": content_type,
        "X-FotoVibe-Upload-ID": photo_id or str(uuid.uuid4()),
    }
    if task_id is not None:
        headers["X-FotoVibe-Task-ID"] = task_id
    if task_token is not None:
        headers["X-FotoVibe-Task-Token"] = task_token
    if client_metadata is not None:
        headers["X-FotoVibe-Client-Metadata"] = json.dumps(client_metadata)
    return client.post(
        "/api/photos",
        headers=headers,
        content=data if data is not None else picture(),
    )


def test_private_endpoints_and_cookie(env):
    client, _, store = env
    photo_id = str(uuid.uuid4())
    for path in [
        "/api/session",
        "/api/photos",
        "/api/tasks/random",
        f"/api/photos/{photo_id}/original",
        f"/api/photos/{photo_id}/thumb",
    ]:
        assert client.get(path).status_code == 401
    assert upload(client).status_code == 401
    assert not store.published()
    result = login(client)
    cookie = result.headers["set-cookie"]
    assert all(
        flag in cookie for flag in ["Secure", "HttpOnly", "SameSite=strict", "Max-Age=604800"]
    )
    assert client.get("/api/photos").json() == {"photos": [], "next_cursor": None}
    client.delete("/api/session", headers=ORIGIN)
    assert client.get("/api/photos").status_code == 401


def test_origin_and_invalid_login(env):
    client, _, _ = env
    assert client.post("/api/session", json={"code": "TESTCODE"}).status_code == 403
    assert (
        client.post(
            "/api/session", json={"code": "TESTCODE"}, headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    assert client.post("/api/session", json={"code": "wrong"}, headers=ORIGIN).status_code == 401
    for bad in [{"code": []}, [], None]:
        assert client.post("/api/session", json=bad, headers=ORIGIN).status_code == 400


def test_configured_test_code_uses_the_same_gallery(tmp_path):
    store = LocalStore(tmp_path)
    app = create_app(Settings("PRIMARY-CODE", "test-signing-key", True, ("1234",)), store)
    primary = TestClient(app, base_url="https://testserver")
    test_user = TestClient(app, base_url="https://testserver")

    assert (
        primary.post("/api/session", json={"code": "primary code"}, headers=ORIGIN).status_code
        == 200
    )
    assert (
        test_user.post("/api/session", json={"code": "1 2 3 4"}, headers=ORIGIN).status_code == 200
    )

    photo_id = str(uuid.uuid4())
    assert upload(test_user, photo_id=photo_id).status_code == 201
    assert photo_id in {photo["id"] for photo in primary.get("/api/photos").json()["photos"]}


def test_expired_and_changed_code_sessions(env, monkeypatch):
    client, _, store = env
    login(client)
    with monkeypatch.context() as patch:
        patch.setattr(
            "itsdangerous.timed.TimestampSigner.get_timestamp",
            lambda self: int(time.time()) + 604801,
        )
        assert client.get("/api/photos").status_code == 401
    other = TestClient(
        create_app(Settings("NEWCODE", "test-signing-key"), store), base_url="https://testserver"
    )
    other.cookies.update(client.cookies)
    assert other.get("/api/photos").status_code == 401
    client.cookies.clear()
    client.cookies.set(COOKIE, "tampered")
    assert client.get("/api/photos").status_code == 401


def test_named_device_restores_session_and_authors_photos(env):
    client, _, _ = env
    device_id = str(uuid.uuid4())

    assert login_device(client, device_id).json() == {"authenticated": True, "user": None}
    created = client.post("/api/users/me", json={"name": "  Lea  Sommer "}, headers=ORIGIN)
    assert created.status_code == 200
    user = created.json()["user"]
    assert user["name"] == "Lea Sommer"
    assert user["id"].startswith("u_")
    assert user["device_id"].startswith("d_")
    assert user["values"] == {"photos_uploaded": 0}
    assert client.get("/api/session").json() == {"authenticated": True, "user": user}

    photo = upload(client)
    assert photo.status_code == 201
    author = {"id": user["id"], "name": user["name"]}
    assert photo.json()["metadata"] == {"author": author}
    listed = client.get("/api/photos").json()["photos"]
    assert listed[0]["author"] == author
    assert listed[0]["metadata"]["author"] == author
    updated = client.get("/api/session").json()["user"]
    assert updated["values"] == {"photos_uploaded": 1}

    client.cookies.clear()
    restored = client.post("/api/session/restore", json={"device_id": device_id}, headers=ORIGIN)
    assert restored.status_code == 200
    assert restored.json() == {"authenticated": True, "user": updated}
    assert client.get("/api/photos").status_code == 200


def test_gallery_can_filter_photos_uploaded_by_current_user(env):
    client, _, _ = env
    first_device = str(uuid.uuid4())
    second_device = str(uuid.uuid4())

    login_device(client, first_device)
    first_user = client.post("/api/users/me", json={"name": "Lea Sommer"}, headers=ORIGIN).json()["user"]
    first_photo = upload(client).json()["id"]

    login_device(client, second_device)
    second_user = client.post("/api/users/me", json={"name": "Mara"}, headers=ORIGIN).json()["user"]
    second_photo = upload(client).json()["id"]

    all_photos = {photo["id"] for photo in client.get("/api/photos").json()["photos"]}
    mine = {photo["id"] for photo in client.get("/api/photos?mine=1").json()["photos"]}

    assert all_photos >= {first_photo, second_photo}
    assert mine == {second_photo}
    assert second_user["id"] != first_user["id"]


def test_photo_reactions_comments_and_fuzzy_gallery_search(tmp_path):
    tasks = TestTaskStore(
        [{"id": "partygesicht", "text": "Zeig dein bestes Partygesicht."}]
    )
    app = create_app(Settings("TEST-CODE", "test-signing-key"), LocalStore(tmp_path), tasks)
    author = TestClient(app, base_url="https://testserver")
    guest = TestClient(app, base_url="https://testserver")
    login_device(author, str(uuid.uuid4()))
    login_device(guest, str(uuid.uuid4()))
    author_user = author.post("/api/users/me", json={"name": "Lea Sommer"}, headers=ORIGIN)
    guest_user = guest.post("/api/users/me", json={"name": "Mara"}, headers=ORIGIN)
    assert author_user.status_code == guest_user.status_code == 200

    photo_id = str(uuid.uuid4())
    assert upload(author, photo_id=photo_id, task_id="partygesicht").status_code == 201
    assert guest.post(
        f"/api/photos/{photo_id}/reactions", json={"emoji": "❤️"}, headers=ORIGIN
    ).status_code == 200
    # The immutable reaction event is idempotent for this device and emoji.
    reaction = guest.post(
        f"/api/photos/{photo_id}/reactions", json={"emoji": "❤️"}, headers=ORIGIN
    )
    assert reaction.status_code == 200
    assert reaction.json()["reactions"] == [{"emoji": "❤️", "count": 1}]
    assert reaction.json()["mine"] == ["❤️"]
    removed = guest.post(
        f"/api/photos/{photo_id}/reactions",
        json={"emoji": "❤️", "active": False},
        headers=ORIGIN,
    )
    assert removed.status_code == 200
    assert removed.json()["reactions"] == []
    assert removed.json()["mine"] == []
    restored = guest.post(
        f"/api/photos/{photo_id}/reactions",
        json={"emoji": "❤️", "active": True},
        headers=ORIGIN,
    )
    assert restored.status_code == 200
    assert restored.json()["reactions"] == [{"emoji": "❤️", "count": 1}]
    assert guest.post(
        f"/api/photos/{photo_id}/comments",
        json={"text": "  Was  für ein toller Moment!  "},
        headers=ORIGIN,
    ).status_code == 200

    details = author.get(f"/api/photos/{photo_id}/interactions")
    assert details.status_code == 200
    assert details.json()["comments"] == [
        {
            "author": {"id": guest_user.json()["user"]["id"], "name": "Mara"},
            "text": "Was für ein toller Moment!",
            "created_at": details.json()["comments"][0]["created_at"],
        }
    ]
    listed = author.get("/api/photos").json()["photos"]
    assert listed[0]["interactions"] == {
        "reactions": [{"emoji": "❤️", "count": 1}],
        "comments_count": 1,
    }
    assert [photo["id"] for photo in author.get("/api/photos", params={"q": "Leea"}).json()["photos"]] == [
        photo_id
    ]
    assert [photo["id"] for photo in author.get("/api/photos", params={"q": "Partygsicht"}).json()["photos"]] == [
        photo_id
    ]
    assert guest.post(
        f"/api/photos/{photo_id}/reactions", json={"emoji": "🤖"}, headers=ORIGIN
    ).status_code == 400
    assert guest.post(
        f"/api/photos/{photo_id}/comments", json={"text": "   "}, headers=ORIGIN
    ).status_code == 400


def test_user_upload_value_is_idempotent_and_recovers_interrupted_marker(env, monkeypatch):
    client, _, store = env
    login_device(client, str(uuid.uuid4()))
    client.post("/api/users/me", json={"name": "Mara"}, headers=ORIGIN)
    photo_id = str(uuid.uuid4())
    original_put = store.put
    marker_failed = False

    def fail_first_marker(key, *args, **kwargs):
        nonlocal marker_failed
        if "/uploads/" in key and not marker_failed:
            marker_failed = True
            raise ServiceUnavailable("simulated marker interruption")
        return original_put(key, *args, **kwargs)

    monkeypatch.setattr(store, "put", fail_first_marker)
    assert upload(client, photo_id=photo_id).status_code == 503
    assert len(store.published()) == 1

    monkeypatch.setattr(store, "put", original_put)
    assert upload(client, photo_id=photo_id).status_code == 200
    assert upload(client, photo_id=photo_id).status_code == 200
    profile = client.get("/api/session").json()["user"]
    assert profile["values"] == {"photos_uploaded": 1}
    assert len([obj for obj in store.list_prefix("users/") if "/uploads/" in obj.name]) == 1


def test_unknown_device_cannot_restore_and_name_is_set_once(env):
    client, _, _ = env
    device_id = str(uuid.uuid4())
    assert (
        client.post("/api/session/restore", json={"device_id": device_id}, headers=ORIGIN).status_code
        == 401
    )
    login_device(client, device_id)
    assert client.post("/api/users/me", json={"name": "A"}, headers=ORIGIN).status_code == 400
    assert client.post("/api/users/me", json={"name": "Mara"}, headers=ORIGIN).status_code == 200
    assert client.post("/api/users/me", json={"name": "Nora"}, headers=ORIGIN).status_code == 409


def test_admin_can_hide_photos_and_review_every_registered_user(tmp_path):
    store = LocalStore(tmp_path)
    admin_device = str(uuid.uuid4())
    epoch = hashlib.sha256(b"TESTCODE").hexdigest()
    admin_key = hashlib.sha256(f"{epoch}:{admin_device}".encode()).hexdigest()
    app = create_app(
        Settings(
            "TEST-CODE",
            "test-signing-key",
            True,
            (),
            ("d_" + admin_key[:12],),
        ),
        store,
    )
    admin = TestClient(app, base_url="https://testserver")
    guest = TestClient(app, base_url="https://testserver")

    login_device(admin, admin_device)
    admin_user = admin.post("/api/users/me", json={"name": "Alex"}, headers=ORIGIN).json()["user"]
    assert admin_user["is_admin"] is True

    login_device(guest, str(uuid.uuid4()))
    guest_user = guest.post("/api/users/me", json={"name": "Bea"}, headers=ORIGIN).json()["user"]
    photo_id = str(uuid.uuid4())
    assert upload(guest, photo_id=photo_id).status_code == 201

    assert guest.get("/api/admin/overview").status_code == 403
    assert guest.post(f"/api/admin/photos/{photo_id}/hide", headers=ORIGIN).status_code == 403
    promoted = admin.patch(
        f"/api/admin/users/{guest_user['device_id']}/role",
        json={"is_admin": True},
        headers=ORIGIN,
    )
    assert promoted.status_code == 200
    assert promoted.json()["user"]["is_admin"] is True
    assert guest.get("/api/admin/overview").status_code == 200
    assert guest.patch(
        f"/api/admin/users/{guest_user['device_id']}/role",
        json={"is_admin": False},
        headers=ORIGIN,
    ).status_code == 400
    demoted = admin.patch(
        f"/api/admin/users/{guest_user['device_id']}/role",
        json={"is_admin": False},
        headers=ORIGIN,
    )
    assert demoted.status_code == 200
    assert demoted.json()["user"]["is_admin"] is False
    assert guest.get("/api/admin/overview").status_code == 403
    role_events = store.list_prefix("admin_roles/")
    assert len(role_events) == 2
    assert all(event.name.endswith(".json") for event in role_events)
    assert admin.patch(
        f"/api/admin/users/{admin_user['device_id']}/role",
        json={"is_admin": False},
        headers=ORIGIN,
    ).status_code == 400
    overview = admin.get("/api/admin/overview")
    assert overview.status_code == 200
    users = {user["id"]: user for user in overview.json()["users"]}
    assert users[admin_user["id"]]["is_admin"] is True
    assert users[guest_user["id"]]["values"] == {
        "photos_uploaded": 1,
        "photos_visible": 1,
        "photos_hidden": 0,
    }
    assert users[guest_user["id"]]["photos"][0]["id"] == photo_id

    hidden = admin.post(f"/api/admin/photos/{photo_id}/hide", headers=ORIGIN)
    assert hidden.status_code == 200
    assert hidden.json() == {"id": photo_id, "hidden": True, "already_hidden": False}
    assert admin.post(f"/api/admin/photos/{photo_id}/hide", headers=ORIGIN).json()[
        "already_hidden"
    ] is True
    assert guest.get("/api/photos").json()["photos"] == []
    assert store.read(f"published/{photo_id}.json") is not None
    assert store.read(f"photos/{photo_id}/original") is not None
    hidden_user = {
        user["id"]: user for user in admin.get("/api/admin/overview").json()["users"]
    }[guest_user["id"]]
    assert hidden_user["values"]["photos_hidden"] == 1
    assert hidden_user["photos"][0]["hidden"] is True


def test_hot_comes_from_reactions_and_from_admin_rulings_together(tmp_path):
    store = LocalStore(tmp_path)
    admin_device = str(uuid.uuid4())
    epoch = hashlib.sha256(b"TESTCODE").hexdigest()
    admin_key = hashlib.sha256(f"{epoch}:{admin_device}".encode()).hexdigest()
    app = create_app(
        Settings("TEST-CODE", "test-signing-key", True, (), ("d_" + admin_key[:12],)),
        store,
    )
    admin = TestClient(app, base_url="https://testserver")
    guest = TestClient(app, base_url="https://testserver")

    login_device(admin, admin_device)
    admin.post("/api/users/me", json={"name": "Alex"}, headers=ORIGIN)
    login_device(guest, str(uuid.uuid4()))
    guest.post("/api/users/me", json={"name": "Bea"}, headers=ORIGIN)

    quiet = str(uuid.uuid4())
    loved = str(uuid.uuid4())
    for photo_id in (quiet, loved):
        assert upload(guest, photo_id=photo_id).status_code == 201

    def streamed():
        return {photo["id"]: photo for photo in guest.get("/api/photos/stream").json()["photos"]}

    def hot_count():
        return sum(1 for photo in streamed().values() if photo["hot"])

    # Nothing has happened yet, so nothing is hot.
    assert streamed()[quiet]["hot"] is False
    assert streamed()[loved]["hot"] is False

    # A reaction alone is enough, with no admin involved at all.
    assert guest.post(
        f"/api/photos/{loved}/reactions", json={"emoji": "❤️"}, headers=ORIGIN
    ).status_code == 200
    assert streamed()[loved]["hot"] is True
    assert streamed()[quiet]["hot"] is False
    assert hot_count() == 1

    # A hand-picked photo is added to that, not swapped for it.
    assert guest.post(
        f"/api/admin/photos/{quiet}/hot", json={"hot": True}, headers=ORIGIN
    ).status_code == 403
    assert admin.post(
        f"/api/admin/photos/{quiet}/hot", json={"hot": True}, headers=ORIGIN
    ).json() == {"id": quiet, "hot": True}
    assert streamed()[quiet]["hot"] is True
    assert hot_count() == 2

    # A ruling also works against the reactions: this one is popular and stays out.
    assert admin.post(
        f"/api/admin/photos/{loved}/hot", json={"hot": False}, headers=ORIGIN
    ).json() == {"id": loved, "hot": False}
    assert streamed()[loved]["hot"] is False
    assert hot_count() == 1
    # Both rulings are still on record; nothing was overwritten.
    assert len(store.list_prefix(f"pins/{loved}/")) == 1

    # Searching for "hot" finds exactly the hot ones, for guests too.
    found = guest.get("/api/photos", params={"q": "hot"}).json()["photos"]
    assert [photo["id"] for photo in found] == [quiet]
    assert found[0]["hot"] is True

    # A photo taken off the wall is not hot on it, whatever it was ruled.
    admin.post(f"/api/admin/photos/{quiet}/stream", json={"shown": False}, headers=ORIGIN)
    assert quiet not in streamed()
    assert guest.get("/api/photos", params={"q": "hot"}).json()["photos"] == []
    admin.post(f"/api/admin/photos/{quiet}/stream", json={"shown": True}, headers=ORIGIN)
    assert streamed()[quiet]["hot"] is True

    assert admin.post(
        f"/api/admin/photos/{quiet}/hot", json={"hot": "ja"}, headers=ORIGIN
    ).status_code == 400
    assert admin.post(
        f"/api/admin/photos/{uuid.uuid4()!s}/hot", json={"hot": True}, headers=ORIGIN
    ).status_code == 404


def test_admin_takes_a_photo_off_the_stream_but_keeps_it_in_the_gallery(tmp_path):
    store = LocalStore(tmp_path)
    admin_device = str(uuid.uuid4())
    epoch = hashlib.sha256(b"TESTCODE").hexdigest()
    admin_key = hashlib.sha256(f"{epoch}:{admin_device}".encode()).hexdigest()
    app = create_app(
        Settings("TEST-CODE", "test-signing-key", True, (), ("d_" + admin_key[:12],)),
        store,
    )
    admin = TestClient(app, base_url="https://testserver")
    guest = TestClient(app, base_url="https://testserver")

    login_device(admin, admin_device)
    admin.post("/api/users/me", json={"name": "Alex"}, headers=ORIGIN)
    login_device(guest, str(uuid.uuid4()))
    guest.post("/api/users/me", json={"name": "Bea"}, headers=ORIGIN)
    photo_id = str(uuid.uuid4())
    assert upload(guest, photo_id=photo_id).status_code == 201

    def on_wall():
        return [photo["id"] for photo in guest.get("/api/photos/stream").json()["photos"]]

    def in_gallery():
        return [photo["id"] for photo in guest.get("/api/photos").json()["photos"]]

    assert on_wall() == [photo_id]
    assert guest.post(
        f"/api/admin/photos/{photo_id}/stream", json={"shown": False}, headers=ORIGIN
    ).status_code == 403
    assert guest.get("/api/admin/photos").status_code == 403

    off = admin.post(
        f"/api/admin/photos/{photo_id}/stream", json={"shown": False}, headers=ORIGIN
    )
    assert off.json() == {"id": photo_id, "in_stream": False}
    assert on_wall() == []
    # The point of this switch: the photo stays in the gallery for everyone.
    assert in_gallery() == [photo_id]

    # The admin list still shows it, otherwise nobody could put it back.
    listed = {photo["id"]: photo for photo in admin.get("/api/admin/photos").json()["photos"]}
    assert listed[photo_id]["in_stream"] is False

    # A hot photo that is off the wall stays off it.
    admin.post(f"/api/admin/photos/{photo_id}/hot", json={"hot": True}, headers=ORIGIN)
    assert on_wall() == []

    back = admin.post(
        f"/api/admin/photos/{photo_id}/stream", json={"shown": True}, headers=ORIGIN
    )
    assert back.json() == {"id": photo_id, "in_stream": True}
    assert on_wall() == [photo_id]
    assert len(store.list_prefix(f"stream_hidden/{photo_id}/")) == 2

    assert admin.post(
        f"/api/admin/photos/{photo_id}/stream", json={"shown": "nein"}, headers=ORIGIN
    ).status_code == 400
    assert admin.post(
        f"/api/admin/photos/{uuid.uuid4()!s}/stream", json={"shown": False}, headers=ORIGIN
    ).status_code == 404


def test_users_can_add_tasks_and_admins_can_manage_them(tmp_path):
    store = LocalStore(tmp_path)
    admin_device = str(uuid.uuid4())
    epoch = hashlib.sha256(b"TESTCODE").hexdigest()
    admin_key = hashlib.sha256(f"{epoch}:{admin_device}".encode()).hexdigest()
    tasks = MutableTestTaskStore(
        [{"id": "bestehend", "text": "Bestehende Aufgabe", "enabled": True}]
    )
    app = create_app(
        Settings("TEST-CODE", "test-signing-key", True, (), ("d_" + admin_key[:12],)),
        store,
        tasks,
    )
    admin = TestClient(app, base_url="https://testserver")
    guest = TestClient(app, base_url="https://testserver")

    login_device(admin, admin_device)
    assert admin.post("/api/users/me", json={"name": "Alex"}, headers=ORIGIN).status_code == 200
    login_device(guest, str(uuid.uuid4()))
    assert guest.post("/api/users/me", json={"name": "Bea"}, headers=ORIGIN).status_code == 200

    created = guest.post("/api/tasks", json={"text": "  Ein Gruppenfoto mit Lachen  "}, headers=ORIGIN)
    assert created.status_code == 201
    task_id = created.json()["id"]
    assert created.json() == {
        "id": task_id,
        "text": "Ein Gruppenfoto mit Lachen",
        "enabled": True,
    }
    assert guest.post("/api/tasks", json={"text": "   "}, headers=ORIGIN).status_code == 400
    assert guest.get("/api/admin/tasks").status_code == 403
    assert guest.patch(f"/api/admin/tasks/{task_id}", json={"text": "Nein"}, headers=ORIGIN).status_code == 403
    assert guest.delete(f"/api/admin/tasks/{task_id}", headers=ORIGIN).status_code == 403

    listed = admin.get("/api/admin/tasks")
    assert listed.status_code == 200
    assert {task["id"] for task in listed.json()["tasks"]} == {"bestehend", task_id}
    updated = admin.patch(
        f"/api/admin/tasks/{task_id}",
        json={"text": "Ein Gruppenfoto mit lautem Lachen"},
        headers=ORIGIN,
    )
    assert updated.status_code == 200
    assert updated.json()["text"] == "Ein Gruppenfoto mit lautem Lachen"
    assert admin.delete("/api/admin/tasks/bestehend", headers=ORIGIN).status_code == 204
    assert admin.get("/api/admin/tasks").json()["tasks"] == [updated.json()]


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP", "HEIF"])
def test_originals_preserved_and_previews_metadata_free(env, fmt):
    client, _, store = env
    login(client)
    raw = picture(fmt, orientation=6)
    result = upload(client, raw)
    assert result.status_code == 201, result.text
    photo_id = result.json()["id"]
    original = client.get(f"/api/photos/{photo_id}/original")
    assert original.content == raw
    assert "attachment" in original.headers["content-disposition"]
    assert result.json()["sha256"] == hashlib.sha256(raw).hexdigest()
    for variant in ["thumb", "display"]:
        response = client.get(f"/api/photos/{photo_id}/{variant}")
        with Image.open(io.BytesIO(response.content)) as image:
            assert image.height > image.width
            assert not image.getexif()
            assert image.format == "JPEG"
    assert len(store.published()) == 1


def test_retry_is_idempotent_and_conflict_is_rejected(env):
    client, _, store = env
    login(client)
    photo_id = str(uuid.uuid4())
    assert upload(client, photo_id=photo_id).status_code == 201
    assert upload(client, photo_id=photo_id).status_code == 200
    assert upload(client, picture(color="blue"), photo_id).status_code == 409
    assert len(store.published()) == 1


def test_upload_allocates_a_photo_id_when_the_client_does_not_send_one(env):
    client, _, store = env
    login(client)

    response = upload(client, include_photo_id=False)

    assert response.status_code == 201
    assert str(uuid.UUID(response.json()["id"])) == response.json()["id"]
    assert len(store.published()) == 1


def test_partial_upload_hidden_and_retry_recovers(env, monkeypatch):
    client, _, store = env
    login(client)
    original_put = store.put
    photo_id = str(uuid.uuid4())

    def fail_thumb(key, *args, **kwargs):
        if key.endswith("thumb.jpg"):
            raise ServiceUnavailable("simulated interruption")
        return original_put(key, *args, **kwargs)

    monkeypatch.setattr(store, "put", fail_thumb)
    assert upload(client, photo_id=photo_id).status_code == 503
    assert not client.get("/api/photos").json()["photos"]
    assert client.get(f"/api/photos/{photo_id}/original").status_code == 404
    monkeypatch.setattr(store, "put", original_put)
    assert upload(client, photo_id=photo_id).status_code == 201
    assert len(client.get("/api/photos").json()["photos"]) == 1


def test_invalid_empty_oversized_and_animated_files(env):
    client, _, store = env
    login(client)
    assert upload(client, b"<svg><script>evil</script></svg>").status_code == 415
    assert upload(client, b"").status_code == 400
    assert upload(client, b"a" * (25 * 1024 * 1024 + 1)).status_code == 413
    assert (
        client.post(
            "/api/photos", content=b"", headers={**ORIGIN, "Content-Length": str(27 * 1024 * 1024)}
        ).status_code
        == 413
    )
    output = io.BytesIO()
    Image.new("RGB", (8001, 8000)).save(output, "PNG")
    assert upload(client, output.getvalue()).status_code == 413
    assert upload(client, photo_id="../../bad").status_code == 400
    assert not store.published()


def test_streamed_size_limit_without_content_length(env):
    client, _, _ = env
    chunks = (b"x" * 1024 for _ in range(5))
    response = client.post(
        "/api/session", content=chunks, headers={**ORIGIN, "Content-Type": "application/json"}
    )
    assert response.status_code == 413


def test_pagination_is_stable_when_new_photo_arrives(env):
    client, _, store = env
    login(client)
    for _ in range(65):
        photo_id = str(uuid.uuid4())
        store.put(
            f"published/{photo_id}.json", json.dumps({"id": photo_id}).encode(), "application/json"
        )
    first = client.get("/api/photos").json()
    assert len(first["photos"]) == 30
    assert upload(client).status_code == 201
    ids = [x["id"] for x in first["photos"]]
    cursor = first["next_cursor"]
    while cursor:
        page = client.get("/api/photos", params={"cursor": cursor}).json()
        ids.extend(x["id"] for x in page["photos"])
        cursor = page["next_cursor"]
    assert len(ids) == len(set(ids)) == 65
    assert client.get("/api/photos?cursor=invalid").status_code == 400


def test_random_task_and_immediate_repeat_exclusion(env):
    client, _, _ = env
    login(client)
    first = client.get("/api/tasks/random")
    assert first.status_code == 200
    assert first.json()["id"]
    assert first.json()["text"]
    second = client.get("/api/tasks/random", params={"exclude": first.json()["id"]})
    assert second.status_code == 200
    assert second.json()["id"] != first.json()["id"]
    assert client.get("/api/tasks/random?exclude=../bad").status_code == 400


def test_random_task_handles_empty_store(tmp_path):
    app = create_app(
        Settings("TEST-CODE", "test-signing-key"),
        LocalStore(tmp_path),
        TestTaskStore([]),
    )
    client = TestClient(app, base_url="https://testserver")
    login(client)
    response = client.get("/api/tasks/random")
    assert response.status_code == 503
    assert response.json()["detail"] == "Gerade ist keine Foto-Aufgabe verfügbar."


def test_offline_task_tokens_keep_the_drawn_wording_after_task_changes(tmp_path):
    tasks = MutableTestTaskStore(
        [{"id": "damals", "text": "Mach ein Foto mit Hut.", "enabled": True}]
    )
    store = LocalStore(tmp_path)
    client = TestClient(
        create_app(Settings("TEST-CODE", "test-signing-key"), store, tasks),
        base_url="https://testserver",
    )
    login(client)

    listed = client.get("/api/tasks")
    assert listed.status_code == 200
    task = listed.json()["tasks"][0]
    assert task["id"] == "damals"
    assert task["task_token"]

    tasks.upsert("damals", "Mach ein Foto mit Sonnenbrille.")
    response = upload(client, task_token=task["task_token"])
    assert response.status_code == 201
    assert response.json()["metadata"] == {
        "task": {"id": "damals", "text": "Mach ein Foto mit Hut."}
    }

    tampered = ("a" if task["task_token"][0] != "a" else "b") + task["task_token"][1:]
    assert upload(client, task_token=tampered).status_code == 400
    assert upload(client, task_id="damals", task_token=task["task_token"]).status_code == 400


def test_offline_upload_metadata_keeps_task_link_and_capture_snapshot(tmp_path):
    tasks = TestTaskStore([{"id": "abend", "text": "Mach ein Gruppenfoto."}])
    store = LocalStore(tmp_path)
    client = TestClient(
        create_app(Settings("TEST-CODE", "test-signing-key"), store, tasks),
        base_url="https://testserver",
    )
    login(client)
    task = client.get("/api/tasks").json()["tasks"][0]
    capture = {
        "source": "camera",
        "captured_at": 1_700_000_000_000,
        "queued_at": 1_700_000_001_000,
        "task_id": task["id"],
    }

    response = upload(client, task_token=task["task_token"], client_metadata=capture)

    assert response.status_code == 201
    assert response.json()["metadata"] == {
        "task": {"id": "abend", "text": "Mach ein Gruppenfoto."},
        "capture": {
            "source": "camera",
            "captured_at": 1_700_000_000_000,
            "queued_at": 1_700_000_001_000,
        },
    }
    wrong_task = {**capture, "task_id": "andere-aufgabe"}
    assert upload(client, task_token=task["task_token"], client_metadata=wrong_task).status_code == 400


def test_raw_offline_upload_keeps_id_task_metadata_and_retry_safety(tmp_path):
    tasks = TestTaskStore([{"id": "safari", "text": "Mach ein Gruppenfoto."}])
    store = LocalStore(tmp_path)
    client = TestClient(
        create_app(Settings("TEST-CODE", "test-signing-key"), store, tasks),
        base_url="https://testserver",
    )
    login(client)
    task = client.get("/api/tasks").json()["tasks"][0]
    photo_id = str(uuid.uuid4())
    raw = picture()
    capture = {
        "source": "camera",
        "captured_at": 1_700_000_000_000,
        "queued_at": 1_700_000_001_000,
        "task_id": task["id"],
    }

    created = raw_upload(
        client,
        raw,
        photo_id,
        task_token=task["task_token"],
        client_metadata=capture,
    )
    repeated = raw_upload(
        client,
        raw,
        photo_id,
        task_token=task["task_token"],
        client_metadata=capture,
    )

    assert created.status_code == 201
    assert repeated.status_code == 200
    assert created.json()["id"] == photo_id
    assert created.json()["metadata"]["task"] == {
        "id": "safari",
        "text": "Mach ein Gruppenfoto.",
    }
    assert created.json()["metadata"]["capture"] == {
        "source": "camera",
        "captured_at": 1_700_000_000_000,
        "queued_at": 1_700_000_001_000,
    }
    assert len(store.published()) == 1


def test_full_offline_outbox_of_25_photos_drains_with_task_and_capture_metadata(tmp_path):
    tasks = TestTaskStore([{"id": "abend", "text": "Mach ein Gruppenfoto."}])
    store = LocalStore(tmp_path)
    client = TestClient(
        create_app(Settings("TEST-CODE", "test-signing-key"), store, tasks),
        base_url="https://testserver",
    )
    login(client)
    task = client.get("/api/tasks").json()["tasks"][0]

    for index in range(25):
        response = upload(
            client,
            photo_id=str(uuid.uuid4()),
            task_token=task["task_token"],
            client_metadata={
                "source": "camera",
                "captured_at": 1_700_000_000_000 + index,
                "queued_at": 1_700_000_100_000 + index,
                "task_id": task["id"],
            },
        )
        assert response.status_code == 201
        assert response.json()["metadata"]["task"] == {"id": "abend", "text": "Mach ein Gruppenfoto."}
        assert response.json()["metadata"]["capture"]["source"] == "camera"

    assert len(store.published()) == 25


def test_task_snapshot_key_survives_party_code_rotation(tmp_path):
    tasks = TestTaskStore([{"id": "abend", "text": "Ein gemeinsames Foto."}])
    store = LocalStore(tmp_path)
    first = TestClient(
        create_app(
            Settings("TEST-CODE", "old-session-key", task_snapshot_key="stable-task-key"),
            store,
            tasks,
        ),
        base_url="https://testserver",
    )
    login(first)
    token = first.get("/api/tasks").json()["tasks"][0]["task_token"]

    rotated = TestClient(
        create_app(
            Settings("NEW-CODE", "new-session-key", task_snapshot_key="stable-task-key"),
            store,
            TestTaskStore([]),
        ),
        base_url="https://testserver",
    )
    assert rotated.post(
        "/api/session", json={"code": "new code"}, headers=ORIGIN
    ).status_code == 200
    assert upload(rotated, task_token=token).status_code == 201


def test_task_snapshot_is_stored_with_photo_and_listed(env):
    client, _, store = env
    login(client)
    task = client.get("/api/tasks/random").json()

    response = upload(client, task_id=task["id"])

    assert response.status_code == 201
    record = response.json()
    assert record["schema_version"] == 1
    assert record["metadata"] == {"task": task}
    stored = json.loads(store.read(f"published/{record['id']}.json"))
    assert stored["metadata"] == {"task": task}
    listed = client.get("/api/photos").json()["photos"][0]
    assert listed["metadata"] == {"task": task}
    assert listed["task"] == task
    assert store.info(f"published/{record['id']}.json").metadata["fotovibe_metadata"]
    original_metadata = store.info(f"photos/{record['id']}/original").metadata
    assert original_metadata["task_id"] == task["id"]
    assert original_metadata["task_text"] == task["text"]
    assert original_metadata["fotovibe_metadata"]


def test_gallery_exposes_photo_dimensions_for_format_aware_previews(env):
    client, _, _ = env
    login(client)

    record = upload(client, picture()).json()
    listed = client.get("/api/photos").json()["photos"][0]

    assert (listed["width"], listed["height"]) == (record["width"], record["height"])
    assert listed["width"] > listed["height"]


def test_gallery_reads_task_metadata_from_older_original_object(tmp_path):
    store = LocalStore(tmp_path)
    app = create_app(Settings("TEST-CODE", "test-signing-key"), store)
    client = TestClient(app, base_url="https://testserver")
    login(client)
    photo_id = str(uuid.uuid4())
    store.put(
        f"photos/{photo_id}/original",
        picture(),
        "image/jpeg",
        {"task_id": "altmodisch", "task_text": "Zeig dein bestes Partygesicht."},
    )
    store.put(
        f"published/{photo_id}.json",
        json.dumps({"id": photo_id, "metadata": {}}).encode(),
        "application/json",
    )

    listed = client.get("/api/photos").json()["photos"]

    assert listed[0]["task"] == {
        "id": "altmodisch",
        "text": "Zeig dein bestes Partygesicht.",
    }


def test_stream_lists_photos_newest_first_with_caption_data(env):
    client, _, _ = env

    assert client.get("/api/photos/stream").status_code == 401
    login(client)
    client.post("/api/users/me", json={"name": "Lea"}, headers=ORIGIN)
    task = client.get("/api/tasks/random").json()
    with_task = upload(client, picture(color="red"), task_id=task["id"]).json()["id"]
    plain = upload(client, picture(color="blue")).json()["id"]
    client.post(f"/api/photos/{with_task}/reactions", json={"emoji": "❤️"}, headers=ORIGIN)

    result = client.get("/api/photos/stream")
    assert result.status_code == 200
    payload = result.json()
    listed = payload["photos"]
    photos = {photo["id"]: photo for photo in listed}

    # Every screen builds the same rotation from this list and captions each
    # photo straight out of it, so order and caption data both have to be here.
    assert set(photos) == {with_task, plain}
    timestamps = [photo["created_at"] for photo in listed]
    assert timestamps == sorted(timestamps, reverse=True)
    assert photos[with_task]["task"] == task["text"]
    assert photos[with_task]["author"] == "Lea"
    assert photos[with_task]["reactions"] == [{"emoji": "❤️", "count": 1}]
    assert photos[plain]["task"] is None
    assert photos[plain]["reactions"] == []
    assert datetime.fromisoformat(payload["now"]).tzinfo is not None


def test_upload_rejects_unknown_task_without_publishing(env):
    client, _, store = env
    login(client)

    response = upload(client, task_id="nicht-vorhanden")

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Diese Foto-Aufgabe ist nicht mehr verfügbar. Bitte neu ziehen."
    )
    assert not store.published()


def test_upload_id_cannot_be_reused_with_different_task(tmp_path):
    tasks = TestTaskStore(
        [
            {"id": "erste", "text": "Erste Aufgabe"},
            {"id": "zweite", "text": "Zweite Aufgabe"},
        ]
    )
    app = create_app(
        Settings("TEST-CODE", "test-signing-key"),
        LocalStore(tmp_path),
        tasks,
    )
    client = TestClient(app, base_url="https://testserver")
    login(client)
    photo_id = str(uuid.uuid4())
    raw = picture()

    assert upload(client, raw, photo_id, "erste").status_code == 201
    assert upload(client, raw, photo_id, "erste").status_code == 200
    assert upload(client, raw, photo_id, "zweite").status_code == 409


def test_legacy_offline_upload_keys_map_to_retry_safe_photo_ids(env):
    client, _, store = env
    login(client)
    legacy_key = "old-indexeddb-entry"
    first = picture()
    second = picture(color="blue")

    created = upload(client, first, legacy_key)
    repeated = upload(client, first, legacy_key)
    another = upload(client, second, "another-indexeddb-entry")

    assert created.status_code == 201
    assert repeated.status_code == 200
    assert another.status_code == 201
    assert created.json()["id"] != legacy_key
    assert another.json()["id"] != created.json()["id"]
    assert len(store.published()) == 2


def test_concurrent_duplicate_uploads_across_instances(env):
    client, _, store = env
    other = TestClient(
        create_app(Settings("TESTCODE", "test-signing-key"), store), base_url="https://testserver"
    )
    login(client)
    login(other)
    photo_id = str(uuid.uuid4())
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda c: upload(c, photo_id=photo_id), [client, other]))
    assert sorted(response.status_code for response in responses) == [200, 201]
    assert len(store.published()) == 1


def test_different_photo_conversions_run_in_parallel(tmp_path, monkeypatch):
    original_derivatives = app_module.derivatives
    conversions_started = threading.Barrier(2)

    def synchronized_derivatives(raw):
        conversions_started.wait(timeout=5)
        return original_derivatives(raw)

    monkeypatch.setattr(app_module, "derivatives", synchronized_derivatives)
    app = create_app(Settings("TEST-CODE", "test-signing-key"), LocalStore(tmp_path))
    clients = [
        TestClient(app, base_url="https://testserver"),
        TestClient(app, base_url="https://testserver"),
    ]
    for client in clients:
        login(client)

    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(raw_upload, clients))

    assert [response.status_code for response in responses] == [201, 201]


def test_login_rate_limit(env):
    client, _, _ = env
    for _ in range(30):
        assert (
            client.post("/api/session", json={"code": "wrong"}, headers=ORIGIN).status_code == 401
        )
    response = client.post("/api/session", json={"code": "wrong"}, headers=ORIGIN)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


def test_upload_rate_limit(env):
    client, _, _ = env
    login(client)
    photo_id = str(uuid.uuid4())
    for _ in range(30):
        assert upload(client, photo_id=photo_id).status_code in {200, 201}
    assert upload(client).status_code == 429


def test_security_headers_and_missing_photos(env):
    client, _, _ = env
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["x-frame-options"] == "DENY"
    assert "script-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"
    worker = client.get("/service-worker.js")
    assert worker.status_code == 200
    assert worker.headers["service-worker-allowed"] == "/"
    assert worker.headers["cache-control"] == "no-cache"
    assert client.get("/manifest.webmanifest").status_code == 200
    login(client)
    assert client.get(f"/api/photos/{uuid.uuid4()}/original").status_code == 404
