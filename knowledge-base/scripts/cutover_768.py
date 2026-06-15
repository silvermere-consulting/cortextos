#!/usr/bin/env python3
"""Cutover: atomically promote @768 shadow collections to live names.

This is the SHORT, controlled second half of the local-embedder migration. Run
it ONLY while the daemon is stopped (no agent is reading/writing ChromaDB), as
part of this operational sequence:

  1. build_768_shadows.py <chromadb>            # build + verify all 13 shadows
  2. set EMBEDDING_BACKEND=local in orgs/silvermere-tech/secrets.env
  3. pm2 stop cortextos-daemon                  # agents down — no concurrent access
  4. cutover_768.py <chromadb> --confirm        # THIS script: rename-swap
  5. pm2 start cortextos-daemon                 # agents respawn @768, query @768 live
  6. verify, keep <name>__old3072 as rollback for a day, then drop

Per target the swap is two metadata-only renames (instant, no data copy):
  live    <name>            ->  <name>__old3072     (parked for rollback)
  shadow  <name>__768shadow ->  <name>              (promoted to live)

Because the live collections are only renamed (not dropped) and the swap happens
while the daemon is stopped, there is ZERO window in which an agent queries a
dim-mismatched collection, and rollback is an instant reverse-rename.

PRE-FLIGHT (all-or-nothing): every target's shadow must exist and verify
(dim==768, count==live keep-count) and no <name>__old3072 may pre-exist, BEFORE
any rename runs. Any failure aborts with no changes.

CLI:
  cutover_768.py <chromadb_dir>                    # dry-run pre-flight only
  cutover_768.py <chromadb_dir> --confirm          # execute the swap
  cutover_768.py <chromadb_dir> --rollback --confirm  # reverse a completed swap
  cutover_768.py <chromadb_dir> --selftest         # isolated mechanic proof
"""
from __future__ import annotations

import sys
from pathlib import Path

import chromadb

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from local_embedder import EMBED_DIM  # noqa: E402
from recreate_collections_768 import export_all  # noqa: E402
from build_768_shadows import DEFAULT_TARGETS, DEFAULT_SUFFIX, _keep_entries, _shadow_dim  # noqa: E402

OLD_SUFFIX = "__old3072"


def _live_keep_count(col):
    ids, docs, metas = export_all(col)
    return len(_keep_entries(ids, docs, metas))


def preflight(client, targets, suffix):
    """Return (ok, report). Verifies every shadow before any swap."""
    names = {c.name for c in client.list_collections()}
    rows, ok = [], True
    for name in targets:
        shadow_name = f"{name}{suffix}"
        old_name = f"{name}{OLD_SUFFIX}"
        problems = []
        if name not in names:
            problems.append("live missing")
        if shadow_name not in names:
            problems.append("shadow missing")
        if old_name in names:
            problems.append(f"{old_name} already exists (prior cutover not cleaned)")
        want = sdim = scount = None
        if name in names and shadow_name in names:
            want = _live_keep_count(client.get_collection(name))
            sh = client.get_collection(shadow_name)
            scount = sh.count()
            sdim = _shadow_dim(sh) if scount else None
            if scount != want:
                problems.append(f"count {scount} != live keep {want}")
            if want and sdim != EMBED_DIM:
                problems.append(f"dim {sdim} != {EMBED_DIM}")
        if problems:
            ok = False
        rows.append({"name": name, "shadow_count": scount, "live_keep": want,
                     "dim": sdim, "problems": problems})
    return ok, rows


def do_swap(client, targets, suffix):
    swapped = []
    for name in targets:
        live = client.get_collection(name)
        live.modify(name=f"{name}{OLD_SUFFIX}")        # park old @3072
        client.get_collection(f"{name}{suffix}").modify(name=name)  # promote shadow
        swapped.append(name)
        print(f"  swapped {name}: live->{name}{OLD_SUFFIX}, {name}{suffix}->{name}", flush=True)
    return swapped


def do_rollback(client, targets, suffix):
    names = {c.name for c in client.list_collections()}
    done = []
    for name in targets:
        old = f"{name}{OLD_SUFFIX}"
        if old not in names:
            print(f"  [{name}] no {old} to roll back — skip")
            continue
        # current live (the promoted @768) -> back to shadow name; old -> live
        if name in names:
            client.get_collection(name).modify(name=f"{name}{suffix}")
        client.get_collection(old).modify(name=name)
        done.append(name)
        print(f"  rolled back {name}: {old}->{name}, promoted->{name}{suffix}", flush=True)
    return done


def selftest(client, suffix):
    base = "cutover-selftest"
    live, shadow, old = base, f"{base}{suffix}", f"{base}{OLD_SUFFIX}"
    for n in (live, shadow, old):
        try:
            client.delete_collection(n)
        except Exception:
            pass
    lc = client.create_collection(live)
    lc.add(ids=["a", "b"], documents=["x", "y"],
           metadatas=[{"k": 1}, {"k": 2}], embeddings=[[0.1] * 3072, [0.2] * 3072])
    sc = client.create_collection(shadow)
    sc.add(ids=["a", "b"], documents=["x", "y"],
           metadatas=[{"k": 1}, {"k": 2}], embeddings=[[0.1] * EMBED_DIM, [0.2] * EMBED_DIM])
    ok_pf, _ = preflight(client, [base], suffix)
    do_swap(client, [base], suffix)
    names = {c.name for c in client.list_collections()}
    live_dim = _shadow_dim(client.get_collection(live))
    swap_ok = (live in names and old in names and shadow not in names and live_dim == EMBED_DIM)
    do_rollback(client, [base], suffix)
    names2 = {c.name for c in client.list_collections()}
    rb_dim = _shadow_dim(client.get_collection(live))
    rb_ok = (live in names2 and shadow in names2 and old not in names2 and rb_dim == 3072)
    for n in (live, shadow, old):
        try:
            client.delete_collection(n)
        except Exception:
            pass
    ok = ok_pf and swap_ok and rb_ok
    print(f"SELFTEST: preflight={ok_pf} swap(live@{live_dim})={swap_ok} "
          f"rollback(live@{rb_dim})={rb_ok} -> {'PASS' if ok else 'FAIL'}")
    return ok


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    chroma = args[0]
    rest = args[1:]
    suffix = DEFAULT_SUFFIX
    if "--suffix" in rest:
        i = rest.index("--suffix")
        suffix = rest[i + 1]
        del rest[i:i + 2]
    confirm = "--confirm" in rest
    rollback = "--rollback" in rest

    client = chromadb.PersistentClient(path=chroma)

    if "--selftest" in rest:
        return 0 if selftest(client, suffix) else 1

    targets = DEFAULT_TARGETS

    if rollback:
        if not confirm:
            print("Rollback is a mutating op — re-run with --confirm.")
            return 2
        print("ROLLBACK: reverse-renaming promoted shadows back to __old3072 live...")
        done = do_rollback(client, targets, suffix)
        print(f"Rolled back {len(done)} collections.")
        return 0

    ok, rows = preflight(client, targets, suffix)
    print(f"PRE-FLIGHT ({len(rows)} targets) — all-or-nothing:")
    for r in rows:
        flag = "OK " if not r["problems"] else "XX "
        print(f"  {flag}{r['name']:30s} shadow={r['shadow_count']} live_keep={r['live_keep']} "
              f"dim={r['dim']}  {'; '.join(r['problems'])}")
    if not ok:
        print("\nPRE-FLIGHT FAILED — no changes made. Fix shadows (build_768_shadows.py) and retry.")
        return 1
    if not confirm:
        print("\nPRE-FLIGHT PASSED. Dry-run only — re-run with --confirm to swap "
              "(ENSURE daemon is stopped first).")
        return 0
    print("\nExecuting cutover swap (daemon MUST be stopped)...")
    swapped = do_swap(client, targets, suffix)
    print(f"\nCUTOVER COMPLETE: {len(swapped)} collections promoted to @{EMBED_DIM}. "
          f"Old @3072 parked as <name>{OLD_SUFFIX} (rollback: --rollback --confirm).")
    print("CUTOVER_768_COMPLETE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
