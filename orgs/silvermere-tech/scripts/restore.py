#!/usr/bin/env python3
"""cortextOS org restore — Step 3.

Connects to bertha@silvermere.tech IMAP, fetches the most recent [BACKUP]
zip, downloads it, unzips it to a target directory, and verifies that the
key files are present.

Usage:
  restore.py                        # restore to /tmp/cortextos-restore-YYYYMMDD-HHMMSS/
  restore.py --dest /path/to/dir    # restore to a specific directory
  restore.py --verify-only          # fetch + unzip + verify, then report (no live-system changes)
  restore.py --list                 # list available [BACKUP] emails in bertha's inbox

After restore, copy the files into your cortextOS org directory and
restart agents as documented in the Post-Restore checklist below.

Post-Restore checklist:
  1. Copy restored orgs/silvermere-tech/ over your live org directory.
  2. Re-add secrets: secrets.env, gsc-service-account.json (not in backup —
     retrieve from password manager or re-generate).
  3. cortextos start (or restart daemon) to reload agent configs.
  4. Verify agents come online: cortextos status
  5. Regenerate the knowledge base (ChromaDB is NOT in the backup — it is a
     derived index and fully regenerable from the restored source files):
       cortextos bus kb-ingest --org silvermere-tech
     This re-indexes knowledge.md, project docs, and agent memory into
     ChromaDB. Step 2 (FTP) is NOT needed for KB recovery.
"""
import argparse
import email
import imaplib
import os
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SECRETS_FILE = Path("/home/cortext/cortextos/orgs/silvermere-tech/secrets.env")
BACKUP_SUBJECT_PREFIX = "[BACKUP]"

# Files that must be present in a valid backup
REQUIRED_PATHS = [
    "silvermere-tech/knowledge.md",
    "silvermere-tech/context.json",
    "silvermere-tech/goals.json",
    "silvermere-tech/agents/chief/config.json",
    "silvermere-tech/agents/chief/IDENTITY.md",
]


def load_secrets():
    secrets = {}
    with open(SECRETS_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            secrets[key.strip()] = val.strip()
    return secrets


def list_backups(imap) -> list[tuple[bytes, str, str]]:
    """Return list of (uid, subject, date) for [BACKUP] messages, newest first."""
    imap.select("INBOX")
    status, data = imap.search(None, f'SUBJECT "{BACKUP_SUBJECT_PREFIX}"')
    if status != "OK" or not data[0]:
        return []
    uids = data[0].split()
    results = []
    for uid in reversed(uids):  # newest first
        status2, msg_data = imap.fetch(uid, "(ENVELOPE)")
        if status2 != "OK":
            continue
        # Parse enough to get subject and date
        status3, header_data = imap.fetch(uid, "(BODY[HEADER.FIELDS (SUBJECT DATE)])")
        if status3 != "OK":
            continue
        raw = header_data[0][1] if isinstance(header_data[0], tuple) else b""
        msg = email.message_from_bytes(raw)
        subj = msg.get("Subject", "")
        date = msg.get("Date", "")
        results.append((uid, subj, date))
    return results


def fetch_latest_zip(imap) -> tuple[bytes, str] | None:
    """Fetch the most recent [BACKUP] zip attachment. Returns (zip_bytes, filename) or None."""
    imap.select("INBOX")
    status, data = imap.search(None, f'SUBJECT "{BACKUP_SUBJECT_PREFIX}"')
    if status != "OK" or not data[0]:
        return None
    uids = data[0].split()
    # Iterate from newest to oldest looking for one with an attachment
    for uid in reversed(uids):
        status2, msg_data = imap.fetch(uid, "(RFC822)")
        if status2 != "OK":
            continue
        raw = msg_data[0][1] if isinstance(msg_data[0], tuple) else b""
        msg = email.message_from_bytes(raw)
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            if part.get("Content-Disposition") is None:
                continue
            filename = part.get_filename()
            if filename and filename.endswith(".zip"):
                return part.get_payload(decode=True), filename
    return None


def verify_restore(dest_dir: str) -> tuple[bool, list[str], list[str]]:
    """Check that required paths exist in the restore dir. Returns (ok, found, missing)."""
    found, missing = [], []
    for rel_path in REQUIRED_PATHS:
        full = Path(dest_dir) / rel_path
        if full.exists():
            found.append(rel_path)
        else:
            missing.append(rel_path)
    return len(missing) == 0, found, missing


def main():
    parser = argparse.ArgumentParser(description="Restore silvermere-tech org from bertha IMAP backup")
    parser.add_argument("--dest", default=None,
                        help="Restore destination directory (default: /tmp/cortextos-restore-TIMESTAMP)")
    parser.add_argument("--verify-only", action="store_true",
                        help="Fetch, unzip, verify — don't modify live system")
    parser.add_argument("--list", action="store_true",
                        help="List available [BACKUP] emails and exit")
    args = parser.parse_args()

    try:
        secrets = load_secrets()
    except FileNotFoundError:
        print(f"ERROR: secrets file not found: {SECRETS_FILE}", file=sys.stderr)
        sys.exit(1)

    imap_host = secrets.get("HOSTINGER_IMAP_HOST", "imap.hostinger.com")
    imap_port = int(secrets.get("HOSTINGER_IMAP_PORT", 993))
    user = secrets["HOSTINGER_EMAIL"]
    password = secrets["HOSTINGER_EMAIL_APP_PASSWORD"]

    try:
        imap = imaplib.IMAP4_SSL(imap_host, imap_port)
        imap.login(user, password)
    except Exception as e:
        print(f"ERROR: IMAP connection failed — {e}", file=sys.stderr)
        sys.exit(1)

    if args.list:
        backups = list_backups(imap)
        imap.logout()
        if not backups:
            print("No [BACKUP] emails found in bertha's inbox.")
            return
        print(f"{'UID':<10} {'Date':<35} Subject")
        print("-" * 90)
        for uid, subj, date in backups:
            print(f"{uid.decode():<10} {date:<35} {subj}")
        return

    print("Fetching latest backup zip from bertha IMAP...")
    result = fetch_latest_zip(imap)
    imap.logout()

    if result is None:
        print("ERROR: no [BACKUP] zip attachment found in bertha's inbox.", file=sys.stderr)
        sys.exit(1)

    zip_bytes, zip_filename = result
    size_mb = len(zip_bytes) / (1024 * 1024)
    print(f"Fetched: {zip_filename} ({size_mb:.2f} MB)")

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest_dir = args.dest or f"/tmp/cortextos-restore-{ts}"
    os.makedirs(dest_dir, exist_ok=True)

    # Write zip to a temp file, then unzip
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp.write(zip_bytes)
        tmp_path = tmp.name

    try:
        with zipfile.ZipFile(tmp_path, "r") as zf:
            zf.extractall(dest_dir)
        print(f"Unzipped to: {dest_dir}")
    finally:
        os.unlink(tmp_path)

    # Verify
    ok, found, missing = verify_restore(dest_dir)
    print(f"\nVerification: {len(found)}/{len(REQUIRED_PATHS)} required files present")
    for p in found:
        print(f"  OK  {p}")
    for p in missing:
        print(f"  MISSING  {p}")

    if ok:
        print("\nRestore VERIFIED — all required files present.")
        print(f"\nPost-restore steps:")
        print(f"  1. Copy {dest_dir}/silvermere-tech/ over your live org directory.")
        print(f"  2. Re-add secrets: secrets.env, gsc-service-account.json (not in backup).")
        print(f"  3. Restart daemon: cortextos start")
        print(f"  4. Check: cortextos status")
        print(f"  5. Regenerate KB (ChromaDB not in backup — derived, fully regenerable):")
        print(f"       cortextos bus kb-ingest --org silvermere-tech")
    else:
        print(f"\nWARN: restore incomplete — {len(missing)} required file(s) missing.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
