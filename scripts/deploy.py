"""Idempotent provisioning and source deployment. No global gcloud config changes."""

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "project-8b626ca4-30b1-415b-84b"
RUN_REGION = "europe-west1"
STORAGE_REGION = "europe-west3"
SERVICE = "fotovibe"
BUCKET = "fotovibe-520703150508-photos"
AUTH_SECRET = "fotovibe-auth"
TEST_CODE = "1234"
ADMIN_DEVICE_IDS = (
    "d_df9eabe35ce8",
    "d_41b14e411f97",
    "d_d63b34eb51bf",
    "d_9507ec317a1a",
    "d_a76821de5a21",
    "d_376bce002323",
)
FIRESTORE_DATABASE = "fotovibe"
DNS_ZONE = "zone-180-foto-com"
DOMAINS = ("180-foto.com", "www.180-foto.com")
RUNTIME = f"fotovibe-runtime@{PROJECT}.iam.gserviceaccount.com"
BUILDER = f"fotovibe-build@{PROJECT}.iam.gserviceaccount.com"


def normalize_public_dependency_sources():
    """Repair lockfile URLs copied from the local-only Python proxy."""
    path = ROOT / "uv.lock"
    if not path.exists():
        return
    content = path.read_text(encoding="utf-8")
    normalized = content.replace(
        "https://cdproxy.sportradar.online/pypi/simple", "https://pypi.org/simple"
    ).replace(
        "https://cdproxy.sportradar.online/pypi/packages/packages/",
        "https://files.pythonhosted.org/packages/",
    )
    if normalized != content:
        path.write_text(normalized, encoding="utf-8")
        print("Normalized uv.lock to public Python package URLs.", flush=True)


def verify_public_dependency_sources():
    """Fail locally when a machine-only package proxy leaked into build inputs."""
    build_inputs = (
        "uv.lock",
        "package-lock.json",
        ".npmrc",
        "pyproject.toml",
        "package.json",
        "Dockerfile",
        ".gitlab-ci.yml",
    )
    for name in build_inputs:
        path = ROOT / name
        if path.exists() and "cdproxy.sportradar.online" in path.read_text(encoding="utf-8"):
            raise RuntimeError(
                f"{path.name} contains the local dependency proxy cdproxy.sportradar.online. "
                "See DEPENDENCY_SOURCES.md and regenerate the lockfile for the public registry "
                "before deploying, for example: env -u UV_DEFAULT_INDEX uv lock "
                "--default-index https://pypi.org/simple"
            )


def gc(*args, live=False, missing_ok=False):
    command = ["gcloud", *args, f"--project={PROJECT}", "--quiet"]
    result = subprocess.run(command, text=True, capture_output=not live, cwd=ROOT, check=False)
    if result.returncode:
        if missing_ok and any(
            term in result.stderr
            for term in ["NOT_FOUND", "not found", "does not exist", "NotFound", "404"]
        ):
            return None
        raise RuntimeError(result.stderr if not live else "gcloud command failed; see output above")
    return result.stdout.strip() if not live else ""


def ensure_sa(name):
    email = f"{name}@{PROJECT}.iam.gserviceaccount.com"
    if gc("iam", "service-accounts", "describe", email, "--format=json", missing_ok=True) is None:
        gc("iam", "service-accounts", "create", name, f"--display-name={name}")
    return email


def secret_version():
    return gc(
        "secrets",
        "versions",
        "list",
        AUTH_SECRET,
        "--filter=state:ENABLED",
        "--sort-by=~createTime",
        "--limit=1",
        "--format=value(name)",
    ).split("/")[-1]


def ensure_firestore():
    raw = gc(
        "firestore",
        "databases",
        "describe",
        f"--database={FIRESTORE_DATABASE}",
        "--format=json",
        missing_ok=True,
    )
    if raw is None:
        gc(
            "firestore",
            "databases",
            "create",
            f"--database={FIRESTORE_DATABASE}",
            f"--location={STORAGE_REGION}",
            "--type=firestore-native",
            live=True,
        )
    else:
        database = json.loads(raw)
        if database.get("locationId", "").lower() != STORAGE_REGION:
            raise RuntimeError(
                f"Existing Firestore database {FIRESTORE_DATABASE} is not in {STORAGE_REGION}"
            )
    gc(
        "projects",
        "add-iam-policy-binding",
        PROJECT,
        f"--member=serviceAccount:{RUNTIME}",
        "--role=roles/datastore.user",
        "--condition=None",
    )
    subprocess.run(
        [sys.executable, str(ROOT / "scripts/manage_tasks.py"), "seed"],
        cwd=ROOT,
        check=True,
    )


def ensure_domain_mapping(domain):
    common = (
        "--platform=managed",
        f"--region={RUN_REGION}",
        f"--domain={domain}",
    )
    raw = gc(
        "beta",
        "run",
        "domain-mappings",
        "describe",
        *common,
        "--format=json",
        missing_ok=True,
    )
    if raw is None:
        gc(
            "beta",
            "run",
            "domain-mappings",
            "create",
            *common,
            f"--service={SERVICE}",
            live=True,
        )
    elif json.loads(raw).get("spec", {}).get("routeName") != SERVICE:
        gc(
            "beta",
            "run",
            "domain-mappings",
            "create",
            *common,
            f"--service={SERVICE}",
            "--force-override",
            live=True,
        )

    for _ in range(12):
        mapping = json.loads(
            gc(
                "beta",
                "run",
                "domain-mappings",
                "describe",
                *common,
                "--format=json",
            )
        )
        records = mapping.get("status", {}).get("resourceRecords", [])
        if records:
            return mapping, records
        time.sleep(5)
    raise RuntimeError(f"Cloud Run did not publish DNS records for {domain}")


def ensure_dns_record(name, record_type, values):
    values = sorted(set(values))
    common = (name, f"--zone={DNS_ZONE}", f"--type={record_type}")
    raw = gc("dns", "record-sets", "describe", *common, "--format=json", missing_ok=True)
    args = (*common, "--ttl=300", f"--rrdatas={','.join(values)}")
    if raw is None:
        gc("dns", "record-sets", "create", *args)
        return
    current = json.loads(raw)
    if sorted(current.get("rrdatas", [])) != values or current.get("ttl") != 300:
        gc("dns", "record-sets", "update", *args)


def ensure_domains():
    verified = set(
        gc("domains", "list-user-verified", "--format=value(id)").splitlines()
    )
    if DOMAINS[0] not in verified:
        raise RuntimeError(f"Domain ownership is not verified for {DOMAINS[0]}")
    zone = json.loads(gc("dns", "managed-zones", "describe", DNS_ZONE, "--format=json"))
    if zone.get("dnsName") != f"{DOMAINS[0]}.":
        raise RuntimeError(f"{DNS_ZONE} does not manage {DOMAINS[0]}")

    for domain in DOMAINS:
        _, records = ensure_domain_mapping(domain)
        grouped = {}
        for record in records:
            # Cloud Run may return no name for an apex record and a relative
            # name (for example "www.") for a subdomain. Each mapping's
            # records always belong to the exact mapped domain.
            key = (f"{domain}.", record["type"])
            grouped.setdefault(key, []).append(record["rrdata"])
        for (name, record_type), values in grouped.items():
            ensure_dns_record(name, record_type, values)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--rotate-code",
        action="store_true",
        help="Create a fresh code and invalidate all existing sessions",
    )
    args = parser.parse_args()
    normalize_public_dependency_sources()
    verify_public_dependency_sources()
    os.umask(0o077)
    local = ROOT / ".local"
    local.mkdir(exist_ok=True)
    print(
        f"Provisioning FotoVibe in {PROJECT}: Cloud Run {RUN_REGION}, storage {STORAGE_REGION}",
        flush=True,
    )
    billing = json.loads(gc("billing", "projects", "describe", PROJECT, "--format=json"))
    if not billing.get("billingEnabled"):
        raise RuntimeError("Billing must be enabled")
    gc(
        "services",
        "enable",
        "run.googleapis.com",
        "cloudbuild.googleapis.com",
        "artifactregistry.googleapis.com",
        "secretmanager.googleapis.com",
        "iam.googleapis.com",
        "storage.googleapis.com",
        "dns.googleapis.com",
        "firestore.googleapis.com",
    )
    print("APIs enabled. Configuring identities and private storage …", flush=True)
    ensure_sa("fotovibe-runtime")
    ensure_sa("fotovibe-build")
    gc(
        "projects",
        "add-iam-policy-binding",
        PROJECT,
        f"--member=serviceAccount:{BUILDER}",
        "--role=roles/run.builder",
        "--condition=None",
    )

    bucket = gc(
        "storage",
        "buckets",
        "describe",
        f"gs://{BUCKET}",
        "--raw",
        "--format=json",
        missing_ok=True,
    )
    if bucket is None:
        gc(
            "storage",
            "buckets",
            "create",
            f"gs://{BUCKET}",
            f"--location={STORAGE_REGION}",
            "--default-storage-class=STANDARD",
            "--uniform-bucket-level-access",
            "--public-access-prevention",
            "--soft-delete-duration=7d",
        )
    else:
        description = json.loads(bucket)
        if (
            str(description.get("projectNumber")) != "520703150508"
            or description.get("location", "").lower() != STORAGE_REGION
        ):
            raise RuntimeError(
                "Existing bucket belongs to a different project or location; refusing to alter it"
            )
        gc(
            "storage",
            "buckets",
            "update",
            f"gs://{BUCKET}",
            "--uniform-bucket-level-access",
            "--public-access-prevention",
        )
    for role in ["roles/storage.objectCreator", "roles/storage.objectViewer"]:
        gc(
            "storage",
            "buckets",
            "add-iam-policy-binding",
            f"gs://{BUCKET}",
            f"--member=serviceAccount:{RUNTIME}",
            f"--role={role}",
        )
    ensure_firestore()

    found = gc("secrets", "describe", AUTH_SECRET, "--format=json", missing_ok=True)
    auth_path = local / "auth.json"
    if found is None or args.rotate_code:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        code = "".join(secrets.choice(alphabet) for _ in range(10))
        previous = {}
        if found is not None:
            previous = json.loads(
                gc("secrets", "versions", "access", secret_version(), f"--secret={AUTH_SECRET}")
            )
        snapshot_key = previous.get("task_snapshot_key")
        if not isinstance(snapshot_key, str) or not snapshot_key:
            snapshot_key = secrets.token_urlsafe(48)
        values = {
            "party_code": code[:5] + "-" + code[5:],
            "invite_token": secrets.token_urlsafe(24),
            "session_key": secrets.token_urlsafe(48),
            "task_snapshot_key": snapshot_key,
            "test_codes": [TEST_CODE],
            "admin_device_ids": list(ADMIN_DEVICE_IDS),
        }
        auth_path.write_text(json.dumps(values))
        auth_path.chmod(0o600)
        if found is None:
            gc(
                "secrets",
                "create",
                AUTH_SECRET,
                "--replication-policy=user-managed",
                f"--locations={STORAGE_REGION}",
                f"--data-file={auth_path}",
            )
        else:
            gc("secrets", "versions", "add", AUTH_SECRET, f"--data-file={auth_path}")
    else:
        current_version = secret_version()
        values = json.loads(
            gc("secrets", "versions", "access", current_version, f"--secret={AUTH_SECRET}")
        )
        configured_test_codes = values.get("test_codes", [])
        if not isinstance(configured_test_codes, list) or not all(
            isinstance(code, str) for code in configured_test_codes
        ):
            raise RuntimeError("Existing auth secret has invalid test_codes")
        changed = False
        configured_invite_token = values.get("invite_token")
        if configured_invite_token is None:
            values["invite_token"] = secrets.token_urlsafe(24)
            changed = True
        elif (
            not isinstance(configured_invite_token, str)
            or not 24 <= len(configured_invite_token) <= 128
            or not all(
                character.isascii() and (character.isalnum() or character in "_-")
                for character in configured_invite_token
            )
        ):
            raise RuntimeError("Existing auth secret has an invalid invite_token")
        if not isinstance(values.get("task_snapshot_key"), str) or not values["task_snapshot_key"]:
            values["task_snapshot_key"] = secrets.token_urlsafe(48)
            changed = True
        if TEST_CODE not in configured_test_codes:
            values["test_codes"] = [*configured_test_codes, TEST_CODE]
            changed = True
        configured_admin_device_ids = values.get("admin_device_ids")
        if configured_admin_device_ids is None:
            values["admin_device_ids"] = list(ADMIN_DEVICE_IDS)
            changed = True
        elif not isinstance(configured_admin_device_ids, list) or not all(
            isinstance(device_id, str) for device_id in configured_admin_device_ids
        ):
            raise RuntimeError("Existing auth secret has invalid admin_device_ids")
        else:
            missing_admins = [
                device_id
                for device_id in ADMIN_DEVICE_IDS
                if device_id not in configured_admin_device_ids
            ]
            if missing_admins:
                values["admin_device_ids"] = [*configured_admin_device_ids, *missing_admins]
                changed = True
        if changed:
            auth_path.write_text(json.dumps(values))
            auth_path.chmod(0o600)
            gc("secrets", "versions", "add", AUTH_SECRET, f"--data-file={auth_path}")
    gc(
        "secrets",
        "add-iam-policy-binding",
        AUTH_SECRET,
        f"--member=serviceAccount:{RUNTIME}",
        "--role=roles/secretmanager.secretAccessor",
        "--condition=None",
    )
    version = secret_version()
    if not version:
        raise RuntimeError("No enabled auth secret version exists")
    print("Resources ready. Building and deploying the app …", flush=True)
    gc(
        "run",
        "deploy",
        SERVICE,
        "--source=.",
        f"--region={RUN_REGION}",
        f"--service-account={RUNTIME}",
        f"--build-service-account=projects/{PROJECT}/serviceAccounts/{BUILDER}",
        "--cpu=1",
        "--memory=1Gi",
        "--min=0",
        "--max=2",
        "--min-instances=0",
        "--max-instances=2",
        "--concurrency=4",
        "--timeout=300",
        "--cpu-throttling",
        "--no-cpu-boost",
        "--execution-environment=gen2",
        "--ingress=all",
        "--allow-unauthenticated",
        "--invoker-iam-check",
        "--default-url",
        f"--set-env-vars=PHOTO_BUCKET={BUCKET},GOOGLE_CLOUD_PROJECT={PROJECT},FIRESTORE_DATABASE={FIRESTORE_DATABASE},AUTH_SECRET_FILE=/var/run/secrets/fotovibe/auth.json",
        f"--set-secrets=/var/run/secrets/fotovibe/auth.json={AUTH_SECRET}:{version}",
        "--labels=app=fotovibe",
        live=True,
    )
    url = gc(
        "run",
        "services",
        "describe",
        SERVICE,
        f"--region={RUN_REGION}",
        "--format=value(status.url)",
    )
    print("Cloud Run is ready. Configuring custom domains and Cloud DNS …", flush=True)
    ensure_domains()
    source_bucket = f"gs://run-sources-{PROJECT}-{RUN_REGION}"
    if gc("storage", "buckets", "describe", source_bucket, "--format=json", missing_ok=True):
        gc("storage", "buckets", "update", source_bucket, f"--lifecycle-file={ROOT / 'infra/source-lifecycle.json'}")
    repository = gc(
        "artifacts", "repositories", "describe", "cloud-run-source-deploy",
        f"--location={RUN_REGION}", "--format=json", missing_ok=True,
    )
    if repository:
        gc(
            "artifacts", "repositories", "set-cleanup-policies", "cloud-run-source-deploy",
            f"--location={RUN_REGION}", f"--policy={ROOT / 'infra/artifact-cleanup.json'}",
        )
    (local / "deployment.json").write_text(
        json.dumps(
            {
                "project": PROJECT,
                "region": RUN_REGION,
                "storage_region": STORAGE_REGION,
                "bucket": BUCKET,
                "url": f"https://{DOMAINS[0]}",
                "invite_url": f"https://{DOMAINS[0]}/{values['invite_token']}",
                "service_url": url,
                "domains": list(DOMAINS),
                "secret_version": version,
            },
            indent=2,
        )
    )
    print(
        f"Service URL: {url}\n"
        f"Upload: https://{DOMAINS[0]}\n"
        f"Invite: https://{DOMAINS[0]}/{values['invite_token']}\n"
        f"Gallery: https://{DOMAINS[0]}/gallery\n"
        f"Party code is stored in Secret Manager ({AUTH_SECRET}, version {version}).\n"
        "On the first deployment, Google-managed HTTPS certificates can take time to become active.",
        flush=True,
    )


if __name__ == "__main__":
    main()
