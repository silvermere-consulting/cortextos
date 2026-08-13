#!/usr/bin/env python3
"""check-bertha.py — poll bertha@silvermere.tech IMAP inbox and surface
NEW unread messages to chief via the cortextos bus.

Design choices:
- Local seen-set in state/chief/bertha-seen.json keyed by Message-ID. We do
  NOT mark messages as read on the server — Steve still sees normal unread
  badges in his mail client.
- Surfaces only messages not previously surfaced. First run after deploy
  back-fills the seen-set with currently-unread IDs so we don't spam chief
  with the existing backlog.
- One bus send-message per new message, normal priority. Body is sender +
  subject + a short body excerpt (text/plain preferred, HTML stripped to
  text as a fallback).
- Idempotent: safe to re-run by cron without dedup issues.

Reads (from orgs/silvermere-tech/secrets.env or env):
  HOSTINGER_EMAIL              — bertha@silvermere.tech
  HOSTINGER_EMAIL_APP_PASSWORD — app password
"""

from __future__ import annotations

import email
import imaplib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from email.header import decode_header, make_header
from pathlib import Path
from typing import Iterable

IMAP_HOST = os.environ.get("BERTHA_IMAP_HOST", "imap.hostinger.com")
IMAP_PORT = int(os.environ.get("BERTHA_IMAP_PORT", "993"))
# Bounded polling (2026-08-13). WHY: IMAP4_SSL had NO timeout, so a stage that stalls (measured
# ~1 in 3 polls today, ABOVE the transport — login/select/fetch, not DNS) hangs until the ~120s
# harness/tool bound SIGTERMs the process (143) with NO output line; a `... | tail` caller reads
# tail's 0, and silence + 0 reads as "polled, nothing new" = a hang wearing a clean quiet.
# TWO bounds, because a per-op timeout is PER socket-op while the harness bound is TOTAL
# (measured: 3 stalled recv @ settimeout(2) = 6.0s, exactly 3x) — so a per-op timeout ALONE
# lets connect+login+select+fetch each burn it and blow the total bound in a multi-stall:
#   POLL_DEADLINE — WALL-CLOCK bound on the whole process (signal.alarm). THE guarantee: fires
#     however many stages stall, prints the line + which stage was in progress, exits 4.
#     Generous vs the MEASURED normal poll ~1.8s (NOT the phantom 45s, which was an imposed
#     `timeout 45`, never a duration). 60s = ~33x normal, well under the ~120s harness bound.
#   IMAP_TIMEOUT — per socket-op, defence-in-depth: fails a single stall faster than the deadline.
# Both env-overridable for the single-op blackhole AND multi-stall tests.
POLL_DEADLINE = int(os.environ.get("BERTHA_POLL_DEADLINE", "60"))
IMAP_TIMEOUT = int(os.environ.get("BERTHA_IMAP_TIMEOUT", "20"))
SECRETS_ENV = Path("/home/cortext/cortextos/orgs/silvermere-tech/secrets.env")
STATE_FILE = Path(
    os.environ.get("CTX_ROOT", os.path.expanduser("~/.cortextos/dev"))
) / "state" / "chief" / "bertha-seen.json"
BODY_EXCERPT_CHARS = 800  # cap surfaced body to keep Telegram-friendly

# ---- wall-clock deadline + per-stage timing (2026-08-13) ------------------------
# _STAGE names the stage in progress + when it started, so (a) the deadline handler can name
# the STALLED stage — a diagnosis, not another silent 143 — and (b) the success line reports
# per-stage elapsed, so a stage trending slow is visible BEFORE it becomes a hang. The real
# fault (~1 in 3 polls stall, above the transport) is unknown; this makes the next one legible.
_STAGE = {"name": "startup", "t0": time.monotonic()}
_TIMINGS: "dict[str, float]" = {}


def _enter(stage: str) -> None:
    now = time.monotonic()
    prev = _STAGE["name"]
    if prev:
        _TIMINGS[prev] = now - _STAGE["t0"]
    _STAGE["name"] = stage
    _STAGE["t0"] = now


def _deadline_handler(signum, frame):
    # Wall-clock deadline hit: the PROCESS (not one op) exceeded POLL_DEADLINE — the multi-stall
    # case a per-op socket timeout cannot bound (each op gets its own timeout; N stalls => N*T).
    # Name the stalled stage, then hard-exit 4. flush BOTH ways (flush=True AND an explicit
    # flush) because os._exit bypasses stdio flush and cron block-buffers stdout — without this
    # the load-bearing status line dies in the buffer and the fix silently becomes the bug.
    el = time.monotonic() - _STAGE["t0"]
    print(
        f"[check-bertha] TIMEOUT: poll did not complete within {POLL_DEADLINE}s "
        f"(stalled at stage={_STAGE['name']}, {el:.1f}s in it)",
        flush=True,
    )
    sys.stdout.flush()
    os._exit(4)


def _load_secrets() -> None:
    """Source HOSTINGER_EMAIL + HOSTINGER_EMAIL_APP_PASSWORD from secrets.env
    if not already in env. Lets the script run from cron without a shell."""
    if os.environ.get("HOSTINGER_EMAIL") and os.environ.get(
        "HOSTINGER_EMAIL_APP_PASSWORD"
    ):
        return
    if not SECRETS_ENV.exists():
        return
    with SECRETS_ENV.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.startswith("export "):
                key = key[len("export "):]
            if key in ("HOSTINGER_EMAIL", "HOSTINGER_EMAIL_APP_PASSWORD"):
                value = value.strip().strip('"').strip("'")
                os.environ.setdefault(key, value)


def _decode_header(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return raw or ""


def _extract_body(msg: email.message.Message) -> str:
    """Best-effort plain-text excerpt. Prefers text/plain part; falls back to
    text/html with tags stripped."""
    text_plain: str | None = None
    text_html: str | None = None
    non_text: list[str] = []  # content-types we saw but won't decode as body

    if msg.is_multipart():
        for part in msg.walk():
            if part.is_multipart():
                continue  # container part, no leaf payload
            ct = (part.get_content_type() or "").lower()
            if part.get("Content-Disposition", "").lower().startswith("attachment"):
                if ct:
                    non_text.append(ct)
                continue
            if ct == "text/plain" and text_plain is None:
                text_plain = _decode_payload(part)
            elif ct == "text/html" and text_html is None:
                text_html = _decode_payload(part)
            elif not ct.startswith("text/"):
                non_text.append(ct)
    else:
        ct = (msg.get_content_type() or "").lower()
        if ct == "text/html":
            text_html = _decode_payload(msg)
        elif (msg.get_content_maintype() or "").lower() == "text":
            text_plain = _decode_payload(msg)
        else:
            # Single-part binary (e.g. an application/zip DMARC aggregate report).
            # Its payload is NOT a text body — decoding it as one is what fed a
            # ZIP's null bytes into the surface call. Surface a note, not bytes.
            return f"[non-text message: {ct or 'unknown content-type'}, no text body]"

    if text_plain:
        return _clean_text(text_plain)
    if text_html:
        return _clean_text(_strip_html(text_html))
    if non_text:
        return f"[no text body — non-text parts only: {', '.join(sorted(set(non_text)))}]"
    return ""


def _decode_payload(part: email.message.Message) -> str:
    try:
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")
    except Exception:
        try:
            return str(part.get_payload() or "")
        except Exception:
            return ""


_HTML_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
# Control chars EXCEPT \t \n \r (which _WS collapses). Strips the NULL byte a
# binary attachment decoded-as-text carries — subprocess.run refuses any arg
# containing \x00 (ValueError: embedded null byte), which crashed the whole
# poll before _save_seen and blocked the mailbox behind one DMARC ZIP.
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _strip_html(html: str) -> str:
    return _HTML_TAG.sub(" ", html)


def _clean_text(s: str) -> str:
    # Strip control/null bytes BEFORE whitespace-collapse — universal safety net
    # so no decoded payload from any path can carry a null into the surface call.
    return _WS.sub(" ", _CTRL.sub("", s)).strip()


def _load_seen() -> set[str]:
    if not STATE_FILE.exists():
        return set()
    try:
        with STATE_FILE.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return set(data.get("seen", []))
    except Exception:
        return set()


def _save_seen(seen: set[str]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Cap the seen-set so it can't grow unbounded over years of polling.
    capped = sorted(seen)[-5000:]
    tmp = STATE_FILE.with_suffix(STATE_FILE.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump({"seen": capped}, fh, indent=2)
    tmp.replace(STATE_FILE)


def _surface_to_chief(message_id: str, sender: str, subject: str, body: str) -> None:
    excerpt = body[:BODY_EXCERPT_CHARS]
    if len(body) > BODY_EXCERPT_CHARS:
        excerpt += "…"
    text = (
        f"BERTHA INBOX — new unread\n"
        f"From: {sender}\n"
        f"Subject: {subject}\n"
        f"Message-ID: {message_id}\n\n"
        f"{excerpt}"
    )
    subprocess.run(
        ["cortextos", "bus", "send-message", "chief", "normal", text],
        check=False,
    )


def _iter_unread_ids(imap: imaplib.IMAP4_SSL) -> Iterable[bytes]:
    typ, data = imap.search(None, "UNSEEN")
    if typ != "OK" or not data or not data[0]:
        return []
    return data[0].split()


# Above this size, a new message's FULL body is not fetched — only its first
# MIME part (where the text lives in ordinary and in our own backup mails),
# capped. The excerpt is 800 chars; a 22MB zip attachment adds nothing to it.
FULL_FETCH_MAX_BYTES = 2 * 1024 * 1024
_SIZE_RE = re.compile(rb"RFC822\.SIZE (\d+)")


def _fetch_headers(imap: imaplib.IMAP4_SSL, ids: list[bytes]) -> list[tuple[bytes, int, str]]:
    """ONE batched fetch of (size, Message-ID/From/Subject/Date headers) for
    all unread ids. Returns [(seq_id, rfc822_size, message_id_key), ...].

    This pass exists so the seen-check happens BEFORE any body fetch. The
    previous shape fetched full RFC822 of every UNSEEN message and THEN
    checked the seen-set — measured 2026-07-18: 169.2 MB per poll (7 keep-7
    backup-zip mails at ~22 MB dominate), which is chief's 90-120s polls.
    Headers for the same 58 messages are a few KB in one round trip."""
    typ, data = imap.fetch(
        b",".join(ids),
        "(RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE)])")
    if typ != "OK" or not data:
        return []
    out = []
    for item in data:
        if not isinstance(item, tuple):
            continue
        meta, header_bytes = item
        seq_m = re.match(rb"(\d+) ", meta)
        if not seq_m:  # response we can't attribute to a message — skip it
            continue
        seq = seq_m.group(1)
        m = _SIZE_RE.search(meta)
        size = int(m.group(1)) if m else 0
        hdr = email.message_from_bytes(header_bytes)
        mid = (hdr.get("Message-ID") or "").strip()
        if not mid:
            mid = f"no-msgid:{seq.decode(errors='replace')}:{_decode_header(hdr.get('Date'))}"
        out.append((seq, size, mid))
    return out


def _fetch_message(imap: imaplib.IMAP4_SSL, seq: bytes, size: int) -> email.message.Message | None:
    """Body fetch for a message the seen-diff proved NEW. Size-gated: ordinary
    mail comes whole; anything over FULL_FETCH_MAX_BYTES (backup zips) gets
    headers + first MIME part only — enough for the surfaced excerpt, without
    re-downloading an attachment nobody reads."""
    if size <= FULL_FETCH_MAX_BYTES:
        typ, data = imap.fetch(seq, "(RFC822)")
        if typ != "OK" or not data or not isinstance(data[0], tuple):
            return None
        return email.message_from_bytes(data[0][1])
    typ, data = imap.fetch(seq, "(BODY.PEEK[HEADER] BODY.PEEK[1]<0.65536>)")
    if typ != "OK" or not data:
        return None
    header_bytes = body_bytes = b""
    for item in data:
        if not isinstance(item, tuple):
            continue
        if b"BODY[HEADER]" in item[0].upper():
            header_bytes = item[1]
        else:
            body_bytes = item[1]
    if not header_bytes:
        return None
    msg = email.message_from_bytes(header_bytes)
    # Present the first part's text as a simple body for _extract_body.
    plain = body_bytes.decode("utf-8", errors="replace")
    stub = email.message.Message()
    for k, v in msg.items():
        stub[k] = v
    if stub.get_content_maintype() == "multipart":
        del stub["Content-Type"]
        stub["Content-Type"] = "text/plain"
    stub.set_payload(plain)
    return stub


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    bootstrap = "--bootstrap" in argv  # first deploy: backfill seen-set, no surface
    quiet = "--quiet" in argv

    _load_secrets()
    user = os.environ.get("HOSTINGER_EMAIL")
    pwd = os.environ.get("HOSTINGER_EMAIL_APP_PASSWORD")
    if not user or not pwd:
        print("[check-bertha] FAILED: HOSTINGER_EMAIL or HOSTINGER_EMAIL_APP_PASSWORD missing", flush=True)
        return 2

    signal.signal(signal.SIGALRM, _deadline_handler)
    signal.alarm(POLL_DEADLINE)  # WALL-CLOCK bound on the whole process — THE guarantee
    imap = None
    surfaced = 0
    try:
        _enter("connect")
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, timeout=IMAP_TIMEOUT)
        _enter("login")
        imap.login(user, pwd)
        _enter("select")
        imap.select("INBOX", readonly=True)  # readonly = won't flip \\Seen
        _enter("fetch")
        seen = _load_seen()
        new_seen = set(seen)

        unread = list(_iter_unread_ids(imap))
        # Header pass first (one batched round trip, a few KB), THEN the
        # seen-diff, THEN bodies only for what the diff proved new. Bodies of
        # already-seen unread mail are never re-downloaded.
        for seq, size, mid in (_fetch_headers(imap, unread) if unread else []):
            if mid in seen:
                continue
            new_seen.add(mid)

            if bootstrap:
                continue  # backfill only — do not surface

            msg = _fetch_message(imap, seq, size)
            if msg is None:
                # Header said new but the body fetch failed: do NOT record it
                # as seen, so the next poll retries instead of silently
                # swallowing the message forever.
                new_seen.discard(mid)
                continue
            sender = _decode_header(msg.get("From")) or "unknown"
            subject = _decode_header(msg.get("Subject")) or "(no subject)"
            body = _extract_body(msg)
            _surface_to_chief(mid, sender, subject, body)
            surfaced += 1

        if new_seen != seen:
            _save_seen(new_seen)
        _enter("done")
    except imaplib.IMAP4.error as exc:
        # Auth/protocol REJECTED (e.g. bad credentials) — distinct from a hang. Non-zero + a
        # FLUSHED status line naming the stage, so it is never a silent quiet.
        signal.alarm(0)
        print(f"[check-bertha] FAILED: imap {_STAGE['name']} rejected: {exc!r}", flush=True)
        return 3
    except (TimeoutError, OSError) as exc:
        # Per-op timeout / TLS / network — DEFENCE-IN-DEPTH under the wall-clock deadline; fails
        # a single stall faster than POLL_DEADLINE. socket.timeout is TimeoutError; ssl.SSLError
        # and ConnectionError are OSError, so this catches a stall however it surfaces.
        signal.alarm(0)
        print(
            f"[check-bertha] TIMEOUT: {_STAGE['name']} did not complete "
            f"(per-op <= {IMAP_TIMEOUT}s): {exc!r}",
            flush=True,
        )
        return 4
    finally:
        signal.alarm(0)  # cancel the deadline — nothing past here may block
        if imap is not None:
            try:
                imap.shutdown()  # abrupt close; never a clean logout that could itself re-hang
            except Exception:
                pass

    mode = "bootstrap" if bootstrap else "poll"
    stage_timings = " ".join(f"{k}={v:.2f}s" for k, v in _TIMINGS.items())
    if not quiet:
        print(
            f"[check-bertha] {mode}: surfaced={surfaced} "
            f"seen_total={len(_load_seen())} | {stage_timings}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
