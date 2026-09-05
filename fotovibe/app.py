import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import threading
import time
import unicodedata
import uuid
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.api_core.exceptions import GoogleAPIError
from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from .images import MAX_BYTES, derivatives, soften
from .storage import CloudStore, LocalStore
from .tasks import FirestoreTaskStore, LocalTaskStore

ROOT = Path(__file__).resolve().parent.parent
SESSION_AGE = 7 * 24 * 60 * 60
COOKIE = "fotovibe_session"
TASK_ID_PATTERN = re.compile(r"[a-z0-9-]{1,100}")
NAME_MAX_LENGTH = 40
ADMIN_DEVICE_ID_PATTERN = re.compile(r"d_[a-f0-9]{12}")
DEFAULT_ADMIN_DEVICE_IDS = ("d_df9eabe35ce8", "d_41b14e411f97", "d_d63b34eb51bf")
REACTIONS = {
    "heart": "❤️",
    "laugh": "😂",
    "love": "😍",
    "clap": "👏",
    "fire": "🔥",
}
COMMENT_MAX_LENGTH = 500
# What makes a photo hot. A written comment took more effort than a tap, so it
# counts double. One hot photo per ten, capped, so it stays an honour rather
# than every third picture on the wall. Resolved here and nowhere else: the
# television, the admin panel and the gallery search all read the answer.
HOT_COMMENT_WEIGHT = 2
HOT_EVERY = 10
HOT_AUTOMATIC_MAX = 8


def hot_score(entry):
    interactions = entry.get("interactions") or {}
    reactions = sum(item.get("count", 0) for item in interactions.get("reactions", []))
    return reactions + HOT_COMMENT_WEIGHT * interactions.get("comments_count", 0)


def resolve_hot(entries):
    """Which photos are hot, from the admins' rulings and the party's reactions.

    An admin's ruling wins in both directions: a photo they called hot is always
    in, one they ruled out is always out, however popular it gets. Everything
    else is ranked on reactions, and the best of them fill a bounded number of
    places. Hand-picked photos come on top of that count rather than pushing a
    celebrated one out -- an admin adding a favourite did not ask to lose one.
    """
    on_wall = [entry for entry in entries if entry.get("in_stream", True)]
    chosen = {entry["id"] for entry in on_wall if entry.get("hot_ruling") is True}
    rated = [
        entry
        for entry in on_wall
        if entry.get("hot_ruling") is None and hot_score(entry) > 0
    ]
    # Ties broken on values, never on arrival order, so every screen agrees.
    # Sorting is stable, so the first pass settles the ties the second leaves.
    rated.sort(key=lambda entry: entry["id"])
    rated.sort(key=lambda entry: (hot_score(entry), entry["created_at"]), reverse=True)
    wanted = min(HOT_AUTOMATIC_MAX, max(1, round(len(on_wall) / HOT_EVERY)))
    return chosen | {entry["id"] for entry in rated[:wanted]}
log = logging.getLogger("fotovibe")


def normalize_task(task_id=None, task_text=None):
    """Return the small, safe task shape exposed to party guests."""
    task_id = task_id.strip().lower() if isinstance(task_id, str) else None
    task_text = task_text.strip() if isinstance(task_text, str) else None
    task_id = task_id if task_id and TASK_ID_PATTERN.fullmatch(task_id) else None
    task_text = task_text if task_text and len(task_text) <= 500 else None
    if not task_id and not task_text:
        return None
    return {"id": task_id, "text": task_text}


def task_from_values(value=None, task_id=None, task_text=None):
    """Accept task objects, JSON metadata, and flat GCS metadata values."""
    if isinstance(value, dict):
        task_id = value.get("id", value.get("task_id", value.get("taskId", task_id)))
        task_text = value.get("text", value.get("task_text", value.get("taskText", task_text)))
    elif isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError):
            decoded = None
        if isinstance(decoded, dict):
            return task_from_values(decoded, task_id, task_text)
        task_text = value
    return normalize_task(task_id, task_text)


def task_from_record(record, metadata=None):
    """Read task information from a manifest or a GCS object's metadata."""
    record = record if isinstance(record, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}

    task = task_from_values(record.get("task"))
    if task:
        return task

    task = task_from_values(
        metadata.get("task") or metadata.get("photo_task") or metadata.get("photoTask")
    )
    if task:
        return task

    def value(source, *names):
        for name in names:
            if name in source:
                return source[name]
            normalized_name = name.replace("-", "_").lower()
            for key, candidate in source.items():
                if str(key).replace("-", "_").lower() == normalized_name:
                    return candidate
        return None

    return task_from_values(
        task_id=value(record, "task_id", "taskId") or value(metadata, "task_id", "taskId"),
        task_text=value(record, "task_text", "taskText")
        or value(metadata, "task_text", "taskText"),
    )


def author_from_record(record, metadata=None):
    """Return only the public author snapshot stored with a photo."""
    record = record if isinstance(record, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}
    author = record.get("author") or metadata.get("author")
    if not isinstance(author, dict):
        return None
    user_id, name = author.get("id"), author.get("name")
    if (
        not isinstance(user_id, str)
        or not user_id.startswith("u_")
        or not isinstance(name, str)
    ):
        return None
    name = " ".join(name.split())
    if not 2 <= len(name) <= NAME_MAX_LENGTH:
        return None
    return {"id": user_id, "name": name}


def search_key(value):
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(char for char in value if not unicodedata.combining(char))
    return value.casefold()


def typo_distance(left, right):
    """Small, bounded Levenshtein calculation for party-gallery search words."""
    if abs(len(left) - len(right)) > 2:
        return 3
    previous = list(range(len(right) + 1))
    for index, left_char in enumerate(left, start=1):
        current = [index]
        for column, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def fuzzy_matches(query, value):
    query = search_key(query).strip()
    value = search_key(value)
    if not query:
        return True
    if query in value:
        return True
    words = re.findall(r"[\w]+", value)
    for word in re.findall(r"[\w]+", query):
        if not any(
            word in candidate
            or candidate in word
            or (len(word) >= 4 and typo_distance(word, candidate) <= (1 if len(word) < 7 else 2))
            for candidate in words
        ):
            return False
    return True


@dataclass
class Settings:
    party_code: str
    session_key: str
    secure_cookies: bool = True
    test_codes: tuple[str, ...] = ()
    admin_device_ids: tuple[str, ...] = DEFAULT_ADMIN_DEVICE_IDS
    task_snapshot_key: str | None = None

    @classmethod
    def from_env(cls):
        secret_file = os.environ.get("AUTH_SECRET_FILE")
        if secret_file:
            values = json.loads(Path(secret_file).read_text())
            test_codes = values.get("test_codes", [])
            if not isinstance(test_codes, list) or not all(
                isinstance(code, str) for code in test_codes
            ):
                raise RuntimeError("test_codes in AUTH_SECRET_FILE must be a list of strings")
            admin_device_ids = values.get("admin_device_ids", list(DEFAULT_ADMIN_DEVICE_IDS))
            if not isinstance(admin_device_ids, list) or not all(
                isinstance(device_id, str) and ADMIN_DEVICE_ID_PATTERN.fullmatch(device_id)
                for device_id in admin_device_ids
            ):
                raise RuntimeError("admin_device_ids in AUTH_SECRET_FILE must be a list of device IDs")
            task_snapshot_key = values.get("task_snapshot_key", values["session_key"])
            if not isinstance(task_snapshot_key, str) or not task_snapshot_key:
                raise RuntimeError("task_snapshot_key in AUTH_SECRET_FILE must be a non-empty string")
            return cls(
                values["party_code"],
                values["session_key"],
                True,
                tuple(test_codes),
                tuple(admin_device_ids),
                task_snapshot_key,
            )
        if os.environ.get("FOTOVIBE_DEV") == "1":
            return cls(
                os.environ.get("PARTY_CODE", "1234"),
                "development-only-key",
                False,
                ("1234",),
                DEFAULT_ADMIN_DEVICE_IDS,
                "development-only-task-snapshot-key",
            )
        raise RuntimeError("AUTH_SECRET_FILE is required outside explicit local development")


def normalized(code):
    return code.upper().replace("-", "").replace(" ", "").strip()


class RateLimiter:
    """Best-effort per-instance limits; not a global quota or billing cap."""

    def __init__(self):
        self.values = OrderedDict()
        self.lock = threading.Lock()

    def check(self, key, limit, consume=True):
        with self.lock:
            now = time.monotonic()
            started, count = self.values.get(key, (now, 0))
            if now - started >= 60:
                started, count = now, 0
            if count >= limit:
                raise HTTPException(
                    429,
                    "Bitte eine Minute warten und erneut versuchen.",
                    headers={"Retry-After": "60"},
                )
            self.values[key] = (started, count + int(consume))
            self.values.move_to_end(key)
            while len(self.values) > 10000:
                self.values.popitem(last=False)


class SecurityMiddleware:
    def __init__(self, app, secure):
        self.app, self.secure = app, secure

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        path = scope["path"]
        mutation = scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}
        if mutation:
            origin = urlsplit(headers.get(b"origin", b"").decode())
            expected_scheme = "https" if self.secure else "http"
            if (
                origin.scheme != expected_scheme
                or origin.netloc != headers.get(b"host", b"").decode()
            ):
                return await JSONResponse({"detail": "Diese Anfrage ist nicht erlaubt."}, 403)(
                    scope, receive, send
                )
        limit = (
            4096
            if path in {"/api/session", "/api/session/restore", "/api/users/me"}
            else MAX_BYTES + 1024 * 1024
        )
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = limit + 1
        if length < 0 or length > limit:
            return await JSONResponse({"detail": "Die Datei ist zu groß (maximal 25 MiB)."}, 413)(
                scope, receive, send
            )
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise StarletteHTTPException(413, "Die Datei ist zu groß (maximal 25 MiB).")
            return message

        async def secure_send(message):
            if message["type"] == "http.response.start":
                extra = [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"permissions-policy", b"camera=(self), microphone=(), geolocation=()"),
                    (b"x-robots-tag", b"noindex, nofollow, noarchive"),
                    (
                        b"content-security-policy",
                        b"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                    ),
                ]
                if self.secure:
                    extra.append((b"strict-transport-security", b"max-age=31536000"))
                if not any(k.lower() == b"cache-control" for k, _ in message.get("headers", [])):
                    extra.append((b"cache-control", b"no-store"))
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        await self.app(scope, limited_receive, secure_send)


def create_app(settings=None, store=None, task_store=None):
    settings = settings or Settings.from_env()
    store = store or (
        LocalStore(".local/photos")
        if not settings.secure_cookies
        else CloudStore(os.environ["PHOTO_BUCKET"])
    )
    database = os.environ.get("FIRESTORE_DATABASE")
    task_store = task_store or (
        FirestoreTaskStore(os.environ["GOOGLE_CLOUD_PROJECT"], database)
        if database
        else LocalTaskStore(ROOT / "infra/tasks.json")
    )
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SecurityMiddleware, secure=settings.secure_cookies)
    serializer = URLSafeTimedSerializer(settings.session_key, salt="fotovibe-session")
    cursors = URLSafeTimedSerializer(settings.session_key, salt="fotovibe-pages")
    task_snapshots = URLSafeTimedSerializer(
        settings.task_snapshot_key or settings.session_key,
        salt="fotovibe-task-snapshot",
    )
    code = normalized(settings.party_code)
    accepted_codes = tuple(
        dict.fromkeys([code, *(normalized(value) for value in settings.test_codes)])
    )
    epoch = hashlib.sha256(code.encode()).hexdigest()
    limiter = RateLimiter()
    conversion_locks_guard = threading.Lock()
    conversion_locks = {}
    cache_lock = threading.Lock()
    cache = {"until": 0, "photos": []}
    app.state.serializer = serializer
    app.state.store = store
    app.state.task_store = task_store

    @contextmanager
    def photo_conversion_lock(photo_id):
        """Serialize retries of one photo while allowing other photos in parallel."""
        with conversion_locks_guard:
            lock, users = conversion_locks.get(photo_id, (threading.Lock(), 0))
            conversion_locks[photo_id] = (lock, users + 1)
        lock.acquire()
        try:
            yield
        finally:
            lock.release()
            with conversion_locks_guard:
                current_lock, users = conversion_locks[photo_id]
                if users == 1:
                    del conversion_locks[photo_id]
                else:
                    conversion_locks[photo_id] = (current_lock, users - 1)

    def session_data(request):
        try:
            data = serializer.loads(request.cookies.get(COOKIE, ""), max_age=SESSION_AGE)
            if (
                data["epoch"] != epoch
                or not isinstance(data["sid"], str)
                or not isinstance(data["device"], str)
            ):
                raise BadSignature("invalid session")
            return data
        except (BadSignature, KeyError, TypeError):
            raise HTTPException(401, "Bitte den Party-Code eingeben.") from None

    def session(request):
        return session_data(request)["sid"]

    def valid_device_id(value):
        try:
            return str(uuid.UUID(value))
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Die Gerätekennung ist ungültig. Bitte die Seite neu laden.") from None

    def device_key(device_id):
        """Create a party-scoped, non-reversible key for a browser device."""
        return hashlib.sha256(f"{epoch}:{device_id}".encode()).hexdigest()

    def user_key(device):
        return f"users/{device}.json"

    def user_upload_prefix(device):
        return f"users/{device}/uploads/"

    def user_upload_key(device, photo_id):
        return f"{user_upload_prefix(device)}{photo_id}.json"

    def user_reconciled_key(device):
        return f"users/{device}/reconciled-authors-v1.json"

    def admin_role_prefix(device):
        return f"admin_roles/{device}/"

    def admin_role_states():
        """Return the latest append-only role decision for each device.

        The configured device IDs remain the initial admin allowlist. Role events
        let the panel change that allowlist without requiring a Secret Manager
        update on every click, and survive redeploys because they live in the
        same immutable object store as the party data.
        """
        latest = {}
        for obj in store.list_prefix("admin_roles/"):
            match = re.fullmatch(r"admin_roles/([a-f0-9]{64})/([^/]+)\.json", obj.name)
            if not match:
                continue
            try:
                record = json.loads(store.read(obj.name) or b"")
            except (TypeError, ValueError):
                continue
            if not isinstance(record, dict) or not isinstance(record.get("is_admin"), bool):
                continue
            device = match.group(1)
            previous = latest.get(device)
            if previous is None or (obj.created or "", obj.name) > previous[0]:
                latest[device] = ((obj.created or "", obj.name), record["is_admin"])
        return {device: value for device, (_, value) in latest.items()}

    def is_admin(device, role_states=None):
        role_states = admin_role_states() if role_states is None else role_states
        return role_states.get(device, "d_" + device[:12] in settings.admin_device_ids)

    def effective_admin_public_ids(role_states):
        """Build the public IDs used for last-admin protection."""
        public_ids = set(settings.admin_device_ids)
        for device, enabled in role_states.items():
            public_id = "d_" + device[:12]
            if enabled:
                public_ids.add(public_id)
            else:
                public_ids.discard(public_id)
        return public_ids

    def normalized_name(value):
        if not isinstance(value, str):
            raise HTTPException(400, "Bitte gib deinen Namen ein.")
        name = " ".join(value.split())
        if not 2 <= len(name) <= NAME_MAX_LENGTH or any(ord(char) < 32 for char in name):
            raise HTTPException(400, "Bitte wähle einen Namen mit 2 bis 40 Zeichen.")
        return name

    def user_for_device(device):
        raw = store.read(user_key(device))
        if raw is None:
            return None
        try:
            record = json.loads(raw)
        except (TypeError, ValueError):
            log.warning("invalid_user_record device=%s", device[:12])
            return None
        if not isinstance(record, dict):
            return None
        user_id, name = record.get("id"), record.get("name")
        if not isinstance(user_id, str) or not user_id.startswith("u_"):
            return None
        try:
            name = normalized_name(name)
        except HTTPException:
            return None
        return {"id": user_id, "name": name}

    def set_session_cookie(response, device):
        token = serializer.dumps({"sid": str(uuid.uuid4()), "device": device, "epoch": epoch})
        response.set_cookie(
            COOKIE,
            token,
            max_age=SESSION_AGE,
            secure=settings.secure_cookies,
            httponly=True,
            samesite="strict",
            path="/",
        )

    def valid_id(value):
        try:
            if str(uuid.UUID(value)) != value:
                raise TypeError
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Ungültige Foto-ID.") from None
        return value

    def upload_photo_id(value, device):
        """Use a supplied retry UUID or allocate a fresh ID for older clients."""
        if value is None:
            return str(uuid.uuid4())
        try:
            return valid_id(value)
        except HTTPException:
            if (
                not isinstance(value, str)
                or not value
                or len(value) > 200
                or not re.fullmatch(r"[A-Za-z0-9._:-]+", value)
            ):
                raise
            # Some already-installed PWAs sent their local IndexedDB key. Map
            # that key once for retry safety; current clients never use this
            # compatibility path and allocate a fresh UUID before uploading.
            return str(uuid.uuid5(uuid.NAMESPACE_URL, f"fotovibe-legacy:{device}:{value}"))

    def capture_metadata(value):
        """Accept the small, privacy-safe capture snapshot from the offline queue."""
        if value is None:
            return None
        if not isinstance(value, str) or len(value) > 1000:
            raise HTTPException(400, "Die Foto-Metadaten sind ungültig.")
        try:
            metadata = json.loads(value)
        except (TypeError, ValueError):
            raise HTTPException(400, "Die Foto-Metadaten sind ungültig.") from None
        if not isinstance(metadata, dict) or set(metadata) - {
            "source", "captured_at", "queued_at", "task_id"
        }:
            raise HTTPException(400, "Die Foto-Metadaten sind ungültig.")
        source = metadata.get("source")
        captured_at = metadata.get("captured_at")
        queued_at = metadata.get("queued_at")
        if (
            source not in {"camera", "library", "fallback"}
            or isinstance(captured_at, bool)
            or not isinstance(captured_at, int)
            or isinstance(queued_at, bool)
            or not isinstance(queued_at, int)
            or not 0 <= captured_at <= 9_007_199_254_740_991
            or not 0 <= queued_at <= 9_007_199_254_740_991
        ):
            raise HTTPException(400, "Die Foto-Metadaten sind ungültig.")
        task_id = metadata.get("task_id")
        if task_id is not None and (
            not isinstance(task_id, str) or not TASK_ID_PATTERN.fullmatch(task_id)
        ):
            raise HTTPException(400, "Die Foto-Metadaten sind ungültig.")
        return {
            "source": source,
            "captured_at": captured_at,
            "queued_at": queued_at,
            **({"task_id": task_id} if task_id is not None else {}),
        }

    def task_snapshot(task):
        """Sign the wording shown to a guest for delayed, offline uploads."""
        return task_snapshots.dumps({"id": task["id"], "text": task["text"]})

    def resolve_task(task_id=None, task_token=None):
        if task_token is not None:
            if task_id is not None or not isinstance(task_token, str):
                raise HTTPException(400, "Die Foto-Aufgabe ist ungültig.")
            try:
                payload = task_snapshots.loads(task_token)
            except BadSignature:
                raise HTTPException(400, "Die gespeicherte Foto-Aufgabe ist ungültig.") from None
            task = normalize_task(payload.get("id"), payload.get("text")) if isinstance(payload, dict) else None
            if task is None:
                raise HTTPException(400, "Die gespeicherte Foto-Aufgabe ist ungültig.")
            return task
        if task_id is None:
            return None
        if not isinstance(task_id, str) or not re.fullmatch(r"[a-z0-9-]{1,100}", task_id):
            raise HTTPException(400, "Die Foto-Aufgabe ist ungültig. Bitte neu auswählen.")
        for task in task_store.enabled():
            if task["id"] == task_id:
                # Save the current wording so historical photos do not change when
                # a Firestore task is edited later.
                return {"id": task["id"], "text": task["text"]}
        raise HTTPException(400, "Diese Foto-Aufgabe ist nicht mehr verfügbar. Bitte neu ziehen.")

    def metadata_index(metadata):
        raw = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode()

    def indexed_metadata(obj):
        encoded = obj.metadata.get("fotovibe_metadata")
        if not encoded:
            return None
        try:
            value = json.loads(base64.urlsafe_b64decode(encoded).decode())
        except (ValueError, TypeError, UnicodeDecodeError):
            log.warning("invalid_photo_metadata_index object=%s", obj.name)
            return None
        return value if isinstance(value, dict) else None

    def manifest(photo_id):
        raw = store.read(f"published/{photo_id}.json")
        if raw is None:
            raise HTTPException(404, "Dieses Foto ist nicht verfügbar.")
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            raise HTTPException(404, "Dieses Foto ist nicht verfügbar.") from None
        return value if isinstance(value, dict) else {}

    def interaction_prefix(photo_id=None):
        return f"interactions/{photo_id}/" if photo_id else "interactions/"

    def reaction_states(objects):
        """Return the latest immutable on/off event for every device reaction."""
        states = {}
        for obj in objects:
            metadata = obj.metadata or {}
            photo_id = metadata.get("photo_id")
            device = metadata.get("device")
            reaction_id = metadata.get("reaction")
            if (
                metadata.get("kind") != "reaction"
                or not isinstance(photo_id, str)
                or not isinstance(device, str)
                or reaction_id not in REACTIONS
            ):
                continue
            try:
                valid_id(photo_id)
            except HTTPException:
                continue
            recorded_at = metadata.get("recorded_at")
            recorded_at = recorded_at if isinstance(recorded_at, str) else obj.created
            active = metadata.get("active") not in {False, "0", "false", "False"}
            key = (photo_id, device, reaction_id)
            if key not in states or recorded_at >= states[key][0]:
                states[key] = (recorded_at, active)
        return states

    def interaction_summaries():
        summaries = {}
        objects = store.list_prefix(interaction_prefix())
        for obj in objects:
            metadata = obj.metadata or {}
            photo_id = metadata.get("photo_id")
            kind = metadata.get("kind")
            if not isinstance(photo_id, str) or kind not in {"reaction", "comment"}:
                continue
            try:
                valid_id(photo_id)
            except HTTPException:
                continue
            summary = summaries.setdefault(photo_id, {"counts": {}, "comments_count": 0})
            if kind == "comment":
                summary["comments_count"] += 1
        for (photo_id, _device, reaction_id), (_recorded_at, active) in reaction_states(objects).items():
            if active:
                summary = summaries.setdefault(photo_id, {"counts": {}, "comments_count": 0})
                summary["counts"][reaction_id] = summary["counts"].get(reaction_id, 0) + 1
        return summaries

    def public_interactions(summary):
        summary = summary or {"counts": {}, "comments_count": 0}
        return {
            "reactions": [
                {"emoji": emoji, "count": summary["counts"].get(reaction_id, 0)}
                for reaction_id, emoji in REACTIONS.items()
                if summary["counts"].get(reaction_id, 0)
            ],
            "comments_count": summary["comments_count"],
        }

    def interaction_details(photo_id, device):
        summary = {"counts": {}, "comments_count": 0}
        mine = set()
        comments = []
        objects = store.list_prefix(interaction_prefix(photo_id))
        for (event_photo_id, event_device, reaction_id), (_recorded_at, active) in reaction_states(
            objects
        ).items():
            if event_photo_id != photo_id or not active:
                continue
            summary["counts"][reaction_id] = summary["counts"].get(reaction_id, 0) + 1
            if event_device == device:
                mine.add(REACTIONS[reaction_id])
        for obj in objects:
            metadata = obj.metadata or {}
            kind = metadata.get("kind")
            if kind != "comment":
                continue
            raw = store.read(obj.name)
            try:
                comment = json.loads(raw)
            except (TypeError, ValueError):
                continue
            author = author_from_record(comment)
            text = comment.get("text") if isinstance(comment, dict) else None
            created_at = comment.get("created_at") if isinstance(comment, dict) else None
            if author and isinstance(text, str) and isinstance(created_at, str):
                comments.append({"author": author, "text": text, "created_at": created_at})
                summary["comments_count"] += 1
        comments.sort(key=lambda comment: comment["created_at"])
        return {**public_interactions(summary), "mine": sorted(mine), "comments": comments}

    def social_user(data):
        user = user_for_device(data["device"])
        if user is None:
            raise HTTPException(409, "Bitte lege zuerst deinen Namen fest.")
        return user

    def normalized_comment(value):
        if not isinstance(value, str):
            raise HTTPException(400, "Bitte schreibe einen Kommentar.")
        text = " ".join(value.split())
        if not 1 <= len(text) <= COMMENT_MAX_LENGTH:
            raise HTTPException(400, "Kommentare dürfen bis zu 500 Zeichen lang sein.")
        return text

    def hidden_photo_ids():
        hidden = set()
        for obj in store.list_prefix("hidden/"):
            if obj.name.startswith("hidden/") and obj.name.endswith(".json"):
                photo_id = Path(obj.name).stem
                try:
                    hidden.add(valid_id(photo_id))
                except HTTPException:
                    log.warning("invalid_hidden_photo_marker object=%s", obj.name)
        return hidden

    def latest_photo_switch(prefix, kind):
        """The latest position of one admin switch, per photo.

        Both switches an admin has over the stream -- calling a photo hot and
        taking one off the wall -- come and go during an evening, and the object
        store never mutates, so each click appends an event and the newest one
        for a photo wins. The state rides in the object metadata, the way
        reactions do, which keeps this to a single listing instead of a read per
        event. A photo with no event at all is simply absent.
        """
        latest = {}
        for obj in store.list_prefix(f"{prefix}/"):
            metadata = obj.metadata or {}
            photo_id = metadata.get("photo_id")
            if metadata.get("kind") != kind or not isinstance(photo_id, str):
                continue
            try:
                valid_id(photo_id)
            except HTTPException:
                log.warning("invalid_%s_marker object=%s", kind, obj.name)
                continue
            recorded_at = metadata.get("recorded_at")
            recorded_at = recorded_at if isinstance(recorded_at, str) else obj.created
            active = metadata.get("active") not in {False, "0", "false", "False"}
            previous = latest.get(photo_id)
            if previous is None or (recorded_at, obj.name) >= previous[0]:
                latest[photo_id] = ((recorded_at, obj.name), active)
        return {photo_id: active for photo_id, (_, active) in latest.items()}

    def hot_choices():
        """How an admin has ruled on each photo: hot, not hot, or no ruling.

        A photo nobody has ruled on is absent here, and the party's reactions
        decide it instead. A ruling overrides them in either direction, which
        is what lets an admin take a photo out of the rotation that the votes
        would otherwise keep in it.
        """
        return latest_photo_switch("pins", "pin")

    def off_stream_photo_ids():
        """Photos an admin took off the wall. They stay in the gallery."""
        return {
            photo_id
            for photo_id, active in latest_photo_switch("stream_hidden", "stream_hidden").items()
            if active
        }

    def gallery_entries(include_hidden=False):
        """Build the gallery index, including task metadata from the bucket."""
        entries = []
        hidden_ids = hidden_photo_ids()
        hot_ruling = hot_choices()
        off_stream_ids = off_stream_photo_ids()
        social = interaction_summaries()
        for obj in store.published():
            photo_id = Path(obj.name).stem
            if photo_id in hidden_ids and not include_hidden:
                continue
            indexed = indexed_metadata(obj)
            task = task_from_record(indexed or {})
            author = author_from_record(indexed or {})
            record = None
            width = obj.metadata.get("width")
            height = obj.metadata.get("height")
            try:
                width, height = int(width), int(height)
            except (TypeError, ValueError):
                width = height = 0
            # Older objects have no compact index. Read their manifest only as a
            # compatibility fallback. It also supplies the format of older photos.
            if indexed is None or width < 1 or height < 1:
                try:
                    record = manifest(photo_id)
                except HTTPException:
                    log.warning("invalid_published_manifest object=%s", obj.name)
                    continue
                if indexed is None:
                    task = task_from_record(record)
                    author = author_from_record(record)
                    if task is None:
                        task = task_from_record(record.get("metadata", {}))
                    if author is None:
                        author = author_from_record(record.get("metadata", {}))
                width = record.get("width") if isinstance(record, dict) else 0
                height = record.get("height") if isinstance(record, dict) else 0
                width = width if isinstance(width, int) and width > 0 else 0
                height = height if isinstance(height, int) and height > 0 else 0
            if task is None and indexed is None:
                original = store.info(f"photos/{photo_id}/original")
                if original:
                    original_index = indexed_metadata(original)
                    task = task_from_record(original_index or {}, original.metadata)
            metadata = indexed or ({"task": task} if task else {})
            entry = {"id": photo_id, "created_at": obj.created, "metadata": metadata}
            if width and height:
                entry.update(width=width, height=height)
            if task:
                entry["task"] = task
            if author:
                entry["author"] = author
            if include_hidden:
                entry["hidden"] = photo_id in hidden_ids
            entry["hot_ruling"] = hot_ruling.get(photo_id)
            entry["in_stream"] = photo_id not in off_stream_ids
            entry["interactions"] = public_interactions(social.get(photo_id))
            entries.append(entry)
        entries.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
        hot_ids = resolve_hot(entries)
        for entry in entries:
            entry["hot"] = entry["id"] in hot_ids
        return entries

    def marker_payload(photo_id):
        return json.dumps(
            {
                "schema_version": 1,
                "photo_id": photo_id,
                "recorded_at": datetime.now(UTC).isoformat(),
            },
            separators=(",", ":"),
        ).encode()

    def record_user_upload(device, photo_id):
        """Record one immutable event per photo so retries never increase the value twice."""
        store.put(
            user_upload_key(device, photo_id),
            marker_payload(photo_id),
            "application/json",
        )

    def reconcile_user_uploads(device, user):
        """Backfill upload events once for profiles created before user values existed."""
        if store.info(user_reconciled_key(device)) is None:
            for obj in store.published():
                photo_id = Path(obj.name).stem
                indexed = indexed_metadata(obj)
                author = author_from_record(indexed or {})
                if indexed is None:
                    try:
                        record = manifest(photo_id)
                    except HTTPException:
                        continue
                    author = author_from_record(record)
                    if author is None:
                        author = author_from_record(record.get("metadata", {}))
                if author and author["id"] == user["id"]:
                    record_user_upload(device, photo_id)
            store.put(
                user_reconciled_key(device),
                json.dumps(
                    {"schema_version": 1, "completed_at": datetime.now(UTC).isoformat()},
                    separators=(",", ":"),
                ).encode(),
                "application/json",
            )

    def user_profile(device, role_states=None):
        user = user_for_device(device)
        if user is None:
            return None
        reconcile_user_uploads(device, user)
        photos_uploaded = len(store.list_prefix(user_upload_prefix(device)))
        return {
            **user,
            "device_id": "d_" + device[:12],
            "values": {"photos_uploaded": photos_uploaded},
            "is_admin": is_admin(device, role_states),
        }

    def stream_photo(entry):
        """The compact shape a screen needs to show and rank one photo.

        Only what the caption under a photo needs, plus the two counts the
        screens rank on. They poll this list continuously, so it stays lean even
        late in a party with several hundred photos.
        """
        interactions = entry.get("interactions") or {}
        return {
            "id": entry["id"],
            "created_at": entry["created_at"],
            "task": (entry.get("task") or {}).get("text"),
            "author": (entry.get("author") or {}).get("name"),
            "reactions": interactions.get("reactions", []),
            "comments": interactions.get("comments_count", 0),
            # Three-way: an admin ruled it hot, ruled it out, or left it
            # to the reactions, in which case this is absent.
            "hot": entry.get("hot"),
            "in_stream": bool(entry.get("in_stream", True)),
        }

    def require_admin(request):
        data = session_data(request)
        if not is_admin(data["device"]):
            raise HTTPException(403, "Dieser Bereich ist nur für Admins.")
        return data

    def admin_overview():
        role_states = admin_role_states()
        photos_by_author = {}
        for photo in gallery_entries(include_hidden=True):
            author = photo.get("author") or photo.get("metadata", {}).get("author")
            if isinstance(author, dict) and isinstance(author.get("id"), str):
                photos_by_author.setdefault(author["id"], []).append(
                    {
                        "id": photo["id"],
                        "created_at": photo["created_at"],
                        "hidden": photo["hidden"],
                    }
                )
        users = []
        for obj in store.list_prefix("users/"):
            suffix = obj.name.removeprefix("users/")
            if "/" in suffix or not suffix.endswith(".json"):
                continue
            device = suffix.removesuffix(".json")
            if not re.fullmatch(r"[a-f0-9]{64}", device):
                continue
            profile = user_profile(device, role_states)
            if profile is None:
                continue
            uploads = photos_by_author.get(profile["id"], [])
            users.append(
                {
                    **profile,
                    "joined_at": obj.created,
                    "values": {
                        **profile["values"],
                        "photos_visible": sum(not photo["hidden"] for photo in uploads),
                        "photos_hidden": sum(photo["hidden"] for photo in uploads),
                    },
                    "photos": uploads,
                }
            )
        users.sort(key=lambda user: (user["name"].casefold(), user["id"]))
        return {
            "users": users,
            "values": {
                "users": len(users),
                "photos": sum(len(user["photos"]) for user in users),
            },
        }

    @app.exception_handler(GoogleAPIError)
    async def storage_error(request, error):
        log.error("cloud_backend_failed type=%s", type(error).__name__)
        return JSONResponse(
            {"detail": "Der Dienst ist gerade nicht erreichbar. Bitte erneut versuchen."}, 503
        )

    @app.exception_handler(HTTPException)
    async def application_error(request, error):
        if request.url.path == "/api/photos":
            log.warning(
                "photo_upload_rejected status=%s detail=%s",
                error.status_code,
                error.detail,
            )
        return JSONResponse(
            {"detail": error.detail},
            status_code=error.status_code,
            headers=error.headers,
        )

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/")
    @app.get("/gallery")
    @app.get("/stream")
    def page():
        if not settings.secure_cookies:
            html = (ROOT / "static/index.html").read_text()
            if os.environ.get("FOTOVIBE_HOT_RELOAD") == "1":
                html = html.replace("</body>", '<script src="/static/dev-reload.js"></script>\n</body>')
            return HTMLResponse(html)
        return FileResponse(ROOT / "static/index.html")

    @app.get("/service-worker.js")
    def service_worker():
        return FileResponse(
            ROOT / "static/service-worker.js",
            media_type="application/javascript",
            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
        )

    @app.get("/manifest.webmanifest")
    def web_manifest():
        return FileResponse(
            ROOT / "static/manifest.webmanifest",
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-cache"},
        )

    if not settings.secure_cookies:

        @app.get("/__dev/reload")
        async def development_reload_events():
            async def events():
                yield "data: connected\n\n"
                while True:
                    await asyncio.sleep(2)
                    yield ": keepalive\n\n"

            return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/api/session")
    def current_session(request: Request):
        data = session_data(request)
        return {"authenticated": True, "user": user_profile(data["device"])}

    @app.get("/api/tasks/random")
    def random_task(request: Request, exclude: str | None = None):
        sid = session(request)
        limiter.check("task:" + sid, 30)
        if exclude is not None and not re.fullmatch(r"[a-z0-9-]{1,100}", exclude):
            raise HTTPException(400, "Die Aufgabenliste bitte neu laden.")
        tasks = task_store.enabled()
        choices = [task for task in tasks if task["id"] != exclude]
        if not choices:
            choices = tasks
        if not choices:
            raise HTTPException(503, "Gerade ist keine Foto-Aufgabe verfügbar.")
        return secrets.choice(choices)

    @app.get("/api/tasks")
    def offline_tasks(request: Request):
        """Return all active tasks, including a tamper-proof delayed-upload snapshot."""
        sid = session(request)
        limiter.check("tasks:" + sid, 30)
        return {
            "tasks": [
                {**task, "task_token": task_snapshot(task)}
                for task in task_store.enabled()
            ]
        }

    def task_text_from_request(payload):
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500:
            raise HTTPException(400, "Eine Aufgabe muss zwischen 1 und 500 Zeichen lang sein.")
        return text.strip()

    @app.post("/api/tasks")
    async def create_party_task(request: Request):
        sid = session(request)
        limiter.check("task-create:" + sid, 10)
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(400, "Bitte gib eine Aufgabe ein.") from None
        try:
            task = task_store.create(task_text_from_request(payload))
        except ValueError:
            raise HTTPException(400, "Die Aufgabe ist ungültig.") from None
        return JSONResponse(task, status_code=201)

    @app.post("/api/session")
    async def login(request: Request):
        key = "login:" + (request.client.host if request.client else "unknown")
        limiter.check(key, 30, consume=False)
        try:
            payload = await request.json()
            provided = payload.get("code", "")
            if not isinstance(provided, str):
                raise TypeError
            device_id = payload.get("device_id")
            if device_id is not None:
                device_id = valid_device_id(device_id)
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Bitte einen Party-Code eingeben.") from None
        provided_code = normalized(provided).encode()
        valid_code = sum(
            secrets.compare_digest(provided_code, accepted.encode()) for accepted in accepted_codes
        )
        if not valid_code:
            limiter.check(key, 30)
            raise HTTPException(401, "Der Party-Code stimmt nicht. Bitte noch einmal prüfen.")
        device = device_key(device_id or str(uuid.uuid4()))
        response = JSONResponse({"authenticated": True, "user": user_profile(device)})
        set_session_cookie(response, device)
        return response

    @app.post("/api/session/restore")
    async def restore_session(request: Request):
        try:
            payload = await request.json()
            device = device_key(valid_device_id(payload.get("device_id")))
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Die Gerätekennung ist ungültig. Bitte die Seite neu laden.") from None
        user = user_profile(device)
        if user is None:
            raise HTTPException(401, "Dieses Gerät ist noch nicht für die Party angemeldet.")
        response = JSONResponse({"authenticated": True, "user": user})
        set_session_cookie(response, device)
        return response

    @app.post("/api/users/me")
    async def create_current_user(request: Request):
        data = session_data(request)
        try:
            payload = await request.json()
            name = normalized_name(payload.get("name"))
        except (ValueError, AttributeError, TypeError):
            raise HTTPException(400, "Bitte gib deinen Namen ein.") from None
        existing = user_for_device(data["device"])
        if existing:
            if existing["name"] != name:
                raise HTTPException(409, "Für dieses Gerät ist bereits ein Name festgelegt.")
            return {"user": user_profile(data["device"])}
        user = {"id": "u_" + data["device"][:16], "name": name}
        created = store.put(
            user_key(data["device"]),
            json.dumps({"schema_version": 1, **user}, ensure_ascii=False).encode(),
            "application/json",
        )
        if not created:
            existing = user_for_device(data["device"])
            if existing:
                return {"user": user_profile(data["device"])}
            raise HTTPException(503, "Dein Name konnte gerade nicht gespeichert werden.")
        store.put(
            user_reconciled_key(data["device"]),
            json.dumps(
                {"schema_version": 1, "completed_at": datetime.now(UTC).isoformat()},
                separators=(",", ":"),
            ).encode(),
            "application/json",
        )
        return {"user": user_profile(data["device"])}

    @app.delete("/api/session")
    def logout():
        response = Response(status_code=204)
        response.delete_cookie(
            COOKIE, path="/", secure=settings.secure_cookies, httponly=True, samesite="strict"
        )
        return response

    @app.get("/api/admin/overview")
    def admin_users(request: Request):
        require_admin(request)
        return admin_overview()

    @app.patch("/api/admin/users/{device_id}/role")
    async def admin_update_user_role(request: Request, device_id: str):
        actor = require_admin(request)
        if not ADMIN_DEVICE_ID_PATTERN.fullmatch(device_id):
            raise HTTPException(400, "Die Geräte-ID ist ungültig.")
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(400, "Die neue Rolle ist ungültig.") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("is_admin"), bool):
            raise HTTPException(400, "Die neue Rolle ist ungültig.")
        desired = payload["is_admin"]

        target_suffix = device_id.removeprefix("d_")
        matches = []
        for obj in store.list_prefix("users/"):
            suffix = obj.name.removeprefix("users/")
            if "/" in suffix or not suffix.endswith(".json"):
                continue
            device = suffix.removesuffix(".json")
            if re.fullmatch(r"[a-f0-9]{64}", device) and device[:12] == target_suffix:
                matches.append(device)
        if not matches:
            raise HTTPException(404, "Dieser Nutzer wurde nicht gefunden.")
        if len(matches) > 1:
            raise HTTPException(409, "Die Geräte-ID ist nicht eindeutig.")
        target = matches[0]
        role_states = admin_role_states()
        current = is_admin(target, role_states)
        if current == desired:
            profile = user_profile(target, role_states)
            return {"user": profile}
        if target == actor["device"] and not desired:
            raise HTTPException(400, "Du kannst dir selbst nicht die Adminrechte entziehen.")
        if current and not desired:
            public_ids = effective_admin_public_ids(role_states)
            if len(public_ids) <= 1:
                raise HTTPException(409, "Mindestens ein Admin muss erhalten bleiben.")

        store.put(
            f"{admin_role_prefix(target)}{uuid.uuid4()}.json",
            json.dumps(
                {
                    "schema_version": 1,
                    "device": target,
                    "is_admin": desired,
                    "changed_by": "d_" + actor["device"][:12],
                    "changed_at": datetime.now(UTC).isoformat(),
                },
                separators=(",", ":"),
            ).encode(),
            "application/json",
        )
        role_states = admin_role_states()
        return {"user": user_profile(target, role_states)}

    @app.get("/api/admin/tasks")
    def admin_tasks(request: Request):
        require_admin(request)
        return {"tasks": sorted(task_store.all(), key=lambda task: (task["text"].casefold(), task["id"]))}

    @app.post("/api/admin/tasks")
    async def admin_create_task(request: Request):
        require_admin(request)
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(400, "Bitte gib eine Aufgabe ein.") from None
        try:
            task = task_store.create(task_text_from_request(payload))
        except ValueError:
            raise HTTPException(400, "Die Aufgabe ist ungültig.") from None
        return JSONResponse(task, status_code=201)

    @app.patch("/api/admin/tasks/{task_id}")
    async def admin_update_task(request: Request, task_id: str):
        require_admin(request)
        if not TASK_ID_PATTERN.fullmatch(task_id):
            raise HTTPException(400, "Die Aufgaben-ID ist ungültig.")
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(400, "Bitte gib eine Aufgabe ein.") from None
        existing = next((task for task in task_store.all() if task["id"] == task_id), None)
        if existing is None:
            raise HTTPException(404, "Diese Aufgabe gibt es nicht mehr.")
        try:
            return task_store.upsert(task_id, task_text_from_request(payload), existing["enabled"])
        except ValueError:
            raise HTTPException(400, "Die Aufgabe ist ungültig.") from None

    @app.delete("/api/admin/tasks/{task_id}")
    def admin_delete_task(request: Request, task_id: str):
        require_admin(request)
        if not TASK_ID_PATTERN.fullmatch(task_id):
            raise HTTPException(400, "Die Aufgaben-ID ist ungültig.")
        try:
            deleted = task_store.delete(task_id)
        except ValueError:
            raise HTTPException(400, "Die Aufgaben-ID ist ungültig.") from None
        if not deleted:
            raise HTTPException(404, "Diese Aufgabe gibt es nicht mehr.")
        return Response(status_code=204)

    @app.post("/api/admin/photos/{photo_id}/hide")
    def hide_photo(request: Request, photo_id: str):
        data = require_admin(request)
        valid_id(photo_id)
        manifest(photo_id)
        created = store.put(
            f"hidden/{photo_id}.json",
            json.dumps(
                {
                    "schema_version": 1,
                    "photo_id": photo_id,
                    "hidden_at": datetime.now(UTC).isoformat(),
                    "hidden_by": "d_" + data["device"][:12],
                },
                separators=(",", ":"),
            ).encode(),
            "application/json",
        )
        with cache_lock:
            cache["until"] = 0
        return {"id": photo_id, "hidden": True, "already_hidden": not created}

    @app.post("/api/admin/photos/{photo_id}/hot")
    async def set_photo_hot(request: Request, photo_id: str):
        """Rule a photo hot, or rule it out of the rotation.

        This overrides the party's reactions in either direction: a photo the
        votes would have made hot can be taken out of the rotation, and one
        nobody has reacted to can be put into it.
        """
        data = require_admin(request)
        valid_id(photo_id)
        manifest(photo_id)
        try:
            payload = await request.json()
            hot = payload.get("hot", True)
            if not isinstance(hot, bool):
                raise TypeError
        except (AttributeError, TypeError, ValueError):
            raise HTTPException(400, "Bitte gib an, ob das Foto hot sein soll.") from None
        if hot and photo_id in hidden_photo_ids():
            raise HTTPException(409, "Ausgeblendete Fotos können nicht hot werden.")
        recorded_at = datetime.now(UTC).isoformat()
        store.put(
            f"pins/{photo_id}/{uuid.uuid4()}.json",
            json.dumps(
                {
                    "schema_version": 1,
                    "photo_id": photo_id,
                    "hot": hot,
                    "decided_by": "d_" + data["device"][:12],
                    "recorded_at": recorded_at,
                },
                separators=(",", ":"),
            ).encode(),
            "application/json",
            {
                "kind": "pin",
                "photo_id": photo_id,
                "active": "1" if hot else "0",
                "recorded_at": recorded_at,
            },
        )
        with cache_lock:
            cache["until"] = 0
        return {"id": photo_id, "hot": hot}

    @app.post("/api/admin/photos/{photo_id}/stream")
    async def set_photo_on_stream(request: Request, photo_id: str):
        """Take a photo off the wall, or put it back. It stays in the gallery."""
        data = require_admin(request)
        valid_id(photo_id)
        manifest(photo_id)
        try:
            payload = await request.json()
            shown = payload.get("shown", True)
            if not isinstance(shown, bool):
                raise TypeError
        except (AttributeError, TypeError, ValueError):
            raise HTTPException(400, "Bitte gib an, ob das Foto im Stream laufen soll.") from None
        recorded_at = datetime.now(UTC).isoformat()
        store.put(
            f"stream_hidden/{photo_id}/{uuid.uuid4()}.json",
            json.dumps(
                {
                    "schema_version": 1,
                    "photo_id": photo_id,
                    "in_stream": shown,
                    "changed_by": "d_" + data["device"][:12],
                    "recorded_at": recorded_at,
                },
                separators=(",", ":"),
            ).encode(),
            "application/json",
            {
                "kind": "stream_hidden",
                "photo_id": photo_id,
                "active": "0" if shown else "1",
                "recorded_at": recorded_at,
            },
        )
        with cache_lock:
            cache["until"] = 0
        return {"id": photo_id, "in_stream": shown}

    @app.get("/api/admin/photos")
    def admin_photos(request: Request):
        """Every gallery photo, in the gallery's own shape, all at once.

        The wall's own list leaves out whatever was taken off it, so the panel
        cannot use it: an admin has to see a photo in order to put it back. The
        full shape is what the panel wants anyway, because it draws the same
        tiles the gallery does, and it carries both switches already.
        """
        require_admin(request)
        with cache_lock:
            if cache["until"] <= time.monotonic():
                cache.update(photos=gallery_entries(), until=time.monotonic() + 5)
            entries = cache["photos"]
        return {"photos": entries}

    @app.get("/api/photos/{photo_id}/interactions")
    def photo_interactions(request: Request, photo_id: str):
        data = session_data(request)
        valid_id(photo_id)
        manifest(photo_id)
        return interaction_details(photo_id, data["device"])

    @app.post("/api/photos/{photo_id}/reactions")
    async def react_to_photo(request: Request, photo_id: str):
        data = session_data(request)
        valid_id(photo_id)
        manifest(photo_id)
        limiter.check("reaction:" + data["sid"], 60)
        try:
            payload = await request.json()
            emoji = payload.get("emoji")
            reaction_id = next(key for key, value in REACTIONS.items() if value == emoji)
            active = payload.get("active", True)
            if not isinstance(active, bool):
                raise TypeError
        except (AttributeError, StopIteration, ValueError, TypeError):
            raise HTTPException(400, "Diese Reaktion ist nicht verfügbar.") from None
        social_user(data)
        recorded_at = datetime.now(UTC).isoformat()
        store.put(
            f"{interaction_prefix(photo_id)}reactions/{data['device']}/{reaction_id}/{uuid.uuid4()}.json",
            json.dumps(
                {
                    "schema_version": 1,
                    "emoji": emoji,
                    "active": active,
                    "created_at": recorded_at,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode(),
            "application/json",
            {
                "kind": "reaction",
                "photo_id": photo_id,
                "reaction": reaction_id,
                "device": data["device"],
                "active": "1" if active else "0",
                "recorded_at": recorded_at,
            },
        )
        with cache_lock:
            cache["until"] = 0
        return interaction_details(photo_id, data["device"])

    @app.post("/api/photos/{photo_id}/comments")
    async def comment_on_photo(request: Request, photo_id: str):
        data = session_data(request)
        valid_id(photo_id)
        manifest(photo_id)
        limiter.check("comment:" + data["sid"], 20)
        try:
            payload = await request.json()
            text = normalized_comment(payload.get("text"))
        except (AttributeError, TypeError, ValueError):
            raise HTTPException(400, "Bitte schreibe einen Kommentar.") from None
        author = social_user(data)
        created_at = datetime.now(UTC).isoformat()
        store.put(
            f"{interaction_prefix(photo_id)}comments/{uuid.uuid4()}.json",
            json.dumps(
                {"schema_version": 1, "author": author, "text": text, "created_at": created_at},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode(),
            "application/json",
            {"kind": "comment", "photo_id": photo_id},
        )
        with cache_lock:
            cache["until"] = 0
        return interaction_details(photo_id, data["device"])

    def persist(raw, photo_id, photo_metadata):
        digest = hashlib.sha256(raw).hexdigest()
        metadata_digest = hashlib.sha256(
            json.dumps(photo_metadata, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        with photo_conversion_lock(photo_id):
            original_key = f"photos/{photo_id}/original"
            existing = store.info(original_key)
            if existing and existing.metadata.get("sha256") != digest:
                raise HTTPException(409, "Diese Upload-ID gehört bereits zu einem anderen Foto.")
            if existing and existing.metadata.get("metadata_sha256") not in {
                None,
                metadata_digest,
            }:
                raise HTTPException(
                    409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                )
            published = store.read(f"published/{photo_id}.json")
            if published:
                record = json.loads(published)
                if record.get("metadata", {}) != photo_metadata:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                    )
                return record, False
            images = derivatives(raw)
            original_metadata = {"sha256": digest, "metadata_sha256": metadata_digest}
            if photo_metadata:
                original_metadata["fotovibe_metadata"] = metadata_index(photo_metadata)
                task = photo_metadata.get("task")
                if isinstance(task, dict):
                    original_metadata.update(
                        {
                            "task_id": task.get("id") or "",
                            "task_text": task.get("text") or "",
                        }
                    )
            created = store.put(
                original_key,
                raw,
                images["content_type"],
                original_metadata,
            )
            if not created:
                existing = store.info(original_key)
                if existing.metadata.get("sha256") != digest:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu einem anderen Foto."
                    )
                if existing.metadata.get("metadata_sha256") not in {None, metadata_digest}:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                    )
            store.put(f"photos/{photo_id}/display.jpg", images["display"], "image/jpeg")
            store.put(f"photos/{photo_id}/thumb.jpg", images["thumb"], "image/jpeg")
            store.put(f"photos/{photo_id}/soft.jpg", soften(images["thumb"]), "image/jpeg")
            record = {
                "schema_version": 1,
                "id": photo_id,
                "size": len(raw),
                "sha256": digest,
                "content_type": images["content_type"],
                "extension": images["extension"],
                "width": images["width"],
                "height": images["height"],
                "metadata": photo_metadata,
            }
            published_now = store.put(
                f"published/{photo_id}.json",
                json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode(),
                "application/json",
                {
                    "schema_version": "1",
                    "fotovibe_metadata": metadata_index(photo_metadata),
                    "width": str(images["width"]),
                    "height": str(images["height"]),
                },
            )
            if not published_now:
                record = json.loads(store.read(f"published/{photo_id}.json"))
                if record.get("metadata", {}) != photo_metadata:
                    raise HTTPException(
                        409, "Diese Upload-ID gehört bereits zu anderen Foto-Metadaten."
                    )
            with cache_lock:
                cache["until"] = 0
            return record, published_now

    @app.post("/api/photos")
    async def upload(request: Request):
        data = session_data(request)
        sid = data["sid"]
        # A complete offline outbox holds 25 photos. Leave room for those to
        # drain in one minute, plus a few idempotent retries, without removing
        # the per-session abuse guard.
        limiter.check("upload:" + sid, 30)
        media_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
        if media_type.startswith("image/") or media_type == "application/octet-stream":
            # Current offline clients send the Blob directly. This avoids a
            # WebKit bug where an IndexedDB-restored Blob can lose its file
            # disposition while Safari creates multipart/form-data.
            queued_upload_id = request.headers.get("x-fotovibe-upload-id")
            task_id = request.headers.get("x-fotovibe-task-id")
            task_token = request.headers.get("x-fotovibe-task-token")
            client_metadata = request.headers.get("x-fotovibe-client-metadata")
            raw = await request.body()
        else:
            # Multipart stays available for installed older clients and API
            # compatibility. New clients no longer depend on this Safari path.
            async with request.form(max_files=1, max_fields=4, max_part_size=8192) as form:
                allowed_fields = {
                    "photo", "upload_id", "task_id", "task_token", "client_metadata"
                }
                if set(form.keys()) - allowed_fields:
                    raise HTTPException(400, "Die Upload-Daten sind ungültig.")

                photo_values = form.getlist("photo")
                upload_id_values = form.getlist("upload_id")
                task_id_values = form.getlist("task_id")
                task_token_values = form.getlist("task_token")
                client_metadata_values = form.getlist("client_metadata")
                optional_values = [
                    upload_id_values, task_id_values, task_token_values, client_metadata_values
                ]
                if len(photo_values) != 1 or not isinstance(photo_values[0], UploadFile):
                    raise HTTPException(400, "Bitte genau ein Foto auswählen.")
                if any(len(value) > 1 for value in optional_values) or any(
                    value and not isinstance(value[0], str) for value in optional_values
                ):
                    raise HTTPException(400, "Die Upload-Daten sind ungültig.")

                photo = photo_values[0]
                queued_upload_id = upload_id_values[0] if upload_id_values else None
                task_id = task_id_values[0] if task_id_values else None
                task_token = task_token_values[0] if task_token_values else None
                client_metadata = client_metadata_values[0] if client_metadata_values else None
                raw = await photo.read(MAX_BYTES + 1)

        if not raw:
            raise HTTPException(400, "Die Datei ist leer.")
        if len(raw) > MAX_BYTES:
            raise HTTPException(413, "Das Foto ist zu groß (maximal 25 MiB).")
        task = await run_in_threadpool(resolve_task, task_id, task_token)
        capture = capture_metadata(client_metadata)
        capture_task_id = capture.pop("task_id", None) if capture else None
        if capture_task_id is not None and (not task or capture_task_id != task["id"]):
            raise HTTPException(400, "Die Foto-Aufgabe passt nicht zum Foto.")
        photo_id = upload_photo_id(queued_upload_id, data["device"])
        photo_metadata = {"task": task} if task else {}
        if capture:
            photo_metadata["capture"] = capture
        author = user_for_device(data["device"])
        if author:
            photo_metadata["author"] = author
        record, created = await run_in_threadpool(persist, raw, photo_id, photo_metadata)
        if author:
            await run_in_threadpool(record_user_upload, data["device"], photo_id)
        return JSONResponse(record, status_code=201 if created else 200)

    @app.get("/api/photos")
    def photos(
        request: Request,
        cursor: str | None = None,
        q: str | None = None,
        mine: bool = False,
    ):
        data = session_data(request)
        if q is not None and (not isinstance(q, str) or len(q) > 100):
            raise HTTPException(400, "Die Suche ist zu lang.")
        after = None
        if cursor:
            try:
                after = cursors.loads(cursor, max_age=SESSION_AGE)
                if (
                    not isinstance(after, list)
                    or len(after) != 2
                    or not all(isinstance(x, str) for x in after)
                ):
                    raise BadSignature("invalid cursor")
            except BadSignature:
                raise HTTPException(400, "Die Galerie bitte neu laden.") from None
        with cache_lock:
            if cache["until"] <= time.monotonic():
                cache.update(photos=gallery_entries(), until=time.monotonic() + 5)
            entries = cache["photos"]
        if mine:
            user = user_for_device(data["device"])
            user_id = user["id"] if user else None
            entries = [
                photo
                for photo in entries
                if user_id and (photo.get("author") or {}).get("id") == user_id
            ]
        if q:
            entries = [
                photo
                for photo in entries
                if fuzzy_matches(
                    q,
                    " ".join(
                        value
                        for value in [
                            (photo.get("author") or {}).get("name", ""),
                            (photo.get("task") or {}).get("text", ""),
                            # Searching for "hot" is how a guest finds the ones
                            # the wall is celebrating.
                            "hot" if photo.get("hot") else "",
                        ]
                        if isinstance(value, str)
                    ),
                )
            ]
        if after:
            entries = [x for x in entries if (x["created_at"], x["id"]) < tuple(after)]
        page = entries[:30]
        next_cursor = (
            cursors.dumps([page[-1]["created_at"], page[-1]["id"]]) if len(entries) > 30 else None
        )
        return {"photos": page, "next_cursor": next_cursor}

    @app.get("/api/photos/stream")
    def stream_photos(request: Request):
        """Every visible photo, newest first, for the shared party stream.

        The stream has no server-side state: each screen derives the currently
        shown photo from the clock, so all of them stay on the same picture as
        long as they share this list and agree on the time. The server clock is
        returned with it, letting a screen correct its own drift.
        """
        session(request)
        with cache_lock:
            if cache["until"] <= time.monotonic():
                cache.update(photos=gallery_entries(), until=time.monotonic() + 5)
            entries = cache["photos"]
        return {
            "photos": [
                stream_photo(entry) for entry in entries if entry.get("in_stream", True)
            ],
            "now": datetime.now(UTC).isoformat(),
        }

    def soft_variant(photo_id):
        """The blurred stream copy, built once from the thumbnail on first use.

        Photos uploaded before the stream needed this have no such copy, and a
        party is no time for a migration, so the first screen that asks for one
        makes it. Objects are immutable, and a losing race simply finds the copy
        already there.
        """
        key = f"photos/{photo_id}/soft.jpg"
        existing = store.read(key)
        if existing is not None:
            return existing
        source = store.read(f"photos/{photo_id}/thumb.jpg")
        if source is None:
            raise HTTPException(404, "Diese Bildversion gibt es nicht.")
        data = soften(source)
        store.put(key, data, "image/jpeg")
        return data

    @app.get("/api/photos/{photo_id}/{variant}")
    async def photo(request: Request, photo_id: str, variant: str):
        session(request)
        valid_id(photo_id)
        if variant not in {"soft", "thumb", "display", "original"}:
            raise HTTPException(404, "Diese Bildversion gibt es nicht.")
        record = manifest(photo_id)
        if variant == "soft":
            data = await run_in_threadpool(soft_variant, photo_id)
            return Response(
                data,
                media_type="image/jpeg",
                headers={"Cache-Control": "private, max-age=300", "Vary": "Cookie"},
            )
        key = f"photos/{photo_id}/" + ("original" if variant == "original" else variant + ".jpg")
        headers = {"Cache-Control": "private, max-age=300", "Vary": "Cookie"}
        media_type = "image/jpeg"
        if variant == "original":
            media_type = record["content_type"]
            headers["Content-Disposition"] = (
                f'attachment; filename="FotoVibe-{photo_id}.{record["extension"]}"'
            )
        return StreamingResponse(store.stream(key), media_type=media_type, headers=headers)

    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    return app
