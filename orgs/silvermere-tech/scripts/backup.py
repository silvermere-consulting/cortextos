#!/usr/bin/env python3
"""cortextOS org backup — zip + off-host tiers.

Zips the org's durable knowledge and config, then lands it on:
  - LOCAL retain (/home/cortext/backups/<org>-daily, keep KEEP_LOCAL)
  - GATEWAY (10.10.10.6, CORE zip only — the LXC is small, keep KEEP_GATEWAY)
  - SECONDARY .10 (FULL zip + git bundles, sha256-verified)
  - R2 (S3 tier, AES-256-GCM client-side encrypted, sha256 read-back
    verified; the off-vendor DR copy — restore-proven 2026-07-18)
  - FTPS (only if BACKUP_FTP_HOST configured; currently unconfigured)

EMAIL TIER REMOVED 2026-07-19 (Steve directive): R2 made the mailbox copy
redundant, and the mailbox's 35MB wire ceiling was a standing cliff against
CORE growth. Restore no longer involves IMAP — see restore.py (fetches from
.10) and the R2 restore runbook it points at.

Usage:
  backup.py                   # daily run, all configured tiers
  backup.py --dry-run         # build + size-check the zip, don't upload
  backup.py --no-ftp          # skip FTPS even if configured (one-off testing)

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
import hmac
import json
import os
import re
import shlex
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ORG = "silvermere-tech"
# BACKUP_SECRETS_FILE: test-surface override so the loud-tier harness
# (workspace/backup-hardening/) can point a REAL run at sandboxed creds
# without touching prod secrets. Default unchanged; production never sets it.
#
# TRANSPORT IS INFRA-SCOPED, CONTENT IS ORG-SCOPED (task_1784295189575):
# the gateway ssh and .10 ssh credentials belong to the machine room, not
# to the org being backed up — every org's zip rides the same transport, so
# SECRETS_FILE does NOT vary with --org. What varies is the CONTENT (root,
# include set) and the NAMESPACE (zip prefix, retain/remote dirs), all
# derived in configure_org().
SECRETS_FILE = Path(os.environ.get(
    "BACKUP_SECRETS_FILE",
    "/home/cortext/cortextos/orgs/silvermere-tech/secrets.env"))
KEEP_LOCAL = 14
KEEP_GATEWAY = 7
KEEP_BUNDLES = 7

# Generic core: what EVERY org's zip carries (relative to its org root).
# Explicit inclusion list keeps the zip predictable and avoids accidental
# credential leaks (secrets.env, gsc-service-account.json are excluded).
GENERIC_INCLUDE = [
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
]

# Per-org extras beyond the generic core. Projects named here ride the CORE
# zip (the lean artifact, sized for the gateway's small LXC); every OTHER
# project rides the FULL zip via the swept_projects() sweep — so an org with
# no entry here (family) still gets all its projects backed up, on the tiers
# with no size pressure. That split is MEASURED at run time (zip sizes
# printed every run), never a typed per-org number.
ORG_EXTRA_INCLUDE = {
    "silvermere-tech": [
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
        # EXCLUDE_DIRS strips every .git dir, so no repo history leaves this
        # box via the zip — bundles are their own tier (make_git_bundles →
        # gateway/.10/R2). Folding them in would more than double the CORE
        # zip (measured 13.3→30.67 MB) for copies the bundle tier already
        # ships sha256-verified. See task_1783575583… .
    ],
}

# Existing on-disk/remote names predate --org. Renaming them would orphan the
# retention lineage (prune globs would stop seeing old copies), so the default
# org keeps its exact historical paths; new orgs get cleanly derived ones.
_LEGACY_NAMES = {
    "silvermere-tech": dict(retain="org-daily", gw="silvermere-org",
                            sec="silvermere-org-full",
                            secgit="silvermere-org-git-bundles"),
}


def configure_org(org: str) -> None:
    """Derive every org-scoped global from the org name. Called once at
    startup (module bottom for the default, main() for --org). Everything
    here is DERIVED — adding an org means having a directory under orgs/,
    not adding constants."""
    global BACKUP_ORG, ORG_ROOT, GIT_BUNDLE_DIR, LOCAL_RETAIN_DIR, ZIP_PREFIX
    global GATEWAY_REMOTE_DIR, SECONDARY_REMOTE_DIR
    global SECONDARY_BUNDLE_DIR, INCLUDE_PATTERNS, INFRA_TIERS, _BACKUP_NAME_RE
    root = Path(f"/home/cortext/cortextos/orgs/{org}")
    if not root.is_dir():
        raise SystemExit(f"unknown org '{org}': {root} does not exist")
    names = _LEGACY_NAMES.get(org, dict(
        retain=f"{org}-daily", gw=f"{org}-org",
        sec=f"{org}-org-full", secgit=f"{org}-org-git-bundles"))
    BACKUP_ORG = org
    ORG_ROOT = root
    # Step 2c — git history off-host. Bundles are INFRA-tier: _discover_repos()
    # already enumerates every org's agent + project repos, so the default
    # org's nightly run ships ALL orgs' history. A second org's run skips the
    # tier (loudly) instead of re-shipping ~670MB of the same bundles.
    GIT_BUNDLE_DIR = root / "backups" / "git"
    # Durable on-box retained copy. The zip is otherwise built in a
    # TemporaryDirectory and discarded on exit — this guarantees at least one.
    LOCAL_RETAIN_DIR = Path(f"/home/cortext/backups/{names['retain']}")
    ZIP_PREFIX = f"{org}-backup-"
    _BACKUP_NAME_RE = re.compile(rf"^{re.escape(org)}-backup-(\d{{4}}-\d{{2}}-\d{{2}})\.zip$")
    # Step 2b — off-host copy to the OVH gateway (internal infra, our own box).
    # The gateway is a small 2.0G LXC, so retention is kept lean.
    GATEWAY_REMOTE_DIR = f"/home/cortext/backups/{names['gw']}"
    SECONDARY_REMOTE_DIR = f"/home/deploy/backups/{names['sec']}"
    SECONDARY_BUNDLE_DIR = f"/home/deploy/backups/{names['secgit']}"
    INCLUDE_PATTERNS = GENERIC_INCLUDE + ORG_EXTRA_INCLUDE.get(org, [])
    # Umami dump + git bundles run in the infra org's invocation only.
    INFRA_TIERS = (org == DEFAULT_ORG)


configure_org(DEFAULT_ORG)

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

        # SCOPE MANIFEST (2026-08-26, engineer). A zip that cannot state its own tier gets
        # misread: on 2026-08-26 two readers independently read "discover-liwa absent from the
        # CORE zip" as "not backed up" — when the core zip excludes swept projects BY DESIGN.
        # This one file, INSIDE the archive, travels with it; the next reader opens the zip,
        # not the config. Detected from the dest filename (the -full- convention already exists).
        _is_full = "-full-" in os.path.basename(dest_path)
        if _is_full:
            _scope = (
                "TIER=FULL  (secondary .10 + R2 — the DR copy)\n"
                "CARRIES: the ORG_EXTRA_INCLUDE projects PLUS every SWEPT project (every\n"
                "  projects/* dir without its own committed history: discover-liwa, ilham, pylot, ...).\n"
                "EXCLUDES: node_modules .git __pycache__ .next dist build .cache (git history rides\n"
                "  the separate bundle tier).\n"
                "=> This is the tier that answers 'is project X backed up?'. If it's here, it's backed up.\n"
            )
        else:
            _scope = (
                "TIER=CORE  (gateway LXC + on-box local retain — the LEAN subset)\n"
                "CARRIES: ONLY the ORG_EXTRA_INCLUDE projects (sized for the small gateway LXC).\n"
                "DELIBERATELY ABSENT: every SWEPT project (discover-liwa, ilham, pylot, ...). They\n"
                "  ride the '-full-' zip on .10/R2, NOT this one.\n"
                "=> 'Project X absent from THIS zip' does NOT mean it is unbacked. The '-full-' zip on\n"
                "  .10/R2 is the tier that answers 'is project X backed up?' — check THERE, not here.\n"
                "EXCLUDES: node_modules .git __pycache__ .next dist build .cache\n"
            )
        zf.writestr("BACKUP-SCOPE.txt", _scope)

        # NODE-MEMORY TIER (2026-08-24, engineer — task: node-layer-backup-gap).
        # The durable memory layer migrated to ~/.claude/projects/<agent>/memory and
        # backup.py — a CONSUMER of where-memory-lives — was never extended to follow,
        # so the fleet's LIVE node layer had no offsite copy while the dead workspace
        # MEMORY.md archive did. Added here under a synthetic `node-memory/` arc prefix
        # because it lives OUTSIDE arc_base (cortextos/orgs), so add_to_zip's
        # relative_to(arc_base) cannot handle it.
        #
        # SCOPED credential handling (chief 2026-08-24): each node is credential-scanned
        # HERE, at collection, with the SAME CREDENTIAL_PATTERNS the whole-archive verify
        # uses. A node that trips is EXCLUDED and NAMED (rides `skipped`) so it never
        # reaches the archive — converting a single credential-bearing node from the FAIL
        # branch (verify_archive_clean aborts the ENTIRE backup, org-wide) into a named
        # DROP (that one node is skipped by name; everything else still ships; the count
        # check catches the exclusion). This is SCOPE, not a weaker scanner — a stricter
        # per-file check scoped to the node dir, with the org-wide verify still the
        # belt-and-braces behind it. A node holding a REAL secret SHOULD be dropped from
        # an offsite zip and surfaced, not shipped. Measured 2026-08-24: 0 of 599 nodes
        # trip it, so this path excludes nothing today and fires only on a genuine hit.
        #
        # SIZE ANCHOR for a future integration check (corrected 2026-08-24, chief+engineer):
        # the node layer is ~3.3 MB uncompressed FLEET-WIDE (all agents, 599 nodes) — NOT
        # 1.76 MB, which is one agent's dir. Node memory is dense technical prose (kebab
        # terms, caps, quoted strings) and deflates ~2x, NOT ~3x, so it lands at ~1.6 MB in
        # the zip. So a CORE-size delta near ~1.6 MB is HEALTHY; a delta near the FULL ~3.3 MB
        # uncompressed is the stored-not-deflated tell. (Do NOT read a +1.6 MB delta as a
        # shortfall — that was a wrong anchor: per-agent basis + a ~3x ratio that this
        # content does not have. Verified: compress_type==8 on all node entries.)
        node_root = Path(os.path.expanduser("~/.claude/projects"))
        if node_root.exists():
            for mem_dir in sorted(node_root.glob("*/memory")):
                for f in sorted(mem_dir.rglob("*")):
                    if not f.is_file():
                        continue
                    if should_exclude(f):
                        skipped.append(str(f))
                        continue
                    real = f.resolve()
                    if real in seen:
                        continue
                    try:
                        text = f.read_text(encoding="utf-8", errors="ignore")
                    except Exception:
                        text = ""
                    if any(rx.search(text) for _label, rx in CREDENTIAL_PATTERNS):
                        skipped.append(f"{f} :: node-credential-hit (excluded, not shipped)")
                        continue
                    seen.add(real)
                    zf.write(f, arcname="node-memory/" + str(f.relative_to(node_root)))

    size_mb = os.path.getsize(dest_path) / (1024 * 1024)
    return size_mb, skipped


def retain_local(zip_path: str, date_str: str) -> str:
    """Copy the built zip to a durable local path + prune old copies.
    The on-box retained snapshot — guarantees a retained copy exists even when
    the zip is oversized AND FTPS is unconfigured."""
    try:
        LOCAL_RETAIN_DIR.mkdir(parents=True, exist_ok=True)
        dest = LOCAL_RETAIN_DIR / f"{ZIP_PREFIX}{date_str}.zip"
        shutil.copy2(zip_path, dest)
        zips = sorted(LOCAL_RETAIN_DIR.glob(f"{ZIP_PREFIX}*.zip"))
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
    """Upload zip_path via FTPS. Returns one-line status string for the report."""
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


# _BACKUP_NAME_RE is org-derived in configure_org() — a static regex here
# would let one org's IMAP prune parse (and age out) another org's copies.


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
        # upload_git_bundles_secondary() re-scp the RETAINED bundles and call it a success —
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


# The gateway BUNDLE leg was RETIRED 2026-07-18 (chief decision, Option 1,
# msg 1784348468181; Steve AM brief FYI+veto): the nightly upload ships the
# whole retained set (~673M) and a 2.1G routing LXC cannot hold set + incoming
# headroom at ANY keep depth — it was always an ill-fitting bundle home.
# Bundles now ride upload_git_bundles_secondary() to .10 (165G, sha256-assert
# vs creation). The gateway carries the ZIP tier only, which fits with ~5x
# headroom. Upgrade path if 3-home bundle redundancy is wanted back: resize
# the LXC (Proxmox host side, [HUMAN]).


def upload_to_gateway(secrets, zip_path: str) -> str:
    """Step 2b — off-host copy of the zip to the OVH gateway over SSH/scp.
    Internal infra (our own box), so no spend/approval gate. Verifies the remote
    byte-size matches local before reporting success, then prunes to KEEP_GATEWAY.
    Returns a one-line status string for the report."""
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
        prune_cmd = (f"ls -1t {GATEWAY_REMOTE_DIR}/{ZIP_PREFIX}*.zip 2>/dev/null "
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
# SECONDARY_REMOTE_DIR / SECONDARY_BUNDLE_DIR are org-derived in configure_org().
KEEP_SECONDARY = 7


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
        prune_cmd = (f"ls -1t {SECONDARY_REMOTE_DIR}/{ZIP_PREFIX}full-*.zip 2>/dev/null "
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


# --- Step 2e: S3-compatible off-host tier (STAGED DARK 2026-07-18, task_1784359893159) ---
#
# Steve's catch (task_1784359500586): .10 and the gateway are VMs on the SAME
# physical host — every scp tier above is single-VM redundancy, not DR. This
# leg is the true off-host home. Staged DARK: fully built + harness-armed, but
# DORMANT until BACKUP_S3_ENDPOINT lands in secrets.env (Steve picks R2 or B2;
# both are S3-compatible, so the pick is an endpoint+creds swap, zero rework).
#
# Design rules, each bought by a measured failure this week:
#   - Skip-when-unconfigured is LOUD (a printed line), never silence.
#   - Client-side AES-256-GCM BEFORE upload; key missing = FAIL CLOSED
#     (plaintext never ships as a fallback). Provider SSE is not our threat
#     model — the provider holds those keys.
#   - sha256 READ-BACK assert on remote bytes vs ciphertext-at-creation
#     (remote bytes are the truth; a 200 on PUT is not).
#   - Prune is ORG-SCOPED by key prefix and REFUSES to delete outside it
#     (the family-backup first-run lesson: a second tenant's first action
#     audits every shared-namespace selector).
#
# Config (secrets.env): BACKUP_S3_ENDPOINT (enabling switch, e.g.
#   https://<acct>.r2.cloudflarestorage.com or https://s3.<region>.backblazeb2.com),
#   BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY,
#   BACKUP_S3_REGION (default "auto" — R2's value; B2 uses its region string),
#   BACKUP_ENCRYPT_PASSPHRASE (client-side key material; ESCROW A COPY with
#   Steve — a key that dies with this host protects nothing).
#
# Restore (DR runbook): download backups/{org}/<name>.zip.enc, then
#   python3 -c "import sys; sys.path.insert(0,'scripts'); import backup;
#               backup._decrypt_file('<in>.enc','<out>.zip','<passphrase>')"
# Needs python3 + `pip install cryptography` on the restore box.

KEEP_S3 = 7
_S3_ENC_MAGIC = b"CTXS3E1"  # header: MAGIC + salt(16) + nonce(12) + AESGCM ciphertext


def _s3_cfg(secrets):
    """Tier config, or None when dormant (endpoint unset)."""
    endpoint = (os.environ.get("BACKUP_S3_ENDPOINT") or secrets.get("BACKUP_S3_ENDPOINT", "")).strip()
    if not endpoint:
        return None
    get = lambda k, d="": (os.environ.get(k) or secrets.get(k, d)).strip()
    return {
        "endpoint": endpoint.rstrip("/"),
        "bucket": get("BACKUP_S3_BUCKET"),
        "key_id": get("BACKUP_S3_ACCESS_KEY_ID"),
        "secret": get("BACKUP_S3_SECRET_ACCESS_KEY"),
        "region": get("BACKUP_S3_REGION", "auto") or "auto",
        "passphrase": get("BACKUP_ENCRYPT_PASSPHRASE"),
    }


def _s3_request(cfg, method, key="", query_pairs=(), data=b"", timeout=120):
    """Minimal AWS SigV4 request, stdlib-only (no boto3 on this host, and the
    tier must stay DR-portable). Path-style addressing: {endpoint}/{bucket}/{key}
    — works on both R2 and B2. Returns (http_status, body_bytes).

    NOTE the honest scope: the signer is spec-implemented and the harness stub
    asserts a well-formed AWS4-HMAC-SHA256 Authorization header on every call,
    but signature ACCEPTANCE can only be proven against the live provider —
    that is the first-real-run check when the tier is enabled."""
    import urllib.parse as _up
    import urllib.request as _ur

    host = _up.urlparse(cfg["endpoint"]).netloc
    amz_date = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    date_stamp = amz_date[:8]
    payload_hash = hashlib.sha256(data or b"").hexdigest()

    # canonical URI: our keys are generated from a safe charset; refuse others
    # rather than encode surprises into a signature mismatch.
    path = f"/{cfg['bucket']}" + (f"/{key}" if key else "")
    if not re.fullmatch(r"[A-Za-z0-9./_\-]*", key):
        raise ValueError(f"S3 key outside safe charset: {key!r}")

    canonical_query = "&".join(
        f"{_up.quote(str(k), safe='')}={_up.quote(str(v), safe='')}"
        for k, v in sorted(query_pairs)
    )
    headers = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical_request = "\n".join(
        [method, path, canonical_query, canonical_headers, signed_headers, payload_hash])
    scope = f"{date_stamp}/{cfg['region']}/s3/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amz_date, scope,
        hashlib.sha256(canonical_request.encode()).hexdigest()])

    def _hmac(k, msg):
        return hmac.new(k, msg.encode(), hashlib.sha256).digest()

    k_date = _hmac(("AWS4" + cfg["secret"]).encode(), date_stamp)
    k_region = _hmac(k_date, cfg["region"])
    k_service = _hmac(k_region, "s3")
    k_signing = _hmac(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

    url = cfg["endpoint"] + path + (f"?{canonical_query}" if canonical_query else "")
    req = _ur.Request(url, data=data if method in ("PUT", "POST") else None, method=method)
    req.add_header("x-amz-content-sha256", payload_hash)
    req.add_header("x-amz-date", amz_date)
    req.add_header(
        "Authorization",
        f"AWS4-HMAC-SHA256 Credential={cfg['key_id']}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}")
    try:
        with _ur.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except _ur.HTTPError as e:
        return e.code, e.read()


def _encrypt_file(src, dest, passphrase):
    """Client-side AES-256-GCM (authenticated). Key = scrypt(passphrase, salt).
    Import is LAZY on purpose: without `cryptography` installed the rest of
    backup.py must keep working while this tier is dormant."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # lazy, see above
    salt, nonce = os.urandom(16), os.urandom(12)
    key = hashlib.scrypt(passphrase.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32,
                         maxmem=64 * 1024 * 1024)
    with open(src, "rb") as f:
        plaintext = f.read()
    ct = AESGCM(key).encrypt(nonce, plaintext, None)
    with open(dest, "wb") as f:
        f.write(_S3_ENC_MAGIC + salt + nonce + ct)


def _decrypt_file(src, dest, passphrase):
    """Restore path — proven by the harness round-trip arm, documented in the
    tier header. A backup that has never been decrypted is theatre."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # lazy
    with open(src, "rb") as f:
        blob = f.read()
    if not blob.startswith(_S3_ENC_MAGIC):
        raise ValueError("not a CTXS3E1 envelope (wrong file or pre-encryption artifact)")
    off = len(_S3_ENC_MAGIC)
    salt, nonce = blob[off:off + 16], blob[off + 16:off + 28]
    key = hashlib.scrypt(passphrase.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32,
                         maxmem=64 * 1024 * 1024)
    plaintext = AESGCM(key).decrypt(nonce, blob[off + 28:], None)
    with open(dest, "wb") as f:
        f.write(plaintext)


def _s3_list_keys(cfg, prefix):
    """List object keys under prefix (list-type=2, paged)."""
    keys, token = [], None
    while True:
        q = [("list-type", "2"), ("prefix", prefix)]
        if token:
            q.append(("continuation-token", token))
        status, body = _s3_request(cfg, "GET", "", q)
        if status != 200:
            raise RuntimeError(f"LIST {prefix!r} -> HTTP {status}: {body[:200]!r}")
        text = body.decode(errors="replace")
        keys += re.findall(r"<Key>([^<]+)</Key>", text)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
        token = m.group(1) if m else None
        if not token:
            return keys


def _s3_list_sizes(cfg, prefix):
    """Sum the Size of every object under prefix (list-type=2, paged). Parses
    per-<Contents> so Key and Size stay paired. Returns total bytes."""
    total, token = 0, None
    while True:
        q = [("list-type", "2"), ("prefix", prefix)]
        if token:
            q.append(("continuation-token", token))
        status, body = _s3_request(cfg, "GET", "", q)
        if status != 200:
            raise RuntimeError(f"LIST-sizes {prefix!r} -> HTTP {status}: {body[:200]!r}")
        text = body.decode(errors="replace")
        for block in re.findall(r"<Contents>(.*?)</Contents>", text, re.DOTALL):
            m = re.search(r"<Size>(\d+)</Size>", block)
            if m:
                total += int(m.group(1))
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
        token = m.group(1) if m else None
        if not token:
            return total


# ── R2 SIZE GUARDRAIL (task_1784412736637, Steve cost-tight: MUST stay under
# the 10GB R2 free-tier step) ────────────────────────────────────────────────
# Two HONEST modes, never conflated (the units-on-a-record lesson):
#   LIVE  (S3 configured): sum the real object Sizes in the bucket = a MEASUREMENT.
#   DARK  (not configured): project from the local retained set = a PROJECTION.
# Each emitted line states which it is, so a projected number never reads as measured.
_GB = 1024 ** 3
R2_FREE_TIER_GB = float(os.environ.get("BACKUP_R2_LIMIT_GB", "10"))   # hard ceiling
R2_SOFT_LIMIT_GB = float(os.environ.get("BACKUP_R2_SOFT_GB", "8"))    # warn band, well under


def _r2_verdict(used_bytes, soft_bytes, hard_bytes):
    """Pure verdict — the two-sided-testable core. RED at/over the ceiling,
    WARN at/over the soft band, else OK."""
    if used_bytes >= hard_bytes:
        return "RED"
    if used_bytes >= soft_bytes:
        return "WARN"
    return "OK"


def _r2_selftest():
    """Watched-fire both directions on the verdict logic before it gates.
    Returns (ok, detail)."""
    soft, hard = 8 * _GB, 10 * _GB
    cases = [
        (1 * _GB, "OK"), (7 * _GB, "OK"),              # known-under: must stay quiet
        (8 * _GB, "WARN"), (9 * _GB, "WARN"),          # known-over-band: must warn
        (10 * _GB, "RED"), (12 * _GB, "RED"),          # known-over-ceiling: must go red
    ]
    for used, expect in cases:
        got = _r2_verdict(used, soft, hard)
        if got != expect:
            return False, f"verdict({used/_GB:.0f}GB)={got}, expected {expect}"
    return True, "OK"


def _r2_local_projection(this_full_zip, local_bundle_set_bytes):
    """DARK-mode estimate of THIS org's steady-state R2 footprint.

    Two parts, each matched to R2's retention so the projection equals what
    actually accumulates there:
    - FULL zips: R2 keeps KEEP_S3 of them; one cycle produces one; so
      KEEP_S3 × this_cycle's full zip.
    - BUNDLES: R2 keeps KEEP_BUNDLES per repo — and the LOCAL bundle dir is
      pruned to the SAME KEEP_BUNDLES per repo (make_git_bundles), so the
      current local bundle SET already equals R2's steady-state bundle
      footprint. Use it directly — do NOT multiply again (that was a
      double-count: the retained set × retention).
    Encryption overhead (~51 bytes/object: magic+salt+nonce+tag) is negligible
    vs MB artifacts, so ciphertext ≈ plaintext bytes."""
    return KEEP_S3 * this_full_zip + local_bundle_set_bytes


def _r2_delta_phrase(used_bytes, mode_tag):
    """Run-over-run trend off a tiny per-org state file. Honest on two edges:
    INSUFFICIENT-IS-NOT-FLAT (no prior sample → say so, never '+0%'), and
    MODE-MATCH (a PROJECTED value vs a prior MEASURED one is not comparable).
    `mode_tag` is a short mode key ('live' | 'dark'). Always writes the current
    sample. Returns a phrase to append to the footprint line."""
    state = Path(os.path.expanduser(f"~/.backup-r2-footprint-{BACKUP_ORG}.json"))
    prior = None
    if state.exists():
        try:
            prior = json.loads(state.read_text())
        except Exception:  # noqa: BLE001 — a corrupt state file must not fail the backup
            prior = None
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        state.write_text(json.dumps({"used_bytes": used_bytes, "mode": mode_tag, "ts": now_iso}))
    except Exception:  # noqa: BLE001
        pass  # trend is a heads-up, not the gate — never fail the run on it

    if not prior or "used_bytes" not in prior:
        return " (no prior sample — first footprint record)"
    if prior.get("mode") != mode_tag:
        return f" (prior sample was {prior.get('mode','?')}-mode, not comparable to this {mode_tag}-mode value)"
    p = prior["used_bytes"]
    try:
        days = (datetime.now(timezone.utc)
                - datetime.strptime(prior["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)).days
    except Exception:  # noqa: BLE001
        days = "?"
    when = "today" if days == 0 else (f"{days}d ago" if isinstance(days, int) else "last run")
    if p == 0:
        return f" (prior was 0 — {when})"
    pct = (used_bytes - p) / p * 100.0
    sign = "+" if pct >= 0 else ""
    return f" ({sign}{pct:.1f}% vs last run {when})"


def r2_footprint_guard(secrets, this_full_zip_bytes, this_bundle_bytes):
    """Emit the R2 footprint line + verdict. Returns (ok, line): ok=False only
    on a RED (measured/projected breach of the hard ceiling) so main() can exit
    nonzero and the cron surfaces it. A failed self-test degrades to
    CANNOT-TELL (ok=True, non-blocking) rather than a false green or false red."""
    st_ok, st_why = _r2_selftest()
    if not st_ok:
        return True, f"R2 footprint: CANNOT-TELL — guard self-test failed ({st_why}); not certifying size this run"

    soft_b, hard_b = R2_SOFT_LIMIT_GB * _GB, R2_FREE_TIER_GB * _GB
    cfg = _s3_cfg(secrets)
    if cfg is not None:
        # LIVE — the authoritative bucket-wide MEASUREMENT (all orgs share the bucket)
        try:
            used = _s3_list_sizes(cfg, "backups/")
            mode = "MEASURED (live bucket LIST, all orgs)"
        except Exception as e:  # noqa: BLE001
            return True, f"R2 footprint: CANNOT-TELL — live LIST failed ({e.__class__.__name__}); size unknown this run"
    else:
        # DARK — this org's PROJECTION only (can't see other orgs' share)
        used = _r2_local_projection(this_full_zip_bytes, this_bundle_bytes)
        mode = f"PROJECTED ({BACKUP_ORG} only, retention×cycle; bucket-wide total needs live LIST)"

    verdict = _r2_verdict(used, soft_b, hard_b)
    delta = _r2_delta_phrase(used, "live" if cfg is not None else "dark")
    line = (f"R2 footprint: {used/_GB:.2f} GB of {R2_FREE_TIER_GB:.0f} GB free tier "
            f"(band {R2_SOFT_LIMIT_GB:.0f} GB) — {mode}{delta}")
    if verdict == "RED":
        return False, (f"  🔴 {line} — OVER the {R2_FREE_TIER_GB:.0f} GB free-tier ceiling. "
                       f"Prune retention or move to a paid tier BEFORE next run.")
    if verdict == "WARN":
        return True, (f"  ⚠️ {line} — past the {R2_SOFT_LIMIT_GB:.0f} GB band, approaching the "
                      f"{R2_FREE_TIER_GB:.0f} GB free-tier cliff. Plan retention/paid-tier now.")
    return True, f"  ℹ️  {line} — healthy headroom."


def upload_to_s3(secrets, artifacts):
    """Step 2e — encrypt + ship artifacts to the S3-compatible off-host bucket.

    artifacts: list of Path. Each lands as backups/{org}/{name}.enc after
    client-side encryption; remote bytes are read back and sha256-asserted
    against the ciphertext-at-creation hash. Prune keeps KEEP_S3 zips and
    KEEP_BUNDLES bundles per repo prefix, ONLY under this org's prefix.
    Returns (ok, status)."""
    cfg = _s3_cfg(secrets)
    if cfg is None:
        return True, ("S3 off-host: not configured (BACKUP_S3_ENDPOINT unset) — "
                      "leg staged dark 2026-07-18, awaiting Steve's R2-vs-B2 pick; skipped")
    missing = [k for k in ("bucket", "key_id", "secret") if not cfg[k]]
    if missing:
        return False, f"S3 off-host: FAILED (endpoint set but incomplete config: {', '.join(missing)})"
    if not cfg["passphrase"]:
        return False, ("S3 off-host: FAILED (BACKUP_ENCRYPT_PASSPHRASE unset — "
                       "refusing to ship plaintext off-host; tier fails CLOSED)")

    org_prefix = f"backups/{BACKUP_ORG}/"
    shipped, total_mb = [], 0.0
    try:
        for art in artifacts:
            art = Path(art)
            enc = Path(tempfile.gettempdir()) / f"{art.name}.enc"
            try:
                _encrypt_file(art, enc, cfg["passphrase"])
                cipher_hash = _sha256(enc)
                data = enc.read_bytes()
                key = f"{org_prefix}{art.name}.enc"
                status, body = _s3_request(cfg, "PUT", key, data=data, timeout=600)
                if status not in (200, 201):
                    return False, f"S3 off-host: FAILED (PUT {art.name} -> HTTP {status}: {body[:200]!r})"
                # Read-back: remote bytes are the truth, a 200 is not.
                status, remote = _s3_request(cfg, "GET", key, timeout=600)
                if status != 200:
                    return False, f"S3 off-host: FAILED (read-back GET {art.name} -> HTTP {status})"
                remote_hash = hashlib.sha256(remote).hexdigest()
                if remote_hash != cipher_hash:
                    return False, (f"S3 off-host: FAILED (read-back hash mismatch on {art.name}: "
                                   f"creation={cipher_hash[:12]}… remote={remote_hash[:12]}…)")
                shipped.append(art.name)
                total_mb += len(data) / (1024 * 1024)
            finally:
                enc.unlink(missing_ok=True)

        # Org-scoped prune. Structural refusal: every candidate key must carry
        # our org prefix — if the LIST ever returns a foreign key, we stop
        # rather than delete it (the shared-namespace-selector lesson).
        listed = _s3_list_keys(cfg, org_prefix)
        foreign = [k for k in listed if not k.startswith(org_prefix)]
        if foreign:
            return False, (f"S3 off-host: FAILED (prune refused: LIST under {org_prefix!r} "
                           f"returned foreign key {foreign[0]!r} — selector scope broken)")
        pruned = 0
        zips = sorted(k for k in listed if k.endswith(".zip.enc"))
        for k in zips[:-KEEP_S3] if len(zips) > KEEP_S3 else []:
            st, _ = _s3_request(cfg, "DELETE", k)
            if st not in (200, 204):
                return False, f"S3 off-host: FAILED (prune DELETE {k} -> HTTP {st})"
            pruned += 1
        bundles = [k for k in listed if k.endswith(".bundle.enc")]
        for pref in sorted({k.rsplit("-", 1)[0] for k in bundles}):
            series = sorted(k for k in bundles if k.rsplit("-", 1)[0] == pref)
            for k in series[:-KEEP_BUNDLES] if len(series) > KEEP_BUNDLES else []:
                st, _ = _s3_request(cfg, "DELETE", k)
                if st not in (200, 204):
                    return False, f"S3 off-host: FAILED (prune DELETE {k} -> HTTP {st})"
                pruned += 1

        return True, (f"S3 off-host: {len(shipped)} artifact(s) ({total_mb:.2f} MB encrypted) -> "
                      f"{cfg['endpoint']}/{cfg['bucket']}/{org_prefix} "
                      f"(AES-256-GCM client-side, sha256 read-back verified, "
                      f"org-scoped prune removed {pruned})")
    except Exception as e:  # noqa: BLE001 — tier reports, main() attributes + exits
        return False, f"S3 off-host: FAILED — {e}"


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


ODOO_HOST = os.environ.get("BACKUP_ODOO_TARGET", "cortext@10.10.10.103")
ODOO_PG_CONTAINER = "odoo-postgres"
ODOO_APP_CONTAINER = "odoo-app"                 # filestore lives here, not in postgres
ODOO_FILESTORE_BASE = "/var/lib/odoo/filestore"  # per-tenant dirs under here
KEEP_ODOO_DUMPS = 7  # per tenant, local dir (the zip/R2 tiers carry their own retention)


def dump_odoo_dbs() -> tuple[bool, str]:
    """PYLOT Odoo tenant dumps (Steve-authorized 2026-07-19, task_1784481103969).
    Live Postgres on .103 — a file-level copy of a running PGDATA restores into
    a broken database, so this tier is pg_dump per tenant: consistent snapshots,
    gzipped into ORG_ROOT/backups/odoo/, riding the FULL zip + R2 (NOT the CORE
    zip — the gateway artifact stays lean). Tenant set is DERIVED from
    pg_database every run, never hand-listed: a tenant created tomorrow is
    dumped tomorrow. LOUD tier: returns (ok, status); a failure joins
    tier_failures and the run exits nonzero — .103 being down is a backup
    failure, not a skip. Acceptance for any change here is a real restore into
    a scratch database, watched — never a file appearing in a bucket."""
    out_dir = ORG_ROOT / "backups" / "odoo"
    ssh_opts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                "-o", "StrictHostKeyChecking=accept-new"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        # Derived tenant enumeration (excludes templates + the maintenance db).
        enum = subprocess.run(
            ["ssh", *ssh_opts, ODOO_HOST,
             f"docker exec {ODOO_PG_CONTAINER} psql -U odoo -d postgres -Atc "
             "\"SELECT datname FROM pg_database WHERE datistemplate=false "
             "AND datname <> current_database() ORDER BY datname\""],
            capture_output=True, text=True, timeout=40)
        if enum.returncode != 0:
            return False, f"Odoo dumps: FAILED (enumerate: {enum.stderr.strip() or enum.returncode})"
        tenants = [t for t in enum.stdout.split() if t]
        if not tenants:
            # Zero tenants is a FINDING, never a quiet success — the 07-19
            # no-database scare is exactly what this line exists to catch.
            return False, "Odoo dumps: FAILED (enumeration returned ZERO tenant databases)"
        lines = []
        for db in tenants:
            dest = out_dir / f"{db}-{stamp}.sql.gz"
            with open(dest, "wb") as fh:
                dump = subprocess.run(
                    ["ssh", *ssh_opts, ODOO_HOST,
                     f"docker exec {ODOO_PG_CONTAINER} pg_dump -U odoo -d {db} | gzip -6"],
                    stdout=fh, stderr=subprocess.PIPE, timeout=600)
            size = dest.stat().st_size if dest.exists() else 0
            # An empty or error-tailed dump must not ride the tiers looking like
            # a backup: gzip integrity + non-trivial size are the floor here;
            # the real acceptance (scratch restore) runs out-of-band.
            if dump.returncode != 0 or size < 10_000:
                dest.unlink(missing_ok=True)
                return False, (f"Odoo dumps: FAILED ({db}: rc={dump.returncode}, "
                               f"{size:,}B — {dump.stderr.decode(errors='replace').strip()[:120]})")
            gzchk = subprocess.run(["gzip", "-t", str(dest)], capture_output=True)
            if gzchk.returncode != 0:
                dest.unlink(missing_ok=True)
                return False, f"Odoo dumps: FAILED ({db}: gzip integrity check)"
            lines.append(f"{db} {size/1024/1024:.1f}MB")
            old = sorted(out_dir.glob(f"{db}-*.sql.gz"))
            for stale in old[:-KEEP_ODOO_DUMPS]:
                stale.unlink()
        # ── PASS 2: FILESTORE SWEEP — NON-BLOCKING (added 2026-08-31, engineer) ──────────
        # The DB tier above is COMPLETE and WRITTEN before a single line here runs. Odoo keeps
        # attachments on disk under the filestore (outside Postgres), so pg_dump alone restores
        # rows with dead attachment references — a DB-only backup that a row-count check calls
        # "restorable" while it is unusable. This pass captures each dumped tenant's filestore
        # paired 1:1 with its dump.
        #
        # INVARIANT (chief 2026-08-31): a filestore fault can make the RUN fail loudly, but it
        # CANNOT unwrite a dump. So we CONTINUE past any per-tenant filestore error, accumulate,
        # and fail at the END — never abort mid-sweep, because an abort on tenant 3 would leave
        # 4/5/6's dumps... already written (they are, above), but we still never let a filestore
        # problem short-circuit anything. Under any filestore fault the DB tier is byte-identical
        # to its old behaviour. Scoped to the SAME pg_database-derived tenant set as the dumps, so
        # a new tenant sweeps automatically and dropped-DB orphan filestores (discoverliwa,
        # silvermere-advisory, acme-*) are ignored by construction. Attachment resolution verified
        # 2026-08-31: all six live tenants resolve entirely within their own dirs.
        fs_lines, fs_failures = [], []
        for db in tenants:
            fdest = out_dir / f"{db}-{stamp}.filestore.tar.gz"
            try:
                with open(fdest, "wb") as fh:
                    cap = subprocess.run(
                        ["ssh", *ssh_opts, ODOO_HOST,
                         f"docker exec {ODOO_APP_CONTAINER} tar czf - -C {ODOO_FILESTORE_BASE} {db}"],
                        stdout=fh, stderr=subprocess.PIPE, timeout=600)
                fsize = fdest.stat().st_size if fdest.exists() else 0
                if cap.returncode != 0:
                    err = cap.stderr.decode(errors="replace").strip()
                    # A tenant with zero attachments may have no filestore dir: tar says "No such
                    # file". That is a legitimate empty, not a transport fault — record, don't fail.
                    if "No such file" in err or "Cannot stat" in err:
                        fdest.unlink(missing_ok=True)
                        fs_lines.append(f"{db} no-filestore")
                        continue
                    fdest.unlink(missing_ok=True)
                    fs_failures.append(f"{db}: rc={cap.returncode} {err[:80]}")
                    continue
                if subprocess.run(["gzip", "-t", str(fdest)], capture_output=True).returncode != 0 or fsize < 45:
                    fdest.unlink(missing_ok=True)
                    fs_failures.append(f"{db}: filestore gzip integrity / empty ({fsize}B)")
                    continue
                fs_lines.append(f"{db} {fsize/1024/1024:.1f}MB")
                for stale in sorted(out_dir.glob(f"{db}-*.filestore.tar.gz"))[:-KEEP_ODOO_DUMPS]:
                    stale.unlink()
            except Exception as e:  # noqa: BLE001 — per-tenant, NON-BLOCKING by design
                fdest.unlink(missing_ok=True)
                fs_failures.append(f"{db}: {e.__class__.__name__}: {e}")
        dbmsg = f"Odoo dumps: {len(tenants)} tenant(s) OK ({', '.join(lines)})"
        fsmsg = f"filestore: {', '.join(fs_lines) if fs_lines else 'none'}"
        if fs_failures:
            # LOUD, but the DBs are safe — the run is marked failed to surface the filestore gap,
            # and the dumps remain on disk and ride the tiers regardless.
            return False, (f"{dbmsg} — FILESTORE FAILED for {len(fs_failures)}/{len(tenants)}: "
                           f"{'; '.join(fs_failures)}. DBs are written and safe; filestore tier degraded.")
        return True, (f"{dbmsg}; {fsmsg} -> backups/odoo (rides FULL zip + R2; keep {KEEP_ODOO_DUMPS}/tenant)")
    except Exception as e:  # noqa: BLE001 — tier reports, main() attributes + exits
        return False, f"Odoo dumps: FAILED — {e}"


# ── ARTEFACT VERIFIER (task_1783808113790) ───────────────────────────────────
# The exclusion list (should_exclude) is what the build INTENDS to drop. This
# reads what the zip ACTUALLY contains, AFTER building and BEFORE shipping. The
# defect it closes: for ~25 days the backup mailed "Excluded credentials: .env
# files" every night WHILE shipping a live sk-ant key in `.env.bak-pre-*` — a
# narration that never read its own output, and the reason nobody looked. A
# backup that cannot prove what it shipped must not assert what it excluded.
#
# Patterns are STRICT (length-bearing) ON PURPOSE. Agent memory files legitimately
# DOCUMENT these very patterns as prose ("sk-ant-, ghp_, PRIVATE KEY, AKIA"), and
# they ride the backup — a loose matcher would flag the documentation and block
# every backup (grep-the-guard-not-the-bug, one layer along). A real secret clears
# the length bar; a doc mention or a `.env.example` placeholder does not.
CREDENTIAL_PATTERNS = [
    ("anthropic-key",   re.compile(r"sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{80,}")),
    ("openai-proj-key", re.compile(r"sk-proj-[A-Za-z0-9_-]{60,}")),
    ("github-token",    re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("github-pat-fg",   re.compile(r"github_pat_[A-Za-z0-9_]{60,}")),
    ("slack-token",     re.compile(r"xox[baprs]-\d[A-Za-z0-9-]{20,}")),
    ("aws-access-key",  re.compile(r"\bAKIA[A-Z0-9]{16}\b")),
    ("private-key",     re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")),
    ("google-sa-key",   re.compile(r'"private_key_id"\s*:\s*"[a-f0-9]{40}"')),
]

# Safe placeholder suffixes — carried on purpose, never real values.
_SAFE_ENV_SUFFIXES = (".env.template", ".env.example", ".env.sample", ".env.dist")


def _is_credential_filename(name: str) -> bool:
    """Belt-and-braces name check for a real .env credential file — the content
    scan is primary, this catches a credential file that happens to hold no
    matchable token. Whitelists the safe placeholder suffixes."""
    n = name.rsplit("/", 1)[-1].lower()
    if n.endswith(_SAFE_ENV_SUFFIXES):
        return False
    return (".env." in n or n.endswith(".env")
            or n in ("secrets.env", "gsc-service-account.json"))


def verify_archive_clean(zip_path: str) -> list:
    """Scan the BUILT archive's real contents for credential material. Returns a
    list of (entry, label) hits; a NON-EMPTY list means DO NOT SHIP. Reads the
    artefact, not the exclusion intent."""
    hits = []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            if name.endswith("/"):
                continue
            if _is_credential_filename(name):
                hits.append((name, "credential-filename"))
            if info.file_size > 5_000_000:  # secrets are tiny/textual; skip big binaries
                continue
            try:
                text = zf.read(name).decode("utf-8", "ignore")
            except Exception:
                continue
            for label, rx in CREDENTIAL_PATTERNS:
                if rx.search(text):
                    hits.append((name, label))
    return hits


# --- orphaned-temp startup sweep (2026-09-07, engineer; chief-reviewed) --------------------------
# The build dir below is a TemporaryDirectory whose cleanup runs on normal exit/exception but NOT on
# SIGTERM/SIGKILL or a restart-mid-build — so every INTERRUPTED backup orphans the ~600MB FULL-zip
# build in /tmp, and they accumulate (measured 2026-09-07: 5 orphans back to 08-26, ~1.68GB, the
# multi-night disk climb). A trap cannot fix this: SIGKILL is untrappable, so a startup-sweep is the
# only reliable form. It runs BEFORE this run builds anything.
#
# SAFETY (chief 2026-09-07): "any prior" cannot know it is prior — an overlapping/manual run's LIVE
# build dir must never be deleted out from under it (that yields a corrupt archive, strictly worse than
# the disk it frees). So the sweep is gated TWO ways and FAILS SAFE — it leaves garbage rather than
# risk an artefact: (1) a DISTINCTIVE prefix so only our own build dirs match, never arbitrary temps;
# (2) an AGE FLOOR comfortably past the longest real run — a dir younger than the floor is left alone,
# and a live run's build dir has a fresh mtime, so it is never a candidate.
BACKUP_TMP_PREFIX = "ctxbackup-"
STALE_TEMP_AGE_S = int(os.environ.get("BACKUP_TMP_STALE_S", str(3 * 3600)))  # 3h >> longest real run (~<30m)

def sweep_stale_backup_temps():
    import glob, shutil, time
    now = time.time(); reclaimed = 0
    for d in glob.glob(os.path.join(tempfile.gettempdir(), BACKUP_TMP_PREFIX + "*")):
        try:
            if not os.path.isdir(d):
                continue
            age = now - os.path.getmtime(d)
            if age < STALE_TEMP_AGE_S:
                continue  # too young — could be a LIVE concurrent run; leave it (fail safe)
            sz = sum(f.stat().st_size for f in Path(d).rglob("*") if f.is_file())
            shutil.rmtree(d, ignore_errors=True)
            reclaimed += sz
            print(f"startup-sweep: removed stale backup temp {d} (age {age/3600:.1f}h, {sz/1e6:.0f}MB orphaned)")
        except Exception as e:  # noqa: BLE001 — a sweep failure must never block the backup
            print(f"startup-sweep: skipped {d}: {e}", file=sys.stderr)
    if reclaimed:
        print(f"startup-sweep: reclaimed {reclaimed/1e6:.0f}MB of orphaned backup temps (age floor {STALE_TEMP_AGE_S//3600}h)")


# --- in-run SIGTERM/SIGINT trap (2026-10-07, engineer; task_1791306288308) --------------------
# The startup sweep above reclaims PRIOR runs' orphans, but only at RUN START — so an orphan from
# the 22:00Z backup is first swept by the NEXT run ~24h later (or the ~26h-later agent boot). That
# is ~24h of ~600MB on a 92%-full disk. The sweep cannot fix THIS run's orphan because it fails
# safe on anything younger than the 3h floor, and this run's build dir is always younger than that.
#
# The complement is a trap: TemporaryDirectory's cleanup runs on normal exit/exception but NOT on a
# signal (the process dies before __exit__). exit 143 (SIGTERM) is the measured foreground 120s
# tool-kill that orphaned the 632M dir on 2026-10-06; SIGTERM/SIGINT are trappable (only SIGKILL and
# power-loss are not — those remain the startup sweep's job, hence belt-and-suspenders). The handler
# removes THIS run's build dir and then re-raises the signal through the default handler so the exit
# code stays truthful (128+signum), i.e. a killed backup still reports as killed.
_CURRENT_BUILD_TMP = None  # set to the live build dir while a build is in flight; None otherwise

def _build_temp_signal_handler(signum, _frame):
    d = _CURRENT_BUILD_TMP
    if d and os.path.isdir(d):
        try:
            # The reclaim is the FUNCTION; the log line is a nicety. SIGTERM is often followed by
            # SIGKILL on a grace timer, so do the rmtree FIRST — never spend the grace computing a
            # size we then lose by dying mid-walk. shutil is the module-level import (importing
            # inside a signal handler can deadlock on the import lock if the main thread holds it).
            shutil.rmtree(d, ignore_errors=True)
            print(f"signal-trap: {signal.Signals(signum).name} received mid-build — "
                  f"removed this run's temp {d} before exit", file=sys.stderr)
        except Exception as e:  # noqa: BLE001 — cleanup must never mask the signal
            print(f"signal-trap: {signum} received; cleanup of {d} failed: {e}", file=sys.stderr)
    # Restore the default disposition and re-raise so the exit code is the honest 128+signum
    # (a swallowed signal would report success for a killed run — the invisible-failure class).
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)

def install_build_temp_trap():
    """Register the SIGTERM/SIGINT cleanup trap. Must run on the main thread (main() does)."""
    for _sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(_sig, _build_temp_signal_handler)


# --- pre-flight disk-headroom gate (2026-09-15, engineer; task_1789424010395) -----------------
# WHY: on 2026-09-14 a hand-run of the daily backup filled the root disk to 100%. The box sits
# CHRONICALLY at ~96% (~2.3GB free) and a single run's transient peak tipped it over — and there
# was NO pre-flight disk check. This gate refuses to run below a headroom floor and EXITS NON-ZERO
# LOUDLY; a silent skip would only move the next incident somewhere quieter.
#
# N (BACKUP_MIN_FREE_GB, default 3GB) — DERIVED, not a round number:
#   measured single-run peak ~1.5GB  = 617MB ctxbackup temp holding the FULL zip (measured on the
#                                       night of the fill) + ~600MB retain-copy double-write during
#                                       the final copy + ~300MB odoo dumps written before zipping
#   + ~1.5GB margin                   = the unmeasured git-bundle set + a post-run floor on a box
#                                       shared by 8 agents (a disk-full is FLEET-WIDE harm)
#   Erring high is the fail-safe direction; env-overridable so N is tunable without a code edit
#   (and so both gate directions can be exercised on the real disk via --preflight-check).
#
# CHRONIC vs TIGHT (chief 2026-09-15): a permanently-on gate stops carrying information — someone
# raises N or comments it out to push a backup through, and then it is gone. So the gate counts
# CONSECUTIVE refusals in a state file and DISTINGUISHES a single tight night from a chronically
# too-full disk: on the Nth consecutive refusal it ESCALATES ONCE to a human, then suppresses
# re-paging until a pass resets it — one finding, not one-incident-per-night. Every refusal still
# names N-wanted, N-found, the largest reclaimable target, and says THE GATE IS NOT THE PROBLEM
# (couples to the disk-attribution finding: the gate stops the bleeding, that row lets backups run).
BACKUP_MIN_FREE_GB = float(os.environ.get("BACKUP_MIN_FREE_GB", "3"))
HEADROOM_CHRONIC_RUNS = int(os.environ.get("BACKUP_HEADROOM_CHRONIC_RUNS", "2"))
HEADROOM_STATE_FILE = os.environ.get("BACKUP_HEADROOM_STATE", "/home/cortext/backups/.headroom-gate-state.json")
HEADROOM_EXIT_CODE = 3  # distinct non-zero: "refused, did not run" — NOT a backup failure

def _headroom_decision(free_bytes: int, min_free_bytes: int) -> bool:
    """Pure pass/refuse. True = enough headroom to run. Testable both directions with no I/O."""
    return free_bytes >= min_free_bytes

def _read_headroom_state() -> dict:
    try:
        with open(HEADROOM_STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"consecutive_refusals": 0, "escalated": False}

def _write_headroom_state(state: dict) -> None:
    try:
        with open(HEADROOM_STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception as e:  # state I/O must never crash or block the gate
        print(f"headroom-gate: could not persist state: {e}", file=sys.stderr)

def _largest_reclaimable() -> str:
    """Best-effort human hint at the biggest thing to delete. Never fatal, never slow (du timeout)."""
    import glob as _glob
    candidates = [
        os.path.join(tempfile.gettempdir(), BACKUP_TMP_PREFIX + "*"),  # orphaned build temps
        "/home/cortext/.cache",
        "/home/cortext/backups",
    ]
    best = None
    for pat in candidates:
        for p in (_glob.glob(pat) if "*" in pat else [pat]):
            try:
                if not os.path.exists(p):
                    continue
                out = subprocess.run(["du", "-sb", p], capture_output=True, text=True, timeout=20).stdout
                sz = int(out.split("\t")[0] or 0)
                if best is None or sz > best[1]:
                    best = (p, sz)
            except Exception:
                continue
    return f"{best[0]} (~{best[1]/1e9:.1f}GB)" if best else "unknown (du unavailable)"

def _escalate_chronic(free_gb: float, largest: str) -> None:
    """Escalate ONCE when the disk is chronically too full. Best-effort; never fatal.

    ROUTES TO CHIEF via the bus, NOT a direct operator page (2026-09-16, engineer;
    task_1789539468054). This runs from the 22:00Z backup cron = 02:00 the operator's
    local time; a direct Telegram to the operator at 02:00 carries nothing they can act
    on in the moment and violates the contact-clock discipline every other path already
    honours. Chief holds the contact clock and surfaces this at an appropriate hour. A
    bus send-message persists in chief's inbox and redelivers on his next boot, so the
    signal is durable even if his session is momentarily down — strictly better than a
    fire-and-forget Telegram. (The old CHAT_ID send-telegram path was the direct-operator
    page; kept in git history, not here.)"""
    text = (f"🔴 BACKUP GATE (engineer): root disk chronically too full — backups REFUSED "
            f"{HEADROOM_CHRONIC_RUNS}+ runs running (found {free_gb:.2f}GB free, need "
            f"{BACKUP_MIN_FREE_GB:.1f}GB). Largest reclaimable: {largest}. Backups are NOT running "
            f"until the disk is cleared. The gate is working — the disk needs the attention. "
            f"Surface to the operator at an appropriate hour (fired at the 22:00Z cron = 02:00 local). [backup.py]")
    if shutil.which("cortextos"):
        try:
            subprocess.run(["cortextos", "bus", "send-message", "chief", "high", text], timeout=30)
            return
        except Exception as e:
            print(f"headroom-gate: escalation send failed: {e}", file=sys.stderr)
    print(f"headroom-gate: ESCALATION (no bus path): {text}", file=sys.stderr)

def preflight_headroom_gate() -> None:
    """Refuse+exit-nonzero-loud if free disk < N. Distinguishes tight vs chronic; escalates once.
    On PASS it clears any chronic streak and returns (caller proceeds)."""
    fs = tempfile.gettempdir()  # where the ctxbackup temp (the transient peak) is created
    free = shutil.disk_usage(fs).free
    min_free = int(BACKUP_MIN_FREE_GB * (1024 ** 3))
    if _headroom_decision(free, min_free):
        st = _read_headroom_state()
        if st.get("consecutive_refusals") or st.get("escalated"):
            _write_headroom_state({"consecutive_refusals": 0, "escalated": False})
        return
    # --- refuse ---
    st = _read_headroom_state()
    streak = int(st.get("consecutive_refusals", 0)) + 1
    escalated = bool(st.get("escalated", False))
    largest = _largest_reclaimable()
    free_gb = free / (1024 ** 3)
    chronic = streak >= HEADROOM_CHRONIC_RUNS
    head = (f"🔴 BACKUP REFUSED ({streak} runs running): root disk CHRONICALLY too full to back up."
            if chronic else
            f"BACKUP REFUSED: disk temporarily tight (refusal #{streak}; escalates to a human at #{HEADROOM_CHRONIC_RUNS}).")
    print(f"{head}\n"
          f"  wanted >= {BACKUP_MIN_FREE_GB:.1f}GB free on {fs}, found {free_gb:.2f}GB.\n"
          f"  largest reclaimable target: {largest}.\n"
          f"  THE GATE IS NOT THE PROBLEM — it prevents a repeat of the 2026-09-14 root-disk fill.\n"
          f"  Backups will not run until free space is restored (disk-attribution finding: "
          f"docker ~8GB in HOME + unattributed usage). Fix the disk, not the gate.", file=sys.stderr)
    if chronic and not escalated:
        _escalate_chronic(free_gb, largest)
        escalated = True
    _write_headroom_state({"consecutive_refusals": streak, "escalated": escalated,
                           "last_refusal_utc": datetime.now(timezone.utc).isoformat()})
    sys.exit(HEADROOM_EXIT_CODE)


# --- self-detach guard (2026-09-27, engineer; task_1788943819734) -----------------------------
# WHY: this script is CLAUDE-MEDIATED — the backup-daily daemon cron injects a prompt into the
# engineer session, which runs backup.py in the FOREGROUND. Any foreground caller with a timeout
# (the ~120s agent tool cap, a heartbeat wrapper) SIGTERMs the whole process group when it fires —
# mid FULL-zip that leaves a partial bundle set + a /tmp orphan (observed 2026-09-08 22:00Z). The
# startup-sweep above only HEALS that after the fact on the next run; it does not PREVENT the kill.
#
# FIX: an opt-in --detach that hands the heavy build+upload to a session DETACHED from the caller's
# session/process group, so a SIGTERM to the caller's group cannot reach it. The mechanism is a pure
# start_new_session=True (the child calls setsid() before exec -> new session, new pgroup, no
# controlling tty). The fast synchronous gates (sweep + headroom refuse) stay in the FOREGROUND so a
# refusal is still seen by the caller. Default (no --detach) is byte-for-byte the old behaviour, so
# the nightly cron path is unchanged until the cron is deliberately switched to --detach.
#
# A bash wrapper captures the child's real exit code into <log>.rc as its final act — this is more
# reliable than instrumenting every sys.exit() tier, and lets a poller read completion + status with
# no live handle to a process in another session.
BACKUP_DETACH_LOG_DIR = os.environ.get("BACKUP_DETACH_LOG_DIR", "/home/cortext/backups/detach-logs")

def spawn_detached(argv, log_path):
    """Run argv detached from the caller's session/process group; stream its output to log_path and
    write the exit code to <log_path>.rc when it finishes. Returns the child PID. The child is a
    session leader (start_new_session=True), so a SIGTERM/SIGKILL delivered to the CALLER's process
    group — the way a foreground timeout kills — does not reach it."""
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    rc_path = log_path + ".rc"
    # Remove any stale rc so a poller can never read a previous run's status as this run's.
    try:
        os.unlink(rc_path)
    except FileNotFoundError:
        pass
    inner = " ".join(shlex.quote(a) for a in argv)
    wrapper = f"{inner} > {shlex.quote(log_path)} 2>&1; echo $? > {shlex.quote(rc_path)}"
    p = subprocess.Popen(
        ["bash", "-c", wrapper],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,                       # -> setsid(): new session + pgroup, detached
        env={**os.environ, "BACKUP_DETACHED": "1"},   # marks the child; also guards re-detach
    )
    return p.pid


def main():
    parser = argparse.ArgumentParser(description="Backup a cortextos org (content org-scoped, transport infra-scoped)")
    parser.add_argument("--org", default=DEFAULT_ORG,
                        help=f"Org to back up (a directory under cortextos/orgs/). Default: {DEFAULT_ORG}. "
                             "Git bundles + umami dump run only in the default (infra) org's invocation — "
                             "_discover_repos() already spans every org.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build zip and report size; do not upload.")
    parser.add_argument("--no-ftp", action="store_true",
                        help="Skip Step 2 FTPS upload even if configured.")
    parser.add_argument("--no-gateway", action="store_true",
                        help="Skip Step 2b off-host gateway copy.")
    parser.add_argument("--no-s3", action="store_true",
                        help="Skip Step 2e S3 off-host tier even if configured.")
    parser.add_argument("--preflight-check", action="store_true",
                        help="Run ONLY the disk-headroom pre-flight gate and exit "
                             "(0 = enough free space to back up; non-zero = refused). Runs no backup — "
                             "also the harness for proving the gate refuses below N and passes above it.")
    parser.add_argument("--detach", action="store_true",
                        help="Run the heavy build+upload in a DETACHED session (survives a foreground "
                             "caller's timeout/SIGTERM; see spawn_detached). The fast gates (temp sweep + "
                             "disk headroom refuse) still run synchronously first so a refusal is seen by "
                             "the caller; then the run is handed off and this invocation returns. Poll "
                             "<log>.rc for the exit code. Use for manual/tool-invoked runs; the nightly "
                             "cron keeps the default foreground path unless switched to --detach.")
    global _CURRENT_BUILD_TMP  # rebound when a build dir is in flight (see the with-block below)
    args = parser.parse_args()
    configure_org(args.org)

    # Trap SIGTERM/SIGINT so a mid-build kill cleans THIS run's temp instead of orphaning it
    # (the startup sweep only reclaims PRIOR runs, and not until the next run ~24h later). Belt-
    # and-suspenders with the sweep: the trap covers the trappable kills, the sweep covers SIGKILL
    # and power-loss. Registered before any temp is created; harmless on the detach-parent path,
    # which returns before a build dir exists (the handler no-ops while _CURRENT_BUILD_TMP is None).
    install_build_temp_trap()

    # Reclaim any orphaned build dirs from a previously-killed run BEFORE we build (see above).
    sweep_stale_backup_temps()

    # Pre-flight disk-headroom gate: refuse+exit-nonzero if free < N, AFTER the sweep has reclaimed
    # orphaned temps (so the gate judges POST-reclaim free space — the same view a real run gets).
    if args.preflight_check:
        preflight_headroom_gate()  # exits non-zero on refuse
        print(f"headroom-gate: PASS — >= {BACKUP_MIN_FREE_GB:.1f}GB free on {tempfile.gettempdir()}; a backup may run.")
        return
    preflight_headroom_gate()  # normal run: refuse before any dumps/temp/zip touch the disk

    # Self-detach: the fast gates above (sweep + headroom refuse) have run synchronously in the
    # foreground, so a caller still sees a refusal. Hand the heavy remainder to a detached session
    # that a foreground timeout cannot kill, then return immediately. The BACKUP_DETACHED guard stops
    # the detached child (which re-runs this file WITHOUT --detach anyway) from recursing.
    if args.detach and not os.environ.get("BACKUP_DETACHED"):
        child_argv = [sys.executable, os.path.abspath(__file__)] + \
                     [a for a in sys.argv[1:] if a != "--detach"]
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        log_path = os.path.join(BACKUP_DETACH_LOG_DIR, f"backup-{args.org}-{ts}.log")
        pid = spawn_detached(child_argv, log_path)
        print(f"backup detached: pid={pid}")
        print(f"  log: {log_path}")
        print(f"  done when this exists: {log_path}.rc  (contents = exit code, 0 = success)")
        return

    try:
        secrets = load_secrets()
    except FileNotFoundError:
        print(f"ERROR: secrets file not found: {SECRETS_FILE}", file=sys.stderr)
        sys.exit(1)

    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")

    if INFRA_TIERS:
        print(f"Umami DB dump: {dump_umami_db()}")
        odoo_ok, odoo_status = dump_odoo_dbs()
        print(odoo_status)
    else:
        print(f"Umami DB dump: skipped — infra tier, runs in the {DEFAULT_ORG} invocation")
        odoo_ok, odoo_status = True, "Odoo dumps: not run here — infra tier"

    with tempfile.TemporaryDirectory(prefix=BACKUP_TMP_PREFIX) as tmp:
        # Expose this run's build dir to the signal trap so a SIGTERM/SIGINT mid-build removes it
        # before exit. Stays set through the upload phases (the dir lives until this block exits) and
        # is reset to None just after the block, so a signal on the final exit path finds nothing.
        _CURRENT_BUILD_TMP = tmp
        zip_path = os.path.join(tmp, f"{ZIP_PREFIX}{date_str}.zip")
        print(f"Building backup zip...")
        size_mb, skipped = build_zip(zip_path)
        print(f"Zip size: {size_mb:.2f} MB")

        # CORE/FULL split (task_1784285554485): CORE = INCLUDE_PATTERNS, the
        # lean artifact — it exists for the gateway leg, whose LXC is small
        # (~2.1G; see upload_to_gateway's headroom note). FULL = CORE + the
        # projects sweep, rides the roomy tiers (.10, R2). The two tiers
        # protect different sets ON PURPOSE — a deliberate, documented
        # divergence, not a decoy. (The 20MB email limit that originally
        # forced this split left with the email tier, 2026-07-19; the
        # gateway capacity reason stands on its own.)
        print(f"CORE zip {size_mb:.2f} MB (gateway + all tiers; set = INCLUDE_PATTERNS above)")

        swept, n_swept, n_census = swept_projects()
        print(f"projects swept: {n_swept} of {n_census} (census); "
              f"own-repo projects ride the bundle tier")
        full_path = os.path.join(tmp, f"{ZIP_PREFIX}full-{date_str}.zip")
        # backups/odoo rides the FULL zip only (roomy tiers: .10 + R2); the
        # CORE/gateway artifact stays lean — see dump_odoo_dbs.
        full_extra = swept + ([ORG_ROOT / "backups" / "odoo"] if INFRA_TIERS else [])
        full_size, full_skipped = build_zip(full_path, extra_dirs=full_extra)
        print(f"FULL zip {full_size:.2f} MB — projects sweep rides the .10 + R2 tiers (gateway carries CORE)")

        if skipped:
            print(f"Excluded {len(skipped)} file(s) (credentials/binaries)")

        # ARTEFACT VERIFY (task_1783808113790) — read what the zip CONTAINS, before
        # ANY ship (retain, gateway, .10, R2). The `Excluded N` line above is INTENT;
        # this is the FACT. On any hit: fail loud, do not ship, name what was FOUND.
        verify_hits = []
        for zlabel, zp in (("CORE", zip_path), ("FULL", full_path)):
            for entry, kind in verify_archive_clean(zp):
                verify_hits.append((zlabel, entry, kind))
        if verify_hits:
            print("Artefact verify: FAILED — credential material found IN THE BUILT ZIP; "
                  "NOT SHIPPING:", file=sys.stderr)
            for zlabel, entry, kind in verify_hits:
                print(f"  [{zlabel}] {entry} :: {kind}", file=sys.stderr)
            print("A backup that cannot prove what it shipped is not shipped. "
                  "Fix should_exclude and re-run.", file=sys.stderr)
            sys.exit(2)
        print("Artefact verify: CLEAN — scanned CORE+FULL archive CONTENTS, 0 credential "
              "hits (reads the zip itself, not the exclusion list).")

        # Durable on-box retained copy FIRST — the must-have safety net, done
        # before the upload tiers so a retained snapshot exists even if they fail.
        if args.dry_run:
            local_status = f"Local retain: dry-run — would copy to {LOCAL_RETAIN_DIR}"
        else:
            local_status = retain_local(zip_path, date_str)
        print(local_status)

        # Step 2 — FTPS off-site upload (only if configured; currently unconfigured)
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
        if not INFRA_TIERS:
            # Not silent: the email body + stdout both say WHERE this org's
            # history rides, so a reader auditing the family backup doesn't
            # conclude git history is unprotected.
            bundle_status = (f"Bundles: not run here — _discover_repos() spans all orgs, so "
                             f"{BACKUP_ORG}'s repo history ships in the {DEFAULT_ORG} nightly run")
        elif args.no_gateway:
            bundle_status = "Bundles: skipped (--no-gateway)"
        elif args.dry_run:
            bundle_status = (f"Bundles: dry-run — would rebuild + copy to "
                             f"{SECONDARY_TARGET}:{SECONDARY_BUNDLE_DIR} (gateway leg retired 2026-07-18)")
        else:
            ok_make, bundle_status = make_git_bundles()
            print(bundle_status)
            if ok_make:
                ok_sec, sec_up_status = upload_git_bundles_secondary()
                print(sec_up_status)
                # State the retirement wherever the tier reports, so a reader
                # auditing the email body doesn't conclude history lost a home
                # silently — it moved by decision, with an upgrade path.
                retired_note = ("Bundles->gateway: leg retired 2026-07-18 (Option 1) — "
                                ".10 is the off-box bundle home; gateway carries zips only")
                print(retired_note)
                bundle_status = f"{bundle_status}\n  {sec_up_status}\n  {retired_note}"
                bundles_failed = not ok_sec
            else:
                bundles_failed = True

        # Step 2e — S3-compatible off-host tier (the only leg that leaves this
        # PHYSICAL host; scp tiers are same-host VMs — Steve's 2026-07-18
        # catch). Runs after the bundle block so this run's bundles ride too.
        # Dormant-but-LOUD until Steve's R2-vs-B2 pick lands in secrets.env.
        if args.no_s3:
            s3_status = "S3 off-host: skipped (--no-s3)"
        elif args.dry_run:
            s3_cfg_probe = _s3_cfg(secrets)
            s3_status = (f"S3 off-host: dry-run — would encrypt + ship to "
                         f"{s3_cfg_probe['endpoint']}/{s3_cfg_probe['bucket']}/backups/{BACKUP_ORG}/"
                         if s3_cfg_probe
                         else "S3 off-host: dry-run — not configured (BACKUP_S3_ENDPOINT unset), leg staged dark")
        else:
            s3_artifacts = [Path(full_path)]
            if INFRA_TIERS and not args.no_gateway and not bundles_failed:
                s3_artifacts += sorted(GIT_BUNDLE_DIR.glob("*.bundle"))
            _ok_s3, s3_status = upload_to_s3(secrets, s3_artifacts)
            print(s3_status)

        # R2 size guardrail (task_1784412736637) — measure/project the R2
        # footprint every run and flag before the 10GB free-tier cliff. Runs in
        # both dry-run and real (it reads sizes, ships nothing). A RED (ceiling
        # breach) sets its own tier-failure so the run exits nonzero.
        this_bundle_bytes = 0
        if INFRA_TIERS and not args.no_gateway:
            this_bundle_bytes = sum(b.stat().st_size for b in GIT_BUNDLE_DIR.glob("*.bundle"))
        r2_ok, r2_line = r2_footprint_guard(
            secrets, int(full_size * 1024 * 1024), this_bundle_bytes)
        print(r2_line)
        r2_footprint_over = not r2_ok

        if args.dry_run:
            print(f"DRY RUN — {ftp_status}")
            print(f"DRY RUN — {gw_status}")
            print(f"DRY RUN — {s3_status}")
            return

        # EMAIL TIER REMOVED 2026-07-19 (Steve directive). The mailbox copy
        # (daily attach to bertha@ + weekly notice + IMAP self-prune) was made
        # redundant by the R2 tier — off-vendor, encrypted, restore-proven —
        # and carried a standing size cliff (the mailbox's 35MB wire ceiling
        # vs daily CORE growth). No send is attempted, not "skipped": the
        # send path no longer exists in this file. Restore: restore.py
        # (fetches from .10) or the R2 runbook it points at.

        # Fail loudly, PER TIER, at the very end (harness arm gateway-loud).
        # Every tier ran; now every failure is attributed by name so the
        # 22:0xZ cron read shows WHICH leg died, and the exit code makes the
        # run un-ignorable. A status string containing FAILED that only ever
        # landed in a report body is how the gateway tier could die
        # best-effort-silently onto a full disk (task_1784280833929).
        tier_failures = []
        for tier, status in (("local-retain", local_status), ("ftp", ftp_status),
                             ("gateway", gw_status), ("secondary", sec_status),
                             ("s3", s3_status), ("odoo-dump", odoo_status)):
            if "FAILED" in status:
                tier_failures.append(tier)
                print(f"ERROR: {tier} tier FAILED — {status}", file=sys.stderr)
        # R2 footprint RED (over the free-tier ceiling) is a run failure too —
        # a silent breach becomes a surprise bill or a rejected upload.
        if r2_footprint_over:
            tier_failures.append("r2-footprint")
            print(f"ERROR: r2-footprint OVER free-tier ceiling — {r2_line.strip()}", file=sys.stderr)

    # Build dir is gone now (TemporaryDirectory cleaned on normal block exit); clear the trap target
    # so a signal during the final exit path finds nothing to remove and does not double-free.
    _CURRENT_BUILD_TMP = None

    # Fail loudly. A backup that reports success while shipping no history is
    # worse than no backup: it buys false confidence and nobody looks again.
    # The zip tiers have already reported by here, so this exit code says
    # precisely "the git-history tier failed", and the cron surfaces it.
    if bundles_failed:
        print("ERROR: git-bundle tier FAILED — see per-leg status above "
              "(history must land on BOTH gateway and secondary)", file=sys.stderr)
        sys.exit(1)
    if tier_failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
