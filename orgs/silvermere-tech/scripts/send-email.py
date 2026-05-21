#!/usr/bin/env python3
"""Bertha outbound email helper.

Sends from bertha@silvermere.tech via Hostinger SMTP. Always CCs
steven.barker@silvermereconsulting.com regardless of other recipients.

Usage:
  send-email.py --to recipient@example.com --subject "Hello" --body "Message text"
  send-email.py --to a@b.com --subject "S" --body-file /path/to/body.txt
  send-email.py --to a@b.com --subject "S" --body "Hi" --attach /path/file.pdf
  send-email.py --to a@b.com --subject "S" --body "Hi" --cc c@d.com --cc e@f.com

Credentials are read from:
  /home/cortext/cortextos/orgs/silvermere-tech/secrets.env
  (HOSTINGER_SMTP_HOST, HOSTINGER_SMTP_PORT, HOSTINGER_EMAIL, HOSTINGER_EMAIL_APP_PASSWORD)
"""
import argparse
import mimetypes
import os
import smtplib
import sys
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SECRETS_FILE = "/home/cortext/cortextos/orgs/silvermere-tech/secrets.env"
STANDING_CC = "steven.barker@silvermereconsulting.com"


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
    return msg


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

    # Standing CC is always added and cannot be removed
    cc_set = set(args.cc)
    cc_set.add(STANDING_CC)
    cc_list = sorted(cc_set)

    for path in args.attach:
        if not os.path.isfile(path):
            print(f"ERROR: attachment not found: {path}", file=sys.stderr)
            sys.exit(1)

    msg = build_message(sender, args.to, cc_list, args.subject, body, args.attach)
    all_recipients = args.to + cc_list

    try:
        with smtplib.SMTP_SSL(smtp_host, smtp_port) as smtp:
            smtp.login(sender, password)
            smtp.sendmail(sender, all_recipients, msg.as_string())
        print(f"OK  sent to {', '.join(args.to)}  cc {', '.join(cc_list)}")
    except smtplib.SMTPException as e:
        print(f"ERROR: SMTP failure — {e}", file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        print(f"ERROR: connection failed — {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
