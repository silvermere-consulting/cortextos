#!/usr/bin/env python3
"""cortextOS org restore — fetches from the .10 secondary host.

REPOINTED 2026-07-19: the email/IMAP restore path was removed together with
backup.py's email tier (Steve directive — R2 replaced the mailbox copy).
This script now restores from the .10 secondary (deploy@10.10.10.10), which
holds the FULL zip (CORE + projects sweep) — a strictly larger artifact than
the CORE zip the mailbox used to carry.

Restore sources, in order of preference:
  1. THIS SCRIPT — .10 secondary FULL zip (unencrypted, key-auth scp).
  2. Gateway copy (cortext@10.10.10.6:/home/cortext/backups/<org>-org/,
     CORE zip only, password-auth — see backup.py upload_to_gateway).
  3. R2 (off-vendor DR, encrypted): fetch backups/<org>/<zip>.enc, then
     python3 -c "import backup; backup._decrypt_file(src, dst, passphrase)"
     with BACKUP_ENCRYPT_PASSPHRASE from secrets.env. Envelope magic CTXS3E1.
     Restore-proven 2026-07-18 (see engineer daily memory of that date).

Usage:
  restore.py                        # restore to /tmp/cortextos-restore-YYYYMMDD-HHMMSS/
  restore.py --org family           # restore the family org instead
  restore.py --dest /path/to/dir    # restore to a specific directory
  restore.py --verify-only          # fetch + unzip + verify, then report (no live-system changes)
  restore.py --list                 # list available zips on the .10 secondary

Post-Restore checklist:
  1. Copy restored orgs/<org>/ over your live org directory.
  2. Re-add secrets: secrets.env, gsc-service-account.json (not in backup —
     retrieve from password manager or re-generate).
  3. cortextos start (or restart daemon) to reload agent configs.
  4. Verify agents come online: cortextos status
  5. Regenerate the knowledge base (ChromaDB is NOT in the backup — it is a
     derived index and fully regenerable from the restored source files):
       cortextos bus kb-ingest --org <org>
"""
import argparse
import os
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SECONDARY_TARGET = os.environ.get("BACKUP_SECONDARY_TARGET", "deploy@10.10.10.10")
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
            "-o", "StrictHostKeyChecking=accept-new"]

# Same namespace derivation as backup.py configure_org(): the default org
# keeps its historical remote dir name; other orgs get "<org>-org-full".
ORG_REMOTE_DIRS = {
    "silvermere-tech": "/home/deploy/backups/silvermere-org-full",
}


def remote_dir(org: str) -> str:
    return ORG_REMOTE_DIRS.get(org, f"/home/deploy/backups/{org}-org-full")


# Files that must be present in a valid backup (paths are org-prefixed in the
# zip). Non-default orgs get the generic subset only.
def required_paths(org: str) -> list:
    base = [f"{org}/knowledge.md", f"{org}/context.json", f"{org}/goals.json"]
    if org == "silvermere-tech":
        base += [f"{org}/agents/chief/config.json",
                 f"{org}/agents/chief/IDENTITY.md"]
    return base


def _ssh(cmd: list, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def list_remote_zips(org: str) -> list:
    """Return zip filenames on the secondary, newest first. Loud on failure —
    an unreachable host must never read as an empty backup set."""
    rdir = remote_dir(org)
    proc = _ssh(["ssh", *SSH_OPTS, SECONDARY_TARGET, f"ls -1t {rdir}/*.zip"])
    if proc.returncode != 0:
        print(f"ERROR: cannot list {SECONDARY_TARGET}:{rdir} — "
              f"{proc.stderr.strip() or f'rc={proc.returncode}'}", file=sys.stderr)
        sys.exit(1)
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def fetch_latest_zip(org: str, into_dir: str) -> str:
    """scp the newest zip from the secondary; returns the local path.
    Size-verifies the copy against the remote byte count (scp writes in
    place, and a truncated fetch must not restore silently)."""
    zips = list_remote_zips(org)
    if not zips:
        print(f"ERROR: no zips found in {remote_dir(org)} on {SECONDARY_TARGET}",
              file=sys.stderr)
        sys.exit(1)
    newest = zips[0]
    local = os.path.join(into_dir, os.path.basename(newest))
    proc = _ssh(["scp", *SSH_OPTS, f"{SECONDARY_TARGET}:{newest}", local])
    if proc.returncode != 0:
        print(f"ERROR: scp failed — {proc.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    stat = _ssh(["ssh", *SSH_OPTS, SECONDARY_TARGET, f"stat -c %s {newest}"])
    remote_size = stat.stdout.strip()
    local_size = os.path.getsize(local)
    if not remote_size.isdigit() or int(remote_size) != local_size:
        print(f"ERROR: size mismatch after fetch (remote={remote_size or '?'} "
              f"local={local_size})", file=sys.stderr)
        sys.exit(1)
    return local


def verify_restore(dest_dir: str, org: str) -> tuple:
    """Check that required paths exist in the restore dir. Returns (ok, found, missing)."""
    found, missing = [], []
    for rel_path in required_paths(org):
        if (Path(dest_dir) / rel_path).exists():
            found.append(rel_path)
        else:
            missing.append(rel_path)
    return len(missing) == 0, found, missing


def main():
    parser = argparse.ArgumentParser(
        description="Restore a cortextos org from the .10 secondary backup")
    parser.add_argument("--org", default="silvermere-tech",
                        help="Org to restore (default: silvermere-tech)")
    parser.add_argument("--dest", default=None,
                        help="Restore destination directory (default: /tmp/cortextos-restore-TIMESTAMP)")
    parser.add_argument("--verify-only", action="store_true",
                        help="Fetch, unzip, verify — don't modify live system")
    parser.add_argument("--list", action="store_true",
                        help="List available zips on the .10 secondary and exit")
    args = parser.parse_args()

    if args.list:
        zips = list_remote_zips(args.org)
        if not zips:
            print(f"No zips in {remote_dir(args.org)}.")
            return
        print(f"Zips on {SECONDARY_TARGET}:{remote_dir(args.org)} (newest first):")
        for z in zips:
            print(f"  {os.path.basename(z)}")
        return

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest_dir = args.dest or f"/tmp/cortextos-restore-{ts}"
    os.makedirs(dest_dir, exist_ok=True)

    print(f"Fetching latest {args.org} zip from {SECONDARY_TARGET}...")
    with tempfile.TemporaryDirectory() as tmp:
        local_zip = fetch_latest_zip(args.org, tmp)
        size_mb = os.path.getsize(local_zip) / (1024 * 1024)
        print(f"Fetched: {os.path.basename(local_zip)} ({size_mb:.2f} MB, size-verified)")
        with zipfile.ZipFile(local_zip, "r") as zf:
            bad = zf.testzip()
            if bad is not None:
                print(f"ERROR: zip corrupt at {bad}", file=sys.stderr)
                sys.exit(1)
            zf.extractall(dest_dir)
        print(f"Unzipped to: {dest_dir}")

    ok, found, missing = verify_restore(dest_dir, args.org)
    print(f"\nVerification: {len(found)}/{len(found) + len(missing)} required files present")
    for p in found:
        print(f"  OK  {p}")
    for p in missing:
        print(f"  MISSING  {p}")

    if ok:
        print("\nRestore VERIFIED — all required files present.")
        print("\nPost-restore steps:")
        print(f"  1. Copy {dest_dir}/{args.org}/ over your live org directory.")
        print("  2. Re-add secrets: secrets.env, gsc-service-account.json (not in backup).")
        print("  3. Restart daemon: cortextos start")
        print("  4. Check: cortextos status")
        print("  5. Regenerate KB (ChromaDB not in backup — derived, fully regenerable):")
        print(f"       cortextos bus kb-ingest --org {args.org}")
    else:
        print(f"\nWARN: restore incomplete — {len(missing)} required file(s) missing.",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
