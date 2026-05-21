#!/usr/bin/env python3
"""cortextOS org backup — Step 1 (zip + email).

Zips the silvermere-tech org's durable knowledge and config, then:
  - DAILY: emails the zip to bertha@silvermere.tech (self-managed retention,
    last 7 daily backups kept via IMAP prune).
  - WEEKLY (Sundays, or pass --weekly): also emails the zip to
    steven.barker@silvermereconsulting.com as an offsite copy.

Both sends use the system path (no auto-CC). The weekly send is TO Steven
by design, not a CC — it's his explicit offsite copy.

SIZE GUARD: zips exceeding SIZE_LIMIT_MB are rejected; the email is sent
without an attachment, noting what was skipped. The FTP step (Step 2,
TODO) handles larger payloads.

Usage:
  backup.py                   # daily mode (auto-weekly on Sundays)
  backup.py --weekly          # force weekly send today
  backup.py --dry-run         # build + size-check the zip, don't send

TODO Step 2: zip + FTP for larger payloads incl ChromaDB.
TODO Step 3: restore script in restore.py (companion to this script).
"""
import argparse
import imaplib
import os
import smtplib
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

ORG_ROOT = Path("/home/cortext/cortextos/orgs/silvermere-tech")
SECRETS_FILE = Path("/home/cortext/cortextos/orgs/silvermere-tech/secrets.env")
SIZE_LIMIT_MB = 20
DAILY_DEST = "bertha@silvermere.tech"
WEEKLY_DEST = "steven.barker@silvermereconsulting.com"
KEEP_DAILY = 7
BACKUP_SUBJECT_PREFIX = "[BACKUP]"

# Paths to include in the zip (relative to ORG_ROOT).
# Explicit inclusion list keeps the zip predictable and avoids accidental
# credential leaks (secrets.env, gsc-service-account.json are excluded).
INCLUDE_PATTERNS = [
    "knowledge.md",
    "context.json",
    "goals.json",
    "brand_tone.md",
    "brand-voice.md",
    "docs",
    "research",
    "scripts",
    # Per-agent bootstrap + memory (config.json, *.md, memory/*.md)
    "agents/*/config.json",
    "agents/*/*.md",
    "agents/*/memory",
    # Project docs (exclude clearspeak-studio/app — node_modules/build, ~641MB)
    "projects/gamesonthemove",
    "projects/business-in-a-box",
    "projects/dog-supplements",
    "projects/hiba-ventures",
    "projects/dashboard-tooling",
    "projects/server-reselling",
    "projects/smb-discovery",
    "projects/silvermere-tech-email",
    "projects/foundry",
    "projects/clearspeak-studio",  # node_modules/build/dist/.next stripped by EXCLUDE_DIRS
]

# Always exclude these patterns even if matched above
EXCLUDE_SUFFIXES = {".env", ".key", ".pem", ".p12", ".pfx", ".tsbuildinfo"}
EXCLUDE_NAMES = {"secrets.env", "gsc-service-account.json", ".env"}
EXCLUDE_DIRS = {"node_modules", ".git", "__pycache__", ".next", "dist", "build", ".cache"}


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


def should_exclude(path: Path) -> bool:
    if path.name in EXCLUDE_NAMES:
        return True
    if path.suffix.lower() in EXCLUDE_SUFFIXES:
        return True
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return True
    return False


def add_to_zip(zf: zipfile.ZipFile, src: Path, arc_base: Path) -> list[str]:
    """Recursively add src to zf, returning list of skipped paths."""
    skipped = []
    if src.is_file():
        if should_exclude(src):
            skipped.append(str(src))
        else:
            zf.write(src, arcname=src.relative_to(arc_base))
    elif src.is_dir():
        for child in sorted(src.rglob("*")):
            if child.is_file() and not should_exclude(child):
                zf.write(child, arcname=child.relative_to(arc_base))
            elif child.is_file():
                skipped.append(str(child))
    return skipped


def build_zip(dest_path: str) -> tuple[float, list[str]]:
    """Build the backup zip. Returns (size_mb, skipped_list)."""
    skipped: list[str] = []
    arc_base = ORG_ROOT.parent  # zip paths start from cortextos/orgs/

    seen: set[Path] = set()

    def add_once(zf, src, arc_base):
        """Add src to zip, skipping duplicates."""
        real = src.resolve()
        if real in seen:
            return []
        seen.add(real)
        return add_to_zip(zf, src, arc_base)

    with zipfile.ZipFile(dest_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for pattern in INCLUDE_PATTERNS:
            if "*" in pattern:
                # Use pathlib glob for patterns containing wildcards
                for match in sorted(ORG_ROOT.glob(pattern)):
                    if match.exists():
                        skipped.extend(add_once(zf, match, arc_base))
            else:
                target = ORG_ROOT / pattern
                if target.exists():
                    skipped.extend(add_once(zf, target, arc_base))

    size_mb = os.path.getsize(dest_path) / (1024 * 1024)
    return size_mb, skipped


def send_backup(smtp_host, smtp_port, sender, password, recipient, subject, body, zip_path=None):
    if zip_path:
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText(body, "plain", "utf-8"))
        with open(zip_path, "rb") as f:
            data = f.read()
        part = MIMEBase("application", "zip")
        part.set_payload(data)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", "attachment",
                        filename=os.path.basename(zip_path))
        msg.attach(part)
    else:
        msg = MIMEText(body, "plain", "utf-8")

    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject

    with smtplib.SMTP_SSL(smtp_host, smtp_port) as smtp:
        smtp.login(sender, password)
        smtp.sendmail(sender, [recipient], msg.as_string())


def prune_imap(host, port, user, password, keep_n=KEEP_DAILY):
    """Delete oldest [BACKUP] emails in bertha's inbox, keeping the last keep_n."""
    try:
        with imaplib.IMAP4_SSL(host, port) as imap:
            imap.login(user, password)
            imap.select("INBOX")
            # Search for messages with BACKUP prefix
            status, data = imap.search(None, f'SUBJECT "{BACKUP_SUBJECT_PREFIX}"')
            if status != "OK":
                return
            uids = data[0].split()
            # uids are in ascending order (oldest first)
            to_delete = uids[:-keep_n] if len(uids) > keep_n else []
            for uid in to_delete:
                imap.store(uid, "+FLAGS", "\\Deleted")
            if to_delete:
                imap.expunge()
                print(f"IMAP prune: deleted {len(to_delete)} old backup(s), kept {min(len(uids), keep_n)}")
    except Exception as e:
        print(f"WARN: IMAP prune failed — {e} (backup still sent)", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Backup silvermere-tech org to email")
    parser.add_argument("--weekly", action="store_true",
                        help="Force weekly send (also send to Steven). Default: auto on Sundays.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build zip and report size; do not send.")
    args = parser.parse_args()

    try:
        secrets = load_secrets()
    except FileNotFoundError:
        print(f"ERROR: secrets file not found: {SECRETS_FILE}", file=sys.stderr)
        sys.exit(1)

    smtp_host = secrets["HOSTINGER_SMTP_HOST"]
    smtp_port = int(secrets.get("HOSTINGER_SMTP_PORT", 465))
    imap_host = secrets.get("HOSTINGER_IMAP_HOST", "imap.hostinger.com")
    imap_port = int(secrets.get("HOSTINGER_IMAP_PORT", 993))
    sender = secrets["HOSTINGER_EMAIL"]
    password = secrets["HOSTINGER_EMAIL_APP_PASSWORD"]

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M UTC")
    subject = f"{BACKUP_SUBJECT_PREFIX} silvermere-tech {date_str} {time_str}"

    is_weekly = args.weekly or (now.weekday() == 6)  # 6 = Sunday

    with tempfile.TemporaryDirectory() as tmp:
        zip_path = os.path.join(tmp, f"silvermere-tech-backup-{date_str}.zip")
        print(f"Building backup zip...")
        size_mb, skipped = build_zip(zip_path)
        print(f"Zip size: {size_mb:.2f} MB")

        if skipped:
            print(f"Excluded {len(skipped)} file(s) (credentials/binaries)")

        over_limit = size_mb > SIZE_LIMIT_MB
        if over_limit:
            print(f"WARN: zip ({size_mb:.1f} MB) exceeds {SIZE_LIMIT_MB} MB limit — sending without attachment")
            body = (
                f"cortextOS org backup — {date_str}\n\n"
                f"Zip size: {size_mb:.1f} MB — EXCEEDS EMAIL LIMIT ({SIZE_LIMIT_MB} MB).\n"
                f"Attachment omitted. Payload awaits FTP step (Step 2 TODO).\n\n"
                f"Excluded {len(skipped)} credential/binary file(s).\n"
            )
            attach = None
        else:
            body = (
                f"cortextOS org backup — {date_str}\n\n"
                f"Zip size: {size_mb:.2f} MB\n"
                f"Contents: knowledge.md, context.json, goals.json, agent configs + bootstrap + memory, "
                f"docs, research, scripts, project docs (clearspeak-studio/app excluded).\n"
                f"Excluded credentials: secrets.env, gsc-service-account.json, .env files.\n\n"
                f"Excluded {len(skipped)} additional credential/binary file(s).\n\n"
                f"Restore: use scripts/restore.py to fetch + unzip from IMAP.\n"
            )
            attach = zip_path

        if args.dry_run:
            print(f"DRY RUN — would send to {DAILY_DEST}" + (f" + {WEEKLY_DEST}" if is_weekly else ""))
            if over_limit:
                print("DRY RUN — zip over limit, would send without attachment")
            return

        # Daily send → bertha (self-archive)
        print(f"Sending daily backup to {DAILY_DEST}...")
        send_backup(smtp_host, smtp_port, sender, password, DAILY_DEST, subject, body, attach)
        print(f"OK  daily backup sent ({size_mb:.2f} MB {'+ attachment' if attach else 'no attachment'})")

        # IMAP prune — keep last KEEP_DAILY daily backups
        prune_imap(imap_host, imap_port, sender, password, keep_n=KEEP_DAILY)

        # Weekly send → Steven (offsite copy)
        if is_weekly:
            print(f"Sending weekly offsite copy to {WEEKLY_DEST}...")
            weekly_subject = f"{subject} [weekly]"
            send_backup(smtp_host, smtp_port, sender, password, WEEKLY_DEST,
                        weekly_subject, body, attach)
            print(f"OK  weekly backup sent to {WEEKLY_DEST}")


if __name__ == "__main__":
    main()
