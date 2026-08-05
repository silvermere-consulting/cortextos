#!/usr/bin/env python3
"""Bertha outbound email helper.

Sends from bertha@silvermere.tech via Hostinger SMTP. Always CCs
steven.barker@silvermereconsulting.com regardless of other recipients,
UNLESS --no-cc is passed (for system/automated sends like backups that
must not clutter Steven's inbox).

Usage:
  send-email.py --to recipient@example.com --subject "Hello" --body "Message text"
  send-email.py --to a@b.com --subject "S" --body-file /path/to/body.txt
  send-email.py --to a@b.com --subject "S" --body "Hi" --attach /path/file.pdf
  send-email.py --to a@b.com --subject "S" --body "Hi" --cc c@d.com --cc e@f.com
  send-email.py --to bertha@silvermere.tech --subject "[BACKUP]..." --body "..." --attach zip --no-cc

Credentials are read from:
  /home/cortext/cortextos/orgs/silvermere-tech/secrets.env
  (HOSTINGER_SMTP_HOST, HOSTINGER_SMTP_PORT, HOSTINGER_EMAIL, HOSTINGER_EMAIL_APP_PASSWORD)
"""
import argparse
import json
import mimetypes
import os
import smtplib
import sys
from datetime import datetime, timezone
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import make_msgid

SECRETS_FILE = "/home/cortext/cortextos/orgs/silvermere-tech/secrets.env"
STANDING_CC = "steven.barker@silvermereconsulting.com"
# Durable send record (task_1785948533227). A scripted SMTP send does NOT append
# to bertha's IMAP Sent, so without this there is NO trace of what went out — it
# cost an hour to answer "did that outreach send" and would cost the same again.
# One JSON line per send ATTEMPT (success AND failure). Message-ID is the
# load-bearing field: the only durable handle a bounce or DMARC report ties back
# to. Outreach is low-volume, so append-only — no rotation needed.
SEND_LOG = "/home/cortext/cortextos/orgs/silvermere-tech/logs/send-email.jsonl"


def load_secrets(path):
    secrets = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            secrets[key.strip()] = val.strip()
    return secrets


def build_message(sender, to_list, cc_list, subject, body, attachments):
    if attachments:
        msg = MIMEMultipart("mixed")
        msg.attach(MIMEText(body, "plain", "utf-8"))
        for path in attachments:
            mime_type, _ = mimetypes.guess_type(path)
            main_type, sub_type = (mime_type or "application/octet-stream").split("/", 1)
            with open(path, "rb") as f:
                data = f.read()
            part = MIMEBase(main_type, sub_type)
            part.set_payload(data)
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=os.path.basename(path))
            msg.attach(part)
    else:
        msg = MIMEText(body, "plain", "utf-8")

    msg["From"] = sender
    msg["To"] = ", ".join(to_list)
    msg["Cc"] = ", ".join(cc_list)
    msg["Subject"] = subject
    # Set an explicit Message-ID so the value we LOG is the value on the wire.
    # Without this the SMTP server assigns one and the sender never learns it —
    # which is exactly why the send was untraceable.
    msg["Message-ID"] = make_msgid(domain="silvermere.tech")
    return msg


def log_send(record):
    """Append one JSON line to the durable send log. Best-effort: a logging
    failure must never mask or block the actual send result."""
    try:
        os.makedirs(os.path.dirname(SEND_LOG), exist_ok=True)
        with open(SEND_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:  # noqa: BLE001 — logging must not break the send path
        print(f"WARN: could not write send log ({SEND_LOG}): {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Send email via Bertha (bertha@silvermere.tech)")
    parser.add_argument("--to", required=True, action="append", dest="to", metavar="EMAIL",
                        help="Recipient (repeatable)")
    parser.add_argument("--subject", required=True)
    body_group = parser.add_mutually_exclusive_group(required=True)
    body_group.add_argument("--body", help="Message body as string")
    body_group.add_argument("--body-file", help="Path to file containing message body")
    parser.add_argument("--attach", action="append", default=[], metavar="FILE",
                        help="File to attach (repeatable)")
    parser.add_argument("--cc", action="append", default=[], metavar="EMAIL",
                        help="Additional CC address (repeatable); standing CC is always added")
    parser.add_argument("--no-cc", action="store_true",
                        help="Skip the standing CC (for system/automated sends only — never use for human comms)")
    args = parser.parse_args()

    try:
        secrets = load_secrets(SECRETS_FILE)
    except FileNotFoundError:
        print(f"ERROR: secrets file not found: {SECRETS_FILE}", file=sys.stderr)
        sys.exit(1)

    smtp_host = secrets.get("HOSTINGER_SMTP_HOST")
    smtp_port = int(secrets.get("HOSTINGER_SMTP_PORT", 465))
    sender = secrets.get("HOSTINGER_EMAIL")
    password = secrets.get("HOSTINGER_EMAIL_APP_PASSWORD")

    if not all([smtp_host, sender, password]):
        print("ERROR: missing HOSTINGER_SMTP_HOST / HOSTINGER_EMAIL / HOSTINGER_EMAIL_APP_PASSWORD in secrets.env",
              file=sys.stderr)
        sys.exit(1)

    if args.body_file:
        with open(args.body_file) as f:
            body = f.read()
    else:
        body = args.body

    # Standing CC is always added for human-facing comms.
    # --no-cc bypasses it for system/automated sends (backups, cron jobs).
    cc_set = set(args.cc)
    if not args.no_cc:
        cc_set.add(STANDING_CC)
    cc_list = sorted(cc_set)

    for path in args.attach:
        if not os.path.isfile(path):
            print(f"ERROR: attachment not found: {path}", file=sys.stderr)
            sys.exit(1)

    msg = build_message(sender, args.to, cc_list, args.subject, body, args.attach)
    all_recipients = args.to + cc_list
    message_id = msg["Message-ID"]

    # Base send record — the same object is stamped with the result and logged on
    # EVERY path (ok / smtp_error / connection_error), so a failed send leaves a
    # trace too, not just a successful one.
    record = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": sender,
        "to": args.to,
        "cc": cc_list,
        "subject": args.subject,
        "message_id": message_id,
        "attachments": [os.path.basename(p) for p in args.attach],
    }

    try:
        with smtplib.SMTP_SSL(smtp_host, smtp_port) as smtp:
            smtp.login(sender, password)
            smtp.sendmail(sender, all_recipients, msg.as_string())
        record["result"] = "ok"
        log_send(record)
        print(f"OK  sent to {', '.join(args.to)}  cc {', '.join(cc_list)}  message-id {message_id}")
    except smtplib.SMTPException as e:
        record["result"] = "smtp_error"
        record["error"] = str(e)
        log_send(record)
        print(f"ERROR: SMTP failure — {e}", file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        record["result"] = "connection_error"
        record["error"] = str(e)
        log_send(record)
        print(f"ERROR: connection failed — {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
