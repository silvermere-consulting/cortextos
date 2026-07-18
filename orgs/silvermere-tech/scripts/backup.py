#!/usr/bin/env python3
"""cortextOS org backup — Step 1 (zip + email) + Step 2 (FTPS off-site).

Zips the silvermere-tech org's durable knowledge and config, then:
  - DAILY: emails the zip to bertha@silvermere.tech (self-managed retention,
    last 7 daily backups kept via IMAP prune).
  - WEEKLY (Sundays, or pass --weekly): also emails the zip to
    steven.barker@silvermereconsulting.com as an offsite copy.
  - STEP 2 (if BACKUP_FTP_HOST configured in secrets.env): uploads the zip
    to an FTPS target for true off-site backup. Runs regardless of zip size
    — provides off-site backup for ALL daily zips, not just the oversized
    ones that fail the email path. Includes retention pruning.

Both email sends use the system path (no auto-CC). The weekly send is TO
Steven by design, not a CC — it's his explicit offsite copy.

SIZE GUARD on email: zips exceeding SIZE_LIMIT_MB are sent as a no-attachment
notification only — the FTP step (Step 2) is the recovery path for those.
If FTP is not configured AND the zip is oversized, the email body says so
explicitly so a human can manually intervene.

Usage:
  backup.py                   # daily mode (auto-weekly on Sundays)
  backup.py --weekly          # force weekly send today
  backup.py --dry-run         # build + size-check the zip, don't send
  backup.py --no-ftp          # skip Step 2 even if configured (one-off testing)

CONFIG (secrets.env keys for Step 2 — all optional; absence = Step 2 disabled):
  BACKUP_FTP_HOST              FTPS hostname (REQUIRED to enable Step 2)
  BACKUP_FTP_PORT              FTPS port (default 21)
  BACKUP_FTP_USER              login
  BACKUP_FTP_PASSWORD          login password
  BACKUP_FTP_PATH              remote dir for backups (default /)
  BACKUP_FTP_RETENTION_DAYS    purge older zips after N days (default 30)

TODO Step 3: restore script in restore.py (companion to this script).
"""
import argparse
import ftplib
import hashlib
import imaplib
import os
import re
import shutil
import smtplib
import ssl
import subprocess
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
# BACKUP_SECRETS_FILE / BACKUP_SIZE_LIMIT_MB: test-surface overrides so the
# loud-tier harness (workspace/backup-hardening/) can point a REAL run at
# sandboxed creds / a synthetic size limit without touching prod secrets or
# mailing bertha@. Defaults unchanged; production never sets them.
SECRETS_FILE = Path(os.environ.get(
    "BACKUP_SECRETS_FILE",
    "/home/cortext/cortextos/orgs/silvermere-tech/secrets.env"))
SIZE_LIMIT_MB = float(os.environ.get("BACKUP_SIZE_LIMIT_MB", "20"))
DAILY_DEST = "bertha@silvermere.tech"
WEEKLY_DEST = "steven.barker@silvermereconsulting.com"
KEEP_DAILY = 7
# Durable on-box retained copy. The zip is otherwise built in a TemporaryDirectory
# and discarded on exit — so on oversized days (no email attachment) with FTPS
# unconfigured there was NO retained copy anywhere. This guarantees at least one.
LOCAL_RETAIN_DIR = Path("/home/cortext/backups/org-daily")
KEEP_LOCAL = 14
BACKUP_SUBJECT_PREFIX = "[BACKUP]"

# Step 2b — off-host copy to the OVH gateway (internal infra, our own box).
# True off-host copy that survives total loss of the app VM. The gateway is a
# small 2.0G LXC, so retention is kept lean (zip ~55MB → 7 copies ~385MB).
GATEWAY_REMOTE_DIR = "/home/cortext/backups/silvermere-org"
KEEP_GATEWAY = 7

# Step 2c — git history off-host. EXCLUDE_DIRS strips every .git dir and the
# framework tree lives outside ORG_ROOT, so without this NO repo history ever
# leaves the box. Bundles go straight to the gateway and NEVER into the zip:
# adding them measured 30.67 MB against a 20 MB email limit, which silently
# drops the attachment — and the email tier is the documented restore path.
GIT_BUNDLE_DIR = ORG_ROOT / "backups" / "git"
GATEWAY_BUNDLE_DIR = "/home/cortext/backups/silvermere-git"
KEEP_BUNDLES = 7

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
    "backups/umami",               # self-host Umami DB dump (written fresh by dump_umami_db() each run)
    # NOTE (2026-07-09): git bundles are deliberately NOT included here.
    # EXCLUDE_DIRS strips every .git dir, so no repo history leaves this box —
    # a real DR gap. The obvious fix (add "backups/git") was measured and
    # REJECTED: it takes the zip from 13.3 MB to 30.67 MB, past SIZE_LIMIT_MB,
    # so the email tier silently drops its attachment. That tier is also the
    # documented restore path (restore.py fetches from IMAP), so we would have
    # traded a history gap for a restore gap and been told nothing.
    # Bundles go off-host via the gateway instead. See task_1783575583… .
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


# Clean-backup principle (Steve, 2026-06-24): back up source-of-truth, drop
# DERIVED artifacts. A PDF generated by doc-to-pdf.js is derived — it rebuilds
# from its source .md on restore — so it is excluded IFF a verified source .md
# exists. doc-to-pdf.js prepends a project-code prefix to the generated PDF
# filename (orgs/silvermere-tech/docs/wow-project-codes.md); we strip a known
# code prefix from the PDF stem before matching it to a same-directory .md.
# Match is same-dir + exact stem (version+date included) → high precision.
# When NO matching .md exists (orphan / external/provided PDF) → KEPT.
PROJECT_CODES = ["BiB", "ClSp", "Stry", "KMIP", "Hba", "Plnt", "GOTM", "Wllsp",
                 "SvrRs", "MCSv", "Bud", "HmOr", "FCal", "Fndy", "PCMsg", "SchE",
                 "cvSBH", "SrEm", "SCFr", "LFA", "TriOM", "FamD"]
_CODES_LC = sorted({c.lower() for c in PROJECT_CODES}, key=len, reverse=True)
_md_stem_cache: dict = {}


def _strip_code(stem: str) -> str:
    s = stem.lower()
    for c in _CODES_LC:
        if s.startswith(c + "-"):
            return s[len(c) + 1:]
    return s


def _dir_md_stems(directory: Path) -> set:
    """Cached set of code-stripped .md stems in a directory."""
    key = str(directory)
    if key not in _md_stem_cache:
        stems = set()
        try:
            for m in directory.glob("*.md"):
                stems.add(_strip_code(m.stem))
        except OSError:
            pass
        _md_stem_cache[key] = stems
    return _md_stem_cache[key]


def is_regenerable_pdf(path: Path) -> bool:
    """True if path is a PDF with a verified same-directory .md source sibling
    (derived artifact → excluded). False for non-PDFs and orphan/external PDFs
    with no .md source (→ kept). See clean-backup principle above."""
    if path.suffix.lower() != ".pdf":
        return False
    return _strip_code(path.stem) in _dir_md_stems(path.parent)


def should_exclude(path: Path) -> bool:
    if path.name in EXCLUDE_NAMES:
        return True
    if path.suffix.lower() in EXCLUDE_SUFFIXES:
        return True
    # A secrets file with a suffix APPENDED defeats the exact-suffix check above.
    # 2026-07-11: `.env.bak-pre-yoodli-test-20260710T211446Z` and
    # `secrets.env.bak-*` shipped off-box in the daily zip — each holding a live,
    # 108-char `sk-ant-api03-…` key — because their suffix is `.bak-pre-…`, not
    # `.env`, so `path.suffix == ".env"` never matched. A `.env` backup with a
    # timestamp appended is STILL A .ENV, and it still holds the secrets.
    #
    # So match `.env` as a NAME SEGMENT, not just as the final suffix. This catches
    # `.env.bak-*`, `.env.waitlist`, `secrets.env.20260602T…`, and every future
    # variant nobody has named yet — the class, not the instance. `.env.template`
    # and `.env.example` are placeholders (no real values) and are allowed through.
    name = path.name.lower()
    if (".env." in name or name.endswith(".env")) and not (
        name.endswith(".env.template") or name.endswith(".env.example")
    ):
        return True
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return True
    if is_regenerable_pdf(path):
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


def swept_projects(org_root: Path = None) -> tuple[list[Path], int, int]:
    """The FULL-zip projects sweep (task_1784285554485): EVERY dir under
    projects/ except those carrying their OWN git repo — the bundle tier
    auto-discovers those and ships their history, so sweeping their working
    tree would double coverage git already provides off-box.

    The criterion is DERIVED (has .git), never a hand list: a project that
    grows its own repo leaves the sweep automatically, and a new project is
    protected the day it exists — the INCLUDE_PATTERNS hand-list is how 25
    projects were born unprotected (nobody decided; a list decided).

    Returns (dirs_to_sweep, swept_count, census_count). BOTH counts are
    printed by the caller: an empty glob and a complete sweep print the same
    success unless the census denominator rides beside the swept number.

    org_root is a parameter (default silvermere) so a future org (family —
    task_1784286097725, conditional) is a config entry, not new code.
    """
    root = (org_root or ORG_ROOT) / "projects"
    if not root.exists():
        return [], 0, 0
    census = sorted(p for p in root.iterdir() if p.is_dir())
    swept = [p for p in census if not (p / ".git").exists()]
    return swept, len(swept), len(census)


def build_zip(dest_path: str, extra_dirs: list = None) -> tuple[float, list[str]]:
    """Build the backup zip. Returns (size_mb, skipped_list).
    extra_dirs: additional directories (the FULL-zip projects sweep) added
    after INCLUDE_PATTERNS; dedup via the same seen-set."""
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
        for extra in (extra_dirs or []):
            if extra.exists():
                skipped.extend(add_once(zf, extra, arc_base))

    size_mb = os.path.getsize(dest_path) / (1024 * 1024)
    return size_mb, skipped


def retain_local(zip_path: str, date_str: str) -> str:
    """Copy the built zip to a durable local path + prune old copies.
    The on-box retained snapshot — guarantees a retained copy exists even when
    the zip is oversized (no email attachment) AND FTPS is unconfigured."""
    try:
        LOCAL_RETAIN_DIR.mkdir(parents=True, exist_ok=True)
        dest = LOCAL_RETAIN_DIR / f"silvermere-tech-backup-{date_str}.zip"
        shutil.copy2(zip_path, dest)
        zips = sorted(LOCAL_RETAIN_DIR.glob("silvermere-tech-backup-*.zip"))
        pruned = 0
        for old in (zips[:-KEEP_LOCAL] if len(zips) > KEEP_LOCAL else []):
            try:
                old.unlink()
                pruned += 1
            except OSError:
                pass
        size_mb = dest.stat().st_size / (1024 * 1024)
        return f"Local retain: {dest} ({size_mb:.2f} MB); pruned {pruned}, keeping last {KEEP_LOCAL}"
    except Exception as e:
        return f"Local retain: FAILED — {e}"


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

    # BACKUP_SMTP_PLAIN=1: test-surface override (harness body arms) — plain
    # SMTP to a local sink, no TLS, no AUTH. The arms assert BODY CONTENT;
    # transport is not the object under test. Default (unset) unchanged.
    if os.environ.get("BACKUP_SMTP_PLAIN") == "1":
        with smtplib.SMTP(smtp_host, smtp_port) as smtp:
            smtp.send_message(msg)
        return
    with smtplib.SMTP_SSL(smtp_host, smtp_port) as smtp:
        smtp.login(sender, password)
        smtp.sendmail(sender, [recipient], msg.as_string())


def _ftp_connect(secrets):
    """Return (FTP_TLS connection, remote_dir) or None if Step 2 not configured."""
    host = secrets.get("BACKUP_FTP_HOST", "").strip()
    if not host:
        return None, None
    port = int(secrets.get("BACKUP_FTP_PORT", 21))
    user = secrets.get("BACKUP_FTP_USER", "").strip()
    password = secrets.get("BACKUP_FTP_PASSWORD", "").strip()
    remote_dir = secrets.get("BACKUP_FTP_PATH", "/").strip() or "/"

    ctx = ssl.create_default_context()
    ftps = ftplib.FTP_TLS(context=ctx)
    ftps.connect(host, port, timeout=60)
    ftps.login(user, password)
    ftps.prot_p()
    # cwd to target dir, creating leaf if necessary
    parts = [p for p in remote_dir.split("/") if p]
    ftps.cwd("/")
    for p in parts:
        try:
            ftps.cwd(p)
        except ftplib.error_perm:
            ftps.mkd(p)
            ftps.cwd(p)
    return ftps, remote_dir


def upload_to_ftp(secrets, zip_path: str) -> str:
    """Upload zip_path via FTPS. Returns one-line status string for email body."""
    try:
        ftps, remote_dir = _ftp_connect(secrets)
    except Exception as e:
        return f"FTP: FAILED to connect — {e}"
    if ftps is None:
        return "FTP: skipped (BACKUP_FTP_HOST not configured)"

    fname = os.path.basename(zip_path)
    try:
        with open(zip_path, "rb") as fh:
            ftps.storbinary(f"STOR {fname}", fh)
        size_mb = os.path.getsize(zip_path) / (1024 * 1024)
        try:
            ftps.quit()
        except Exception:
            ftps.close()
        return f"FTP: uploaded {fname} ({size_mb:.2f} MB) to {secrets['BACKUP_FTP_HOST']}:{remote_dir}"
    except Exception as e:
        try:
            ftps.close()
        except Exception:
            pass
        return f"FTP: upload FAILED — {e}"


_BACKUP_NAME_RE = re.compile(r"^silvermere-tech-backup-(\d{4}-\d{2}-\d{2})\.zip$")


def prune_ftp(secrets) -> str:
    """Delete backup zips on the FTPS target older than retention. Returns status line."""
    retention_days = int(secrets.get("BACKUP_FTP_RETENTION_DAYS", 30))
    try:
        ftps, _ = _ftp_connect(secrets)
    except Exception as e:
        return f"FTP prune: FAILED to connect — {e}"
    if ftps is None:
        return "FTP prune: skipped (not configured)"

    try:
        names = ftps.nlst()
    except Exception as e:
        try:
            ftps.close()
        except Exception:
            pass
        return f"FTP prune: listing FAILED — {e}"

    from datetime import datetime as _dt, timedelta as _td
    cutoff = _dt.now(timezone.utc).date() - _td(days=retention_days)
    deleted = 0
    for n in names:
        m = _BACKUP_NAME_RE.match(os.path.basename(n))
        if not m:
            continue
        try:
            file_date = _dt.strptime(m.group(1), "%Y-%m-%d").date()
        except ValueError:
            continue
        if file_date < cutoff:
            try:
                ftps.delete(n)
                deleted += 1
            except Exception:
                pass

    try:
        ftps.quit()
    except Exception:
        ftps.close()
    return f"FTP prune: deleted {deleted} backup(s) older than {retention_days}d"


def _run_ssh(cmd_args, env, timeout=120):
    """Run an ssh/scp command (cmd_args already starts with 'ssh'/'scp') detached
    from any controlling tty via setsid so SSH_ASKPASS is honoured for password
    auth. Returns (returncode, stdout, stderr)."""
    full = ["setsid", "-w"] + cmd_args
    p = subprocess.run(full, env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def _discover_repos() -> dict:
    """Every local git repo whose history exists ONLY on this box.

    Agent snapshot repos are enumerated, never hardcoded — the auto-commit cron
    creates one per agent, so a hardcoded list silently misses new agents.
    """
    repos = {}
    fw = Path("/home/cortext/cortextos")
    if (fw / ".git").is_dir():
        repos["cortextos-framework"] = fw / ".git"
    prod = Path("/home/cortext/.silvermere-prod.git")
    if prod.is_dir():
        repos["silvermere-prod"] = prod
    # org-projects snapshot repo (task_1784286990142): history for the 33
    # swept projects — same external-git-dir pattern as the prod repo above.
    snap = Path("/home/cortext/.silvermere-projects-snapshot.git")
    if snap.is_dir():
        repos["silvermere-projects-snapshot"] = snap
    for agent_git in sorted(Path("/home/cortext/cortextos/orgs").glob("*/agents/*/.git")):
        if agent_git.is_dir():
            repos[f"agent-{agent_git.parent.name}"] = agent_git
    for proj_git in sorted(Path("/home/cortext/cortextos/orgs").glob("*/projects/*/.git")):
        if proj_git.is_dir():
            repos[f"project-{proj_git.parent.name}"] = proj_git
    return repos


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _bundle_sidecar(bundle: Path) -> Path:
    return bundle.with_name(bundle.name + ".sha256")


def make_git_bundles() -> tuple:
    """Regenerate a fresh bundle per repo, then VERIFY each one.

    Returns (ok, status). Fails loudly: a corrupt or empty bundle that copies
    cleanly is a silent-null wearing a success badge, and a stale bundle that
    is merely re-shipped is the same bug slowed down. Both are why this
    rebuilds every run and verifies before anything leaves the box.

    AT-REST INTEGRITY (task_1784294569313): `git bundle verify` checks
    prerequisites + signature but NOT the packfile tail — a bundle truncated
    to HALF passes rc=0 (reproduced independently by chief). So verify alone
    cannot detect on-disk rot. Each bundle gets a sha256 SIDECAR written at
    creation; the upload legs assert the REMOTE bytes hash back to this
    creation-time value, which closes both gaps (local rot between creation
    and upload, and remote rot/truncation) with one artifact.
    """
    repos = _discover_repos()
    if not repos:
        return False, "Bundles: FAILED — no git repos discovered"

    GIT_BUNDLE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    made, failed, skipped = [], [], []

    for name, git_dir in repos.items():
        # A repo with zero refs has no history to bundle: `git bundle create --all`
        # refuses it (exit 128, writes no file). That is not a backup failure —
        # there is nothing to protect — and failing the tier for it strands the
        # HEALTHY repos' bundles on the box, unshipped.
        #
        # But an UNREADABLE repo also lists no refs, and that IS a failure. Both
        # print nothing; only the exit code tells them apart (measured 2026-07-10):
        #     zero-ref  -> for-each-ref rc=0,   stdout empty
        #     corrupt   -> for-each-ref rc=128, stdout empty
        # So skip only on a POSITIVE proof of readability: rc==0 AND no refs.
        # Gating on empty output alone would silently skip a corrupted repo.
        try:
            probe = subprocess.run(["git", f"--git-dir={git_dir}", "for-each-ref", "--count=1"],
                                   capture_output=True, text=True, timeout=60)
        except Exception as e:  # noqa: BLE001 - an unprobeable repo is a failure, not a skip
            failed.append(f"{name}(probe:{type(e).__name__})")
            continue
        if probe.returncode == 0 and not probe.stdout.strip():
            skipped.append(name)
            continue

        dest = GIT_BUNDLE_DIR / f"{name}-{stamp}.bundle"
        try:
            r = subprocess.run(["git", f"--git-dir={git_dir}", "bundle", "create", str(dest), "--all"],
                               capture_output=True, text=True, timeout=300)
            if r.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
                failed.append(f"{name}(create)")
                continue
            # --git-dir anchors verify to the SOURCE repo (task_1783642231441):
            # `git bundle verify` needs a repository to resolve prerequisites
            # against, and with none it fails "need a repository to verify a
            # bundle" — so today's verify passes only by accident of the
            # process CWD being inside some git repo. Run backup.py from /tmp
            # and every repo would land in `failed`, each fresh bundle unlink'd,
            # the whole tier down, with the status line naming six innocent
            # repos and pointing away from the cwd cause. Anchoring to the
            # bundle's own source repo is also strictly more correct than
            # verifying against an arbitrary bystander repo.
            v = subprocess.run(["git", f"--git-dir={git_dir}", "bundle", "verify", str(dest)],
                               capture_output=True, text=True, timeout=120)
            if v.returncode != 0:
                failed.append(f"{name}(verify)")
                dest.unlink(missing_ok=True)
                continue
            # Creation-time hash. Written AFTER verify so a bundle that dies
            # in verify never leaves a sidecar behind to vouch for it.
            _bundle_sidecar(dest).write_text(f"{_sha256(dest)}  {dest.name}\n")
            made.append(dest)
        except Exception as e:  # noqa: BLE001 - report, never mask
            failed.append(f"{name}({type(e).__name__})")

    # One-time backfill: retained bundles from before the sidecar existed get
    # hashed NOW. That anchors integrity from today, not from their creation —
    # stated honestly: rot BEFORE this backfill is invisible to it. They did
    # pass `git bundle verify` + a size-assert on their original upload.
    backfilled = 0
    for b in GIT_BUNDLE_DIR.glob("*.bundle"):
        sc = _bundle_sidecar(b)
        if not sc.exists():
            sc.write_text(f"{_sha256(b)}  {b.name}\n")
            backfilled += 1

    # Prune old local bundles per repo by LEXICAL name sort. Names carry an
    # ISO-basic UTC stamp so lexical == chronological, which is immune to the
    # mtime churn that bites `ls -t` when files are restored or re-copied.
    for name in repos:
        old = sorted(GIT_BUNDLE_DIR.glob(f"{name}-*.bundle"))
        for stale in old[:-KEEP_BUNDLES]:
            stale.unlink(missing_ok=True)
            _bundle_sidecar(stale).unlink(missing_ok=True)

    skip_note = f", skipped {len(skipped)} empty ({', '.join(sorted(skipped))})" if skipped else ""

    if failed:
        return False, f"Bundles: FAILED — {', '.join(failed)} (made {len(made)}{skip_note})"
    if not made:
        # Every repo skipped => nothing fresh to ship. Returning True here would let
        # upload_git_bundles() re-scp the RETAINED bundles and call it a success —
        # a stale bundle wearing a success badge, which this tier exists to prevent.
        return False, f"Bundles: FAILED — no repo produced a bundle{skip_note}"

    hash_note = f" + sha256 sidecars ({backfilled} backfilled)" if backfilled else " + sha256 sidecars"
    total_mb = sum(p.stat().st_size for p in made) / (1024 * 1024)
    return True, (f"Bundles: {len(made)} repo(s) bundled + verified{hash_note} ({total_mb:.2f} MB), "
                  f"keep last {KEEP_BUNDLES}{skip_note}")


def _load_creation_hashes(bundles) -> tuple:
    """Read each bundle's creation-time sidecar into {name: hex}.
    Returns (dict, "") or (None, reason). A missing/malformed sidecar is a
    REFUSAL, not a recompute — hashing the current bytes at upload time would
    vouch for exactly the rot the sidecar exists to catch."""
    hashes = {}
    for b in bundles:
        sc = _bundle_sidecar(b)
        if not sc.exists():
            return None, f"no sha256 sidecar for {b.name}"
        hx = sc.read_text().split()[0].strip().lower() if sc.read_text().split() else ""
        if not re.fullmatch(r"[0-9a-f]{64}", hx):
            return None, f"malformed sha256 sidecar for {b.name}"
        hashes[b.name] = hx
    return hashes, ""


def _parse_sha256sum(out: str) -> dict:
    """`sha256sum` output -> {basename: hex}, tolerating the `*name` binary marker."""
    remote = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            remote[os.path.basename(parts[-1].lstrip("*"))] = parts[0]
    return remote


def upload_git_bundles(secrets) -> tuple:
    """Ship this run's bundles to the gateway. Returns (ok, status).

    Never touches the zip or the email attachment. Verifies the remote bytes
    hash back to each bundle's CREATION-time sha256 before reporting success
    (task_1784294569313 — `git bundle verify` passes a half-truncated file,
    and a size-assert passes rot that keeps the length), then prunes to
    KEEP_BUNDLES per repo.
    """
    host = secrets.get("TRAEFIK_GATEWAY_HOST", "").strip()
    user = secrets.get("TRAEFIK_GATEWAY_SSH_USER", "").strip()
    password = secrets.get("TRAEFIK_GATEWAY_SSH_PASSWORD", "").strip()
    if not (host and user and password):
        return False, "Bundles->gateway: FAILED (TRAEFIK_GATEWAY_* not configured)"

    bundles = sorted(GIT_BUNDLE_DIR.glob("*.bundle"))
    if not bundles:
        return False, "Bundles->gateway: FAILED (nothing to upload)"
    hashes, why = _load_creation_hashes(bundles)
    if hashes is None:
        return False, f"Bundles->gateway: FAILED ({why})"

    askpass_path = None
    try:
        fd, askpass_path = tempfile.mkstemp(prefix="bk_askpass_", suffix=".sh")
        with os.fdopen(fd, "w") as f:
            f.write('#!/bin/sh\necho "$GW_SSH_PW"\n')
        os.chmod(askpass_path, 0o700)
        env = os.environ.copy()
        env["GW_SSH_PW"] = password
        env["SSH_ASKPASS"] = askpass_path
        env["SSH_ASKPASS_REQUIRE"] = "force"
        env["DISPLAY"] = env.get("DISPLAY", ":0")

        ssh_opts = ["-o", "StrictHostKeyChecking=accept-new",
                    "-o", "ConnectTimeout=30", "-o", "BatchMode=no"]
        target = f"{user}@{host}"

        rc, _o, err = _run_ssh(["ssh"] + ssh_opts + [target, f"mkdir -p {GATEWAY_BUNDLE_DIR}"], env)
        if rc != 0:
            return False, f"Bundles->gateway: FAILED (mkdir) — {err.strip() or rc}"

        sidecars = [str(_bundle_sidecar(b)) for b in bundles]
        rc, _o, err = _run_ssh(
            ["scp"] + ssh_opts + [str(b) for b in bundles] + sidecars + [f"{target}:{GATEWAY_BUNDLE_DIR}/"],
            env, timeout=600)
        if rc != 0:
            return False, f"Bundles->gateway: FAILED (scp) — {err.strip() or rc}"

        # Hash-assert against the CREATION-time sidecar, one ssh for the set.
        rc, out, err = _run_ssh(
            ["ssh"] + ssh_opts + [target, f"cd {GATEWAY_BUNDLE_DIR} && sha256sum *.bundle"],
            env, timeout=300)
        if rc != 0:
            return False, f"Bundles->gateway: FAILED (remote sha256sum) — {err.strip() or rc}"
        remote = _parse_sha256sum(out)
        for b in bundles:
            if remote.get(b.name) != hashes[b.name]:
                return False, (f"Bundles->gateway: FAILED (hash mismatch on {b.name}: "
                               f"creation={hashes[b.name][:12]}… remote={(remote.get(b.name) or '?')[:12]}…)")

        # Lexical prune per repo prefix — same reasoning as the local prune.
        # Each pruned bundle takes its .sha256 sidecar with it.
        prefixes = sorted({b.name.rsplit("-", 1)[0] for b in bundles})
        for pref in prefixes:
            prune = (f"ls -1 {GATEWAY_BUNDLE_DIR}/{pref}-*.bundle 2>/dev/null "
                     f"| sort | head -n -{KEEP_BUNDLES} "
                     f"| while IFS= read -r f; do rm -f \"$f\" \"$f.sha256\"; done")
            _run_ssh(["ssh"] + ssh_opts + [target, prune], env)

        total_mb = sum(b.stat().st_size for b in bundles) / (1024 * 1024)
        return True, (f"Bundles->gateway: {len(bundles)} file(s) ({total_mb:.2f} MB) -> "
                      f"{host}:{GATEWAY_BUNDLE_DIR} (sha256-verified vs creation, keep last {KEEP_BUNDLES})")
    except Exception as e:  # noqa: BLE001
        return False, f"Bundles->gateway: FAILED — {e}"
    finally:
        if askpass_path:
            try:
                os.unlink(askpass_path)
            except OSError:
                pass


def upload_to_gateway(secrets, zip_path: str) -> str:
    """Step 2b — off-host copy of the zip to the OVH gateway over SSH/scp.
    Internal infra (our own box), so no spend/approval gate. Verifies the remote
    byte-size matches local before reporting success, then prunes to KEEP_GATEWAY.
    Returns a one-line status string for the email body."""
    host = secrets.get("TRAEFIK_GATEWAY_HOST", "").strip()
    user = secrets.get("TRAEFIK_GATEWAY_SSH_USER", "").strip()
    password = secrets.get("TRAEFIK_GATEWAY_SSH_PASSWORD", "").strip()
    if not (host and user and password):
        return "Gateway: skipped (TRAEFIK_GATEWAY_* not configured)"

    askpass_path = None
    try:
        fd, askpass_path = tempfile.mkstemp(prefix="bk_askpass_", suffix=".sh")
        with os.fdopen(fd, "w") as f:
            f.write('#!/bin/sh\necho "$GW_SSH_PW"\n')
        os.chmod(askpass_path, 0o700)
        env = os.environ.copy()
        env["GW_SSH_PW"] = password
        env["SSH_ASKPASS"] = askpass_path
        env["SSH_ASKPASS_REQUIRE"] = "force"
        env["DISPLAY"] = env.get("DISPLAY", ":0")

        ssh_opts = ["-o", "StrictHostKeyChecking=accept-new",
                    "-o", "ConnectTimeout=30", "-o", "BatchMode=no"]
        target = f"{user}@{host}"
        fname = os.path.basename(zip_path)
        remote_file = f"{GATEWAY_REMOTE_DIR}/{fname}"

        rc, _out, err = _run_ssh(["ssh"] + ssh_opts + [target, f"mkdir -p {GATEWAY_REMOTE_DIR}"], env)
        if rc != 0:
            return f"Gateway: FAILED (mkdir) — {err.strip() or rc}"

        rc, _out, err = _run_ssh(
            ["scp"] + ssh_opts + [zip_path, f"{target}:{remote_file}"], env, timeout=300)
        if rc != 0:
            return f"Gateway: FAILED (scp) — {err.strip() or rc}"

        # Verify the copy landed intact: remote byte-size must equal local.
        local_size = os.path.getsize(zip_path)
        rc, out, _err = _run_ssh(["ssh"] + ssh_opts + [target, f"stat -c %s {remote_file}"], env)
        remote_size = out.strip()
        if rc != 0 or not remote_size.isdigit() or int(remote_size) != local_size:
            return (f"Gateway: FAILED (size mismatch: local={local_size} "
                    f"remote={remote_size or '?'})")

        # Prune to last KEEP_GATEWAY by mtime (newest kept).
        prune_cmd = (f"ls -1t {GATEWAY_REMOTE_DIR}/silvermere-tech-backup-*.zip 2>/dev/null "
                     f"| tail -n +{KEEP_GATEWAY + 1} | xargs -r rm -f")
        _run_ssh(["ssh"] + ssh_opts + [target, prune_cmd], env)

        size_mb = local_size / (1024 * 1024)
        return (f"Gateway: uploaded {fname} ({size_mb:.2f} MB) to {host}:{GATEWAY_REMOTE_DIR} "
                f"(size-verified, keep last {KEEP_GATEWAY})")
    except Exception as e:
        return f"Gateway: FAILED — {e}"
    finally:
        if askpass_path:
            try:
                os.unlink(askpass_path)
            except OSError:
                pass


# BACKUP_SECONDARY_TARGET: test-surface override (harness sandboxes this at a
# black-hole host so its real-run arms never touch .10). Default is production.
SECONDARY_TARGET = os.environ.get("BACKUP_SECONDARY_TARGET", "deploy@10.10.10.10")  # key-based ssh, proven path (umami tier)
SECONDARY_REMOTE_DIR = "/home/deploy/backups/silvermere-org-full"
KEEP_SECONDARY = 7
SECONDARY_BUNDLE_DIR = "/home/deploy/backups/silvermere-org-git-bundles"


def upload_to_secondary(zip_path: str) -> str:
    """Step 2c — the FULL zip to docker01 (.10, 167G free). Second off-host
    copy on a distinct machine; the scp tiers have no 20MB ceiling, so this is
    where the projects sweep lives (task_1784285554485). Key-based auth — no
    askpass. Same contract as the gateway tier: byte-size verified before
    success is reported, prune to KEEP_SECONDARY, and a FAILED string here is
    turned into a nonzero exit by the tier-failure collection in main()."""
    ssh_opts = ["-o", "StrictHostKeyChecking=accept-new",
                "-o", "ConnectTimeout=30", "-o", "BatchMode=yes"]
    env = os.environ.copy()
    fname = os.path.basename(zip_path)
    remote_file = f"{SECONDARY_REMOTE_DIR}/{fname}"
    try:
        rc, _out, err = _run_ssh(["ssh"] + ssh_opts + [SECONDARY_TARGET, f"mkdir -p {SECONDARY_REMOTE_DIR}"], env)
        if rc != 0:
            return f"Secondary: FAILED (mkdir) — {err.strip() or rc}"
        rc, _out, err = _run_ssh(
            ["scp"] + ssh_opts + [zip_path, f"{SECONDARY_TARGET}:{remote_file}"], env, timeout=600)
        if rc != 0:
            return f"Secondary: FAILED (scp) — {err.strip() or rc}"
        local_size = os.path.getsize(zip_path)
        rc, out, _err = _run_ssh(["ssh"] + ssh_opts + [SECONDARY_TARGET, f"stat -c %s {remote_file}"], env)
        remote_size = out.strip()
        if rc != 0 or not remote_size.isdigit() or int(remote_size) != local_size:
            return (f"Secondary: FAILED (size mismatch: local={local_size} "
                    f"remote={remote_size or '?'})")
        prune_cmd = (f"ls -1t {SECONDARY_REMOTE_DIR}/silvermere-tech-backup-full-*.zip 2>/dev/null "
                     f"| tail -n +{KEEP_SECONDARY + 1} | xargs -r rm -f")
        _run_ssh(["ssh"] + ssh_opts + [SECONDARY_TARGET, prune_cmd], env)
        size_mb = local_size / (1024 * 1024)
        return (f"Secondary: uploaded {fname} ({size_mb:.2f} MB) to {SECONDARY_TARGET}:{SECONDARY_REMOTE_DIR} "
                f"(size-verified, keep last {KEEP_SECONDARY})")
    except Exception as e:
        return f"Secondary: FAILED — {e}"


def upload_git_bundles_secondary() -> tuple:
    """Second home for this run's bundles: docker01 (.10, 167G), over the
    key-based ssh path the FULL zip already uses. Same contract as the
    gateway leg — byte-size verified per file before success, lexical prune
    to KEEP_BUNDLES per repo prefix. Added 2026-07-18 (task_1784325977603):
    the bundle tier was single-homed on the gateway disk that filled to
    100% while the ZIP had already been dual-homed — when you add a
    fallback, ask which OTHER tier still shares the same single point of
    failure. Returns (ok, status)."""
    bundles = sorted(GIT_BUNDLE_DIR.glob("*.bundle"))
    if not bundles:
        return False, "Bundles->secondary: FAILED (nothing to upload)"
    hashes, why = _load_creation_hashes(bundles)
    if hashes is None:
        return False, f"Bundles->secondary: FAILED ({why})"
    ssh_opts = ["-o", "StrictHostKeyChecking=accept-new",
                "-o", "ConnectTimeout=30", "-o", "BatchMode=yes"]
    env = os.environ.copy()
    try:
        rc, _o, err = _run_ssh(["ssh"] + ssh_opts + [SECONDARY_TARGET, f"mkdir -p {SECONDARY_BUNDLE_DIR}"], env)
        if rc != 0:
            return False, f"Bundles->secondary: FAILED (mkdir) — {err.strip() or rc}"
        sidecars = [str(_bundle_sidecar(b)) for b in bundles]
        rc, _o, err = _run_ssh(
            ["scp"] + ssh_opts + [str(b) for b in bundles] + sidecars + [f"{SECONDARY_TARGET}:{SECONDARY_BUNDLE_DIR}/"],
            env, timeout=600)
        if rc != 0:
            return False, f"Bundles->secondary: FAILED (scp) — {err.strip() or rc}"
        # Hash-assert against the CREATION-time sidecar, one ssh for the set.
        rc, out, err = _run_ssh(
            ["ssh"] + ssh_opts + [SECONDARY_TARGET, f"cd {SECONDARY_BUNDLE_DIR} && sha256sum *.bundle"],
            env, timeout=300)
        if rc != 0:
            return False, f"Bundles->secondary: FAILED (remote sha256sum) — {err.strip() or rc}"
        remote = _parse_sha256sum(out)
        for b in bundles:
            if remote.get(b.name) != hashes[b.name]:
                return False, (f"Bundles->secondary: FAILED (hash mismatch on {b.name}: "
                               f"creation={hashes[b.name][:12]}… remote={(remote.get(b.name) or '?')[:12]}…)")
        # Lexical prune per repo prefix — same reasoning as the gateway leg.
        # Each pruned bundle takes its .sha256 sidecar with it.
        prefixes = sorted({b.name.rsplit("-", 1)[0] for b in bundles})
        for pref in prefixes:
            prune = (f"ls -1 {SECONDARY_BUNDLE_DIR}/{pref}-*.bundle 2>/dev/null "
                     f"| sort | head -n -{KEEP_BUNDLES} "
                     f"| while IFS= read -r f; do rm -f \"$f\" \"$f.sha256\"; done")
            _run_ssh(["ssh"] + ssh_opts + [SECONDARY_TARGET, prune], env)
        total_mb = sum(b.stat().st_size for b in bundles) / (1024 * 1024)
        return True, (f"Bundles->secondary: {len(bundles)} file(s) ({total_mb:.2f} MB) -> "
                      f"{SECONDARY_TARGET}:{SECONDARY_BUNDLE_DIR} (sha256-verified vs creation, keep last {KEEP_BUNDLES})")
    except Exception as e:  # noqa: BLE001
        return False, f"Bundles->secondary: FAILED — {e}"


def relocate_from_junk(host, port, user, password, subject, attempts=6, delay=5):
    """Move a self-sent daily backup from INBOX.Junk back to INBOX.

    Hostinger's spam filter heuristically files bertha->bertha automated mail
    (base64 zip + automated pattern) into Junk — it is NOT an auth failure (SPF
    passes). ManageSieve (port 4190) is TCP-open but resets real sessions
    (firewalled to Hostinger's own hosts), so a server-side filter is not
    reachable from here. Instead, after the send, find the message by exact
    subject and IMAP UID-MOVE it to INBOX so retention + restore see it where
    expected. Best-effort with a short retry for LDA delivery lag; failure is
    non-fatal — restore.py also searches Junk as a safety net."""
    import time
    try:
        with imaplib.IMAP4_SSL(host, port) as imap:
            imap.login(user, password)
            typ, caps = imap.capability()
            has_move = b"MOVE" in caps[0].upper()
            for _ in range(attempts):
                imap.select("INBOX.Junk")
                status, data = imap.search(None, f'SUBJECT "{subject}"')
                seqs = data[0].split() if status == "OK" and data and data[0] else []
                if seqs:
                    moved = 0
                    for seq in seqs:
                        st, u = imap.fetch(seq, "(UID)")
                        m = re.search(rb"UID (\d+)", (u[0] or b"") if u else b"")
                        if not m:
                            continue
                        uid = m.group(1).decode()
                        if has_move:
                            imap.uid("MOVE", uid, "INBOX")
                        else:
                            imap.uid("COPY", uid, "INBOX")
                            imap.uid("STORE", uid, "+FLAGS", "\\Deleted")
                            imap.expunge()
                        moved += 1
                    if moved:
                        print(f"IMAP relocate: moved {moved} backup(s) Junk -> INBOX")
                        return True
                time.sleep(delay)
            print("IMAP relocate: backup not found in Junk "
                  "(delivered straight to INBOX, or LDA lag > wait window)")
            return False
    except Exception as e:
        print(f"WARN: IMAP relocate failed — {e} "
              "(non-fatal; restore.py also searches Junk)", file=sys.stderr)
        return False


def prune_imap(host, port, user, password, keep_n=KEEP_DAILY):
    """Delete oldest [BACKUP] emails, keeping the last keep_n in each folder.

    Self-sent daily backups (bertha -> bertha) are spam-filtered into INBOX.Junk
    by Hostinger, so retention must be enforced there too — pruning INBOX alone
    leaves Junk to grow unbounded. restore.py reads both folders."""
    try:
        with imaplib.IMAP4_SSL(host, port) as imap:
            imap.login(user, password)
            for folder in ("INBOX", "INBOX.Junk"):
                status, _ = imap.select(f'"{folder}"')
                if status != "OK":
                    continue  # folder may not exist on this mailbox
                # Search for messages with BACKUP prefix (seq nums, oldest first)
                status, data = imap.search(None, f'SUBJECT "{BACKUP_SUBJECT_PREFIX}"')
                if status != "OK" or not data or not data[0]:
                    continue
                uids = data[0].split()
                to_delete = uids[:-keep_n] if len(uids) > keep_n else []
                for uid in to_delete:
                    imap.store(uid, "+FLAGS", "\\Deleted")
                if to_delete:
                    imap.expunge()
                    print(f"IMAP prune [{folder}]: deleted {len(to_delete)} old "
                          f"backup(s), kept {min(len(uids), keep_n)}")
    except Exception as e:
        print(f"WARN: IMAP prune failed — {e} (backup still sent)", file=sys.stderr)


def dump_umami_db() -> str:
    """Pull the newest .10 umami pg_dump into ORG_ROOT/backups/umami so the
    file-collection step rides it into the daily zip. Best-effort: NEVER raises —
    a pull failure must not break the org file backup.

    Umami was cut over .135 -> .10 (docker01) on 2026-07-04; the DB now lives on
    .10, so the old local `docker exec silvermere-umami-db pg_dump` here went dead
    (container removed 2026-07-05). A nightly pg_dump timer on .10 writes gzipped
    dumps to /home/deploy/umami/backups/; we scp-pull the newest via the deploy@
    key so the .10 analytics DB inherits the org backup's off-host tiers.
    Added 2026-06-29, repointed to .10 pull 2026-07-05 (task_1783219218170)."""
    out_dir = ORG_ROOT / "backups" / "umami"
    out_file = out_dir / "umami-db.sql.gz"
    remote = "deploy@10.10.10.10"
    remote_dir = "/home/deploy/umami/backups"
    ssh_opts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                "-o", "StrictHostKeyChecking=accept-new"]
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        newest = subprocess.run(
            ["ssh", *ssh_opts, remote,
             f"ls -1t {remote_dir}/umami-*.sql.gz 2>/dev/null | head -1"],
            capture_output=True, text=True, timeout=40).stdout.strip()
        if not newest:
            return f"skipped (no remote dump at {remote}:{remote_dir})"
        subprocess.run(
            ["scp", *ssh_opts, f"{remote}:{newest}", str(out_file)],
            check=True, capture_output=True, timeout=180)
        if out_file.exists() and out_file.stat().st_size > 0:
            return f"OK pulled {os.path.basename(newest)} ({out_file.stat().st_size:,} bytes) from .10"
        return "FAILED (pulled file empty/missing)"
    except Exception as e:  # noqa: BLE001 — best-effort, never break the file backup
        return f"skipped (error: {e})"


def main():
    parser = argparse.ArgumentParser(description="Backup silvermere-tech org to email")
    parser.add_argument("--weekly", action="store_true",
                        help="Force weekly send (also send to Steven). Default: auto on Sundays.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build zip and report size; do not send.")
    parser.add_argument("--no-ftp", action="store_true",
                        help="Skip Step 2 FTPS upload even if configured.")
    parser.add_argument("--no-gateway", action="store_true",
                        help="Skip Step 2b off-host gateway copy.")
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

    print(f"Umami DB dump: {dump_umami_db()}")

    with tempfile.TemporaryDirectory() as tmp:
        zip_path = os.path.join(tmp, f"silvermere-tech-backup-{date_str}.zip")
        print(f"Building backup zip...")
        size_mb, skipped = build_zip(zip_path)
        print(f"Zip size: {size_mb:.2f} MB")

        # CORE/FULL split (task_1784285554485): the 20MB email limit was
        # silently deciding what the org protects (25 projects born outside a
        # hand-list). CORE = INCLUDE_PATTERNS, rides EVERY tier including the
        # size-bound email. FULL = CORE + the projects sweep, rides the scp
        # tiers only (no size ceiling there). The two tiers protect different
        # sets ON PURPOSE — a deliberate, documented divergence, not a decoy.
        print(f"CORE zip {size_mb:.2f} MB (email + all tiers; set = INCLUDE_PATTERNS above)")
        # WARN band derived from the limit (0.8x), never a second constant:
        # agents/*/memory is 13.1 of CORE's 20.6MB uncompressed and grows
        # daily, so the cliff returns on a schedule — this line makes it
        # announce itself months out, in the report the 22:0xZ cron shows.
        if size_mb > SIZE_LIMIT_MB * 0.8:
            print(f"WARN: CORE zip {size_mb:.2f} MB approaching the {SIZE_LIMIT_MB:.0f} MB email limit "
                  f"(band {SIZE_LIMIT_MB * 0.8:.1f} MB) — largest growth component is agents memory; "
                  f"see pruning task_1784153366580")

        swept, n_swept, n_census = swept_projects()
        print(f"projects swept: {n_swept} of {n_census} (census); "
              f"own-repo projects ride the bundle tier")
        full_path = os.path.join(tmp, f"silvermere-tech-backup-full-{date_str}.zip")
        full_size, full_skipped = build_zip(full_path, extra_dirs=swept)
        print(f"FULL zip {full_size:.2f} MB — projects sweep rides scp tiers only (email carries CORE)")

        if skipped:
            print(f"Excluded {len(skipped)} file(s) (credentials/binaries)")

        # Durable on-box retained copy FIRST — the must-have safety net, done
        # before email/FTP so a retained snapshot exists even if those steps fail.
        if args.dry_run:
            local_status = f"Local retain: dry-run — would copy to {LOCAL_RETAIN_DIR}"
        else:
            local_status = retain_local(zip_path, date_str)
        print(local_status)

        # Step 2 — FTPS off-site upload (runs first so email body can report status)
        if args.no_ftp:
            ftp_status = "FTP: skipped (--no-ftp)"
        elif args.dry_run:
            host_cfg = secrets.get("BACKUP_FTP_HOST", "").strip()
            ftp_status = (
                f"FTP: dry-run — would upload to {host_cfg}:{secrets.get('BACKUP_FTP_PATH', '/').strip() or '/'}"
                if host_cfg
                else "FTP: dry-run — not configured (BACKUP_FTP_HOST unset)"
            )
            ftp_prune_status = "FTP prune: dry-run — skipped"
        else:
            ftp_status = upload_to_ftp(secrets, zip_path)
            print(ftp_status)
            ftp_prune_status = prune_ftp(secrets)
            print(ftp_prune_status)

        # Step 2b — off-host copy to the OVH gateway (our own box, no spend).
        # The primary off-host path now that FTPS is unconfigured: guarantees a
        # copy survives total loss of this VM.
        if args.no_gateway:
            gw_status = "Gateway: skipped (--no-gateway)"
        elif args.dry_run:
            gw_host = secrets.get("TRAEFIK_GATEWAY_HOST", "").strip()
            gw_status = (f"Gateway: dry-run — would copy to {gw_host}:{GATEWAY_REMOTE_DIR}"
                         if gw_host else "Gateway: dry-run — not configured")
        else:
            gw_status = upload_to_gateway(secrets, zip_path)
            print(gw_status)

        # Step 2c' — FULL zip to the secondary host (.10). Gated behind the
        # same --no-gateway flag (both are the "scp tiers"); dry-run never
        # connects. The FULL zip is the one carrying the projects sweep.
        if args.no_gateway:
            sec_status = "Secondary: skipped (--no-gateway)"
        elif args.dry_run:
            sec_status = f"Secondary: dry-run — would copy FULL zip to {SECONDARY_TARGET}:{SECONDARY_REMOTE_DIR}"
        else:
            sec_status = upload_to_secondary(full_path)
            print(sec_status)

        # Step 2c — git history off-host. Rebuilt + verified EVERY run: a stale
        # bundle re-shipped nightly is a backup that reports success while
        # archiving frozen history. Failure here fails the run.
        bundles_failed = False
        if args.no_gateway:
            bundle_status = "Bundles: skipped (--no-gateway)"
        elif args.dry_run:
            bundle_status = (f"Bundles: dry-run — would rebuild + copy to {GATEWAY_BUNDLE_DIR} "
                             f"AND {SECONDARY_TARGET}:{SECONDARY_BUNDLE_DIR}")
        else:
            ok_make, bundle_status = make_git_bundles()
            print(bundle_status)
            if ok_make:
                # Dual-homed (task_1784325977603): both legs always run — a
                # failed gateway leg must never short-circuit the .10 leg,
                # that ordering dependency is how one full disk took git
                # history off-box down entirely on 2026-07-17. Either leg
                # failing still fails the run: degraded redundancy is loud.
                ok_gw, gw_up_status = upload_git_bundles(secrets)
                print(gw_up_status)
                ok_sec, sec_up_status = upload_git_bundles_secondary()
                print(sec_up_status)
                bundle_status = f"{bundle_status}\n  {gw_up_status}\n  {sec_up_status}"
                bundles_failed = not (ok_gw and ok_sec)
            else:
                bundles_failed = True

        over_limit = size_mb > SIZE_LIMIT_MB
        if over_limit:
            print(f"WARN: zip ({size_mb:.1f} MB) exceeds {SIZE_LIMIT_MB} MB limit — sending without attachment")
            body = (
                f"cortextOS org backup — {date_str}\n\n"
                f"Zip size: {size_mb:.1f} MB — EXCEEDS EMAIL LIMIT ({SIZE_LIMIT_MB} MB).\n"
                f"Attachment omitted. Retained copies:\n"
                f"  {local_status}\n"
                f"  {ftp_status}\n"
                f"  {gw_status}\n"
                f"  {sec_status}\n\n"
                f"Excluded {len(skipped)} credential/binary file(s).\n"
            )
            attach = None
        else:
            body = (
                f"cortextOS org backup — {date_str}\n\n"
                f"Zip size: {size_mb:.2f} MB\n"
                f"Contents: knowledge.md, context.json, goals.json, agent configs + bootstrap + memory, "
                f"docs, research, scripts, project docs (clearspeak-studio/app excluded).\n"
                f"Clean-backup: derived PDFs with a source .md are EXCLUDED (rebuild via "
                f"doc-to-pdf.js on restore); orphan/external PDFs are kept.\n"
                f"Excluded credentials: secrets.env, gsc-service-account.json, .env files.\n\n"
                f"Excluded {len(skipped)} additional credential/binary/derived file(s).\n\n"
                f"This attachment is the CORE zip (email-size-bound). The FULL zip "
                f"(CORE + the projects sweep, {full_size:.2f} MB) rides the scp tiers only.\n"
                f"Retained copies:\n  {local_status}\n  {ftp_status}\n  {gw_status}\n"
                f"  {sec_status}\n"
                f"  {bundle_status}\n\n"
                f"Restore: use scripts/restore.py to fetch + unzip from IMAP.\n"
            )
            attach = zip_path

        if args.dry_run:
            print(f"DRY RUN — would send to {DAILY_DEST}" + (f" + {WEEKLY_DEST}" if is_weekly else ""))
            print(f"DRY RUN — {ftp_status}")
            print(f"DRY RUN — {gw_status}")
            if over_limit:
                print("DRY RUN — zip over limit, would send without attachment")
            return

        # Daily send → bertha (self-archive)
        # Email tier is HANDLED, not trusted (harness arm email-loud): an
        # unhandled SMTP failure used to kill the run mid-flight — after the
        # gateway upload, before IMAP prune and the weekly — with a raw
        # traceback nobody reads. Now: the tier records FAILED, its dependents
        # (relocate/prune, which need the mail to exist) are skipped with a
        # printed reason, later tiers still run, and the tier-failure exit at
        # the bottom attributes it loudly.
        email_status = "Email: not attempted"
        print(f"Sending daily backup to {DAILY_DEST}...")
        try:
            send_backup(smtp_host, smtp_port, sender, password, DAILY_DEST, subject, body, attach)
            email_status = f"Email: sent ({size_mb:.2f} MB {'+ attachment' if attach else 'no attachment'})"
            print(f"OK  daily backup sent ({size_mb:.2f} MB {'+ attachment' if attach else 'no attachment'})")
        except Exception as e:
            email_status = f"Email: FAILED — {e}"
            print(email_status)

        if email_status.startswith("Email: sent"):
            # Relocate self-sent backup out of Junk (Hostinger spam-files it) so it
            # lands in INBOX where retention + restore expect it. Best-effort.
            relocate_from_junk(imap_host, imap_port, sender, password, subject)

            # IMAP prune — keep last KEEP_DAILY daily backups (INBOX + Junk)
            prune_imap(imap_host, imap_port, sender, password, keep_n=KEEP_DAILY)
        else:
            print("Skipping Junk-relocate + IMAP prune (no mail was sent this run)")

        # Weekly send → Steven: NOTIFICATION ONLY (no attachment).
        # The recipient's mail provider (mailchannels) HARD-BOUNCES .zip attachments
        # ("550 5.7.1 attachment type not allowed"), so attaching the zip just NDRs.
        # The off-site copy is served by the gateway copy (and OVH FTPS once wired),
        # not the mailbox — so this is a status notice + pointer, never an attachment.
        if is_weekly:
            print(f"Sending weekly status notice to {WEEKLY_DEST}...")
            weekly_subject = f"{subject} [weekly status]"
            weekly_body = (
                f"Weekly backup status — {date_str}\n\n"
                f"The silvermere-tech org backup ran successfully ({size_mb:.2f} MB, clean/"
                f"source-of-truth).\n\n"
                f"No attachment: your mail provider rejects .zip attachments "
                f"(550 attachment-type-not-allowed), so the full zip is NOT emailed. "
                f"Retained copies (the real safety net):\n"
                f"  {local_status}\n"
                f"  {gw_status}\n"
                f"  {sec_status}\n"
                f"  {ftp_status}\n\n"
                f"True off-site (OVH Backup Storage via FTPS) is being wired; until then the "
                f"gateway copy on a separate box is the off-host safety. Ask engineer/chief "
                f"for the full zip if you ever need to restore.\n"
            )
            try:
                send_backup(smtp_host, smtp_port, sender, password, WEEKLY_DEST,
                            weekly_subject, weekly_body, None)
                print(f"OK  weekly status notice sent to {WEEKLY_DEST} (no attachment)")
            except Exception as e:
                # Weekly is a notice, not a data tier — record inside the email
                # tier's status so it still exits loud, but never crash here.
                email_status += f" | weekly notice FAILED — {e}"
                print(f"Weekly notice: FAILED — {e}")

        # Fail loudly, PER TIER, at the very end (harness arms gateway-loud /
        # email-loud). Every tier ran; now every failure is attributed by name
        # so the 22:0xZ cron read shows WHICH leg died, and the exit code
        # makes the run un-ignorable. A status string containing FAILED that
        # only ever landed in an email body is how the gateway tier could die
        # best-effort-silently onto a full disk (task_1784280833929).
        tier_failures = []
        for tier, status in (("local-retain", local_status), ("ftp", ftp_status),
                             ("gateway", gw_status), ("secondary", sec_status),
                             ("email", email_status)):
            if "FAILED" in status:
                tier_failures.append(tier)
                print(f"ERROR: {tier} tier FAILED — {status}", file=sys.stderr)

    # Fail loudly. A backup that reports success while shipping no history is
    # worse than no backup: it buys false confidence and nobody looks again.
    # The zip/email path has already succeeded by here, so this exit code says
    # precisely "the git-history tier failed", and the cron surfaces it.
    if bundles_failed:
        print("ERROR: git-bundle tier FAILED — see per-leg status above "
              "(history must land on BOTH gateway and secondary)", file=sys.stderr)
        sys.exit(1)
    if tier_failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
