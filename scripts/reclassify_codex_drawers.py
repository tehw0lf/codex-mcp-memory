#!/usr/bin/env python3
"""
Reclassify misclassified codex-import drawers in MemPalace ChromaDB.

Background:
  scripts/convert_memories.py imported Codex memories using their `type` field directly
  as wing names (milestone → wing_milestone, bugfix → wing_bugfix, etc.), producing
  ~30 inconsistent wing_* wings instead of the native Mempalace taxonomy.

This script corrects all drawers with added_by=codex-import by:
  1. Re-mapping wing + room to native Mempalace taxonomy
  2. Adding missing metadata fields (normalize_version, hall)
  3. Generating new IDs (format: drawer_{wing}_{room}_{hash24}) and doing
     delete + insert because the ID encodes wing+room

Wing mapping (Codex type → native Mempalace):
  milestone, project-milestone, session-summary, development-session
    → wing: projects, room: milestones
  bugfix, bug-fix, bug_fix
    → wing: projects, room: bugfixes
  release, project-release
    → wing: projects, room: releases
  decision
    → wing: projects, room: decisions
  optimization, optimization-complete, performance-optimization, performance-baseline
    → wing: projects, room: optimizations
  code-change, commit, git-commit
    → wing: projects, room: commits
  implementation, feature, feature-implementation
    → wing: projects, room: features
  user-preference, preference
    → wing: coding, room: preferences
  project-status, project-progress, project-context, project-vision
    → wing: projects, room: status
  investigation, spec-investigation, debugging
    → wing: projects, room: investigations
  lesson-learned, correction, verification
    → wing: projects, room: lessons
  workflow-update, documentation, documentation-milestone
    → wing: coding, room: workflows
  (everything else)
    → wing: projects, room: general

USAGE:
  # Preview (no writes):
  python reclassify_codex_drawers.py --dry-run --palace ~/.mempalace/palace

  # Live run:
  python reclassify_codex_drawers.py --palace ~/.mempalace/palace

REQUIREMENTS:
  uv run --with chromadb python reclassify_codex_drawers.py ...
  or: pip install chromadb
"""

import argparse
import hashlib
import os
import re
import sys
from collections import defaultdict
from pathlib import Path


# ── Wing/Room mapping ───────────────────────────────────────────────────────────

# Maps the raw codex_type (or wing suffix after "wing_") → (wing, room).
# Covers both hyphen and underscore variants (Codex used both inconsistently).
CODEX_TYPE_MAP: dict[str, tuple[str, str]] = {
    # milestones
    "milestone":              ("projects", "milestones"),
    "project-milestone":      ("projects", "milestones"),
    "project_milestone":      ("projects", "milestones"),
    "session-summary":        ("projects", "milestones"),
    "session_summary":        ("projects", "milestones"),
    "development-session":    ("projects", "milestones"),
    "development_session":    ("projects", "milestones"),
    "achievement":            ("projects", "milestones"),
    "checkpoint":             ("projects", "milestones"),
    "progress":               ("projects", "milestones"),
    "breakthrough":           ("projects", "milestones"),
    "task_completion":        ("projects", "milestones"),
    # bugfixes
    "bugfix":                 ("projects", "bugfixes"),
    "bug-fix":                ("projects", "bugfixes"),
    "bug_fix":                ("projects", "bugfixes"),
    "fix":                    ("projects", "bugfixes"),
    "security_fix":           ("projects", "bugfixes"),
    "bug_discovery":          ("projects", "bugfixes"),
    # releases
    "release":                ("projects", "releases"),
    "project-release":        ("projects", "releases"),
    # decisions
    "decision":               ("projects", "decisions"),
    "clarification":          ("projects", "decisions"),
    # optimizations
    "optimization":           ("projects", "optimizations"),
    "optimization-complete":  ("projects", "optimizations"),
    "optimization_complete":  ("projects", "optimizations"),
    "performance-optimization": ("projects", "optimizations"),
    "performance_optimization": ("projects", "optimizations"),
    "performance-baseline":   ("projects", "optimizations"),
    "performance_baseline":   ("projects", "optimizations"),
    "profiling_analysis":     ("projects", "optimizations"),
    # commits / code changes
    "code-change":            ("projects", "commits"),
    "code_change":            ("projects", "commits"),
    "commit":                 ("projects", "commits"),
    "git-commit":             ("projects", "commits"),
    "git_commit":             ("projects", "commits"),
    "refactoring":            ("projects", "commits"),
    # features / implementations
    "implementation":         ("projects", "features"),
    "feature":                ("projects", "features"),
    "feature-implementation": ("projects", "features"),
    "feature_implementation": ("projects", "features"),
    "integration_testing":    ("projects", "features"),
    # preferences / identity
    "user-preference":        ("coding", "preferences"),
    "user_preference":        ("coding", "preferences"),
    "preference":             ("coding", "preferences"),
    "user_identity":          ("coding", "preferences"),
    # status
    "project-status":         ("projects", "status"),
    "project_status":         ("projects", "status"),
    "project-progress":       ("projects", "status"),
    "project_progress":       ("projects", "status"),
    "project-context":        ("projects", "status"),
    "project_context":        ("projects", "status"),
    "project-vision":         ("projects", "status"),
    "project-update":         ("projects", "status"),
    "project_update":         ("projects", "status"),
    "project":                ("projects", "status"),
    "planning":               ("projects", "status"),
    "session_recovery":       ("projects", "status"),
    # investigations / debugging
    "investigation":          ("projects", "investigations"),
    "spec-investigation":     ("projects", "investigations"),
    "spec_investigation":     ("projects", "investigations"),
    "debugging":              ("projects", "investigations"),
    "analysis":               ("projects", "investigations"),
    "experiment":             ("projects", "investigations"),
    "technical":              ("projects", "investigations"),
    # lessons / corrections
    "lesson-learned":         ("projects", "lessons"),
    "lesson_learned":         ("projects", "lessons"),
    "correction":             ("projects", "lessons"),
    "verification":           ("projects", "lessons"),
    "pattern":                ("projects", "lessons"),
    "methodology":            ("projects", "lessons"),
    "transformation_guide":   ("projects", "lessons"),
    # workflows / documentation
    "workflow-update":        ("coding", "workflows"),
    "workflow_update":        ("coding", "workflows"),
    "documentation":          ("coding", "workflows"),
    "documentation-milestone": ("coding", "workflows"),
    "documentation_milestone": ("coding", "workflows"),
    "phase1_documentation":   ("coding", "workflows"),
    # testing
    "test":                   ("projects", "features"),
    "test_plan":              ("projects", "features"),
    "test_results":           ("projects", "features"),
    # development (generic catch-alls)
    "development":            ("projects", "milestones"),
    "development_session":    ("projects", "milestones"),
    # notes / feedback (minimal structure, goes to general)
    "note":                   ("projects", "general"),
    "feedback":               ("projects", "general"),
    "writing-style-profile":  ("projects", "general"),
}

FALLBACK_WING = "projects"
FALLBACK_ROOM = "general"


def resolve_wing_room(drawer: dict) -> tuple[str, str]:
    """Determine the correct (wing, room) for a codex-import drawer."""
    meta = drawer["metadata"]

    # Prefer the preserved original type from codex_type metadata
    codex_type = meta.get("codex_type", "").strip().lower()
    if codex_type and codex_type in CODEX_TYPE_MAP:
        return CODEX_TYPE_MAP[codex_type]

    # Fall back to stripping "wing_" from the current wing
    current_wing = meta.get("wing", "").strip()
    if current_wing.startswith("wing_"):
        suffix = current_wing[5:].lower()
        if suffix in CODEX_TYPE_MAP:
            return CODEX_TYPE_MAP[suffix]

    return (FALLBACK_WING, FALLBACK_ROOM)


def make_drawer_id(wing: str, room: str, content: str) -> str:
    """Generate drawer ID in the native Mempalace format."""
    h = hashlib.sha256(f"{wing}{room}{content}".encode()).hexdigest()[:24]
    return f"drawer_{wing}_{room}_{h}"


# ── ChromaDB helpers (shared with convert_memories.py) ─────────────────────────


def _fix_chroma_blob_seq_ids(palace_path: str):
    """Fix ChromaDB 0.6→1.5 migration bug (BLOB → INTEGER seq_ids)."""
    import sqlite3
    db_path = os.path.join(palace_path, "chroma.sqlite3")
    if not os.path.isfile(db_path):
        return
    try:
        with sqlite3.connect(db_path) as conn:
            for table in ("embeddings", "max_seq_id"):
                try:
                    rows = conn.execute(
                        f"SELECT rowid, seq_id FROM {table} WHERE typeof(seq_id) = 'blob'"
                    ).fetchall()
                except sqlite3.OperationalError:
                    continue
                if not rows:
                    continue
                updates = [(int.from_bytes(blob, byteorder="big"), rowid)
                           for rowid, blob in rows]
                conn.executemany(f"UPDATE {table} SET seq_id = ? WHERE rowid = ?", updates)
            conn.commit()
    except Exception as e:
        print(f"[WARN] BLOB seq_id fix failed: {e}", file=sys.stderr)


def get_palace_collection(palace_path: str):
    """Open the MemPalace ChromaDB collection (read-write)."""
    try:
        import chromadb
    except ImportError:
        print("[ERROR] chromadb not installed. Run: pip install chromadb", file=sys.stderr)
        sys.exit(1)

    palace_path = str(Path(palace_path).expanduser().resolve())

    if not Path(palace_path).exists():
        print(f"[ERROR] Palace path does not exist: {palace_path}", file=sys.stderr)
        sys.exit(1)

    db_file = Path(palace_path) / "chroma.sqlite3"
    if not db_file.exists():
        print(f"[ERROR] No MemPalace found at: {palace_path}", file=sys.stderr)
        print("  Initialize first: mempalace init <directory>", file=sys.stderr)
        sys.exit(1)

    _fix_chroma_blob_seq_ids(palace_path)

    client = chromadb.PersistentClient(path=palace_path)
    try:
        collection = client.get_collection("mempalace_drawers")
    except Exception:
        collection = client.get_or_create_collection(
            "mempalace_drawers",
            metadata={"hnsw:space": "cosine"},
        )
    return collection


def fetch_codex_drawers(collection) -> list[dict]:
    """Load all drawers with added_by=codex-import, including embeddings."""
    total = collection.count()
    print(f"  Total drawers in palace: {total}")

    all_drawers: list[dict] = []
    offset = 0
    batch_size = 200

    while offset < total:
        batch = collection.get(
            include=["documents", "metadatas", "embeddings"],
            limit=batch_size,
            offset=offset,
        )
        if not batch["ids"]:
            break

        embeddings = batch.get("embeddings")
        has_embeddings = embeddings is not None and len(embeddings) > 0

        for i, drawer_id in enumerate(batch["ids"]):
            meta = batch["metadatas"][i] if batch["metadatas"] else {}
            if meta.get("added_by") != "codex-import":
                continue
            doc = batch["documents"][i] if batch["documents"] else ""
            emb = list(embeddings[i]) if has_embeddings and i < len(embeddings) and embeddings[i] is not None else []
            all_drawers.append({
                "id": drawer_id,
                "content": doc,
                "metadata": meta,
                "embedding": emb,
            })

        offset += len(batch["ids"])
        print(f"  Scanned: {min(offset, total)}/{total}", end="\r")

    print()
    return all_drawers


# ── Reclassification logic ──────────────────────────────────────────────────────


def reclassify(
    palace_path: str,
    dry_run: bool = False,
    verbose: bool = False,
) -> None:
    """Main reclassification routine."""
    print("\n=== Reclassify codex-import drawers ===")
    print(f"Palace: {palace_path}")
    if dry_run:
        print("[DRY-RUN] No changes will be written.\n")
    else:
        print()

    collection = get_palace_collection(palace_path)

    print("Loading codex-import drawers (with embeddings)...")
    codex_drawers = fetch_codex_drawers(collection)
    print(f"  Found {len(codex_drawers)} codex-import drawers.\n")

    if not codex_drawers:
        print("Nothing to do.")
        return

    # Gather existing IDs so we can detect collisions
    existing_ids_batch = collection.get(include=[])
    existing_ids: set[str] = set(existing_ids_batch.get("ids") or [])

    stats: dict[str, int] = defaultdict(int)
    mapping_counts: dict[tuple[str, str, str, str], int] = defaultdict(int)

    ids_to_delete: list[str] = []
    new_drawers: list[dict] = []

    for drawer in codex_drawers:
        old_wing = drawer["metadata"].get("wing", "")
        old_room = drawer["metadata"].get("room", "")
        new_wing, new_room = resolve_wing_room(drawer)

        new_id = make_drawer_id(new_wing, new_room, drawer["content"])

        # Track mapping statistics
        mapping_counts[(old_wing, old_room, new_wing, new_room)] += 1

        # Unchanged — only add missing metadata fields
        already_correct = (old_wing == new_wing and old_room == new_room)

        # Build updated metadata
        new_meta = dict(drawer["metadata"])
        new_meta["wing"] = new_wing
        new_meta["room"] = new_room
        new_meta.setdefault("normalize_version", 2)
        new_meta.setdefault("hall", "memory")
        new_meta["normalize_version"] = 2  # always ensure up to date
        new_meta["hall"] = "memory"

        if already_correct and drawer["id"] == new_id:
            # Nothing to change except possibly metadata fields that were missing
            meta_needs_update = (
                drawer["metadata"].get("normalize_version") != 2
                or drawer["metadata"].get("hall") != "memory"
            )
            if not meta_needs_update:
                stats["unchanged"] += 1
                if verbose:
                    print(f"  = {drawer['id']} (already correct, no metadata gap)")
                continue

            # Metadata-only update (same ID) — can use collection.update()
            if dry_run:
                print(f"  [DRY-RUN] metadata-update: {drawer['id']}")
            else:
                try:
                    collection.update(
                        ids=[drawer["id"]],
                        metadatas=[new_meta],
                    )
                    stats["metadata_only"] += 1
                    if verbose:
                        print(f"  ~ metadata: {drawer['id']}")
                except Exception as e:
                    print(f"  [ERROR] metadata update failed for {drawer['id']}: {e}",
                          file=sys.stderr)
                    stats["error"] += 1
            if dry_run:
                stats["metadata_only"] += 1
            continue

        # Wing/room changed (or ID mismatch) → delete old + insert new
        if not drawer["embedding"]:
            print(f"  [WARN] No embedding for {drawer['id']} — skipping (cannot re-insert)",
                  file=sys.stderr)
            stats["no_embedding"] += 1
            continue

        if dry_run:
            print(
                f"  [DRY-RUN] reclassify: {drawer['id']}\n"
                f"    {old_wing}/{old_room} → {new_wing}/{new_room}\n"
                f"    new id: {new_id}"
            )
            stats["reclassified"] += 1
            continue

        ids_to_delete.append(drawer["id"])
        new_drawers.append({
            "id": new_id,
            "content": drawer["content"],
            "metadata": new_meta,
            "embedding": drawer["embedding"],
        })

    if dry_run:
        _print_stats(stats, mapping_counts)
        return

    # Apply deletes in batches
    if ids_to_delete:
        batch_size = 100
        for i in range(0, len(ids_to_delete), batch_size):
            batch = ids_to_delete[i:i + batch_size]
            try:
                collection.delete(ids=batch)
            except Exception as e:
                print(f"  [ERROR] delete batch failed: {e}", file=sys.stderr)
                stats["error"] += len(batch)

    # Apply inserts in batches (with embeddings to avoid re-embedding)
    if new_drawers:
        batch_size = 50
        for i in range(0, len(new_drawers), batch_size):
            batch = new_drawers[i:i + batch_size]
            try:
                collection.add(
                    ids=[d["id"] for d in batch],
                    documents=[d["content"] for d in batch],
                    metadatas=[d["metadata"] for d in batch],
                    embeddings=[d["embedding"] for d in batch],
                )
                stats["reclassified"] += len(batch)
                if verbose:
                    for d in batch:
                        old_meta = next(
                            (x["metadata"] for x in codex_drawers if
                             make_drawer_id(
                                 d["metadata"]["wing"], d["metadata"]["room"], d["content"]
                             ) == d["id"]),
                            {}
                        )
                        print(f"  ✓ {d['id']}")
            except Exception as e:
                print(f"  [ERROR] insert batch failed: {e}", file=sys.stderr)
                stats["error"] += len(batch)

        print(f"  Reclassified {stats['reclassified']} drawers "
              f"({len(ids_to_delete)} deleted + re-inserted).")

    _print_stats(stats, mapping_counts)

    if stats["reclassified"] > 0 or stats["metadata_only"] > 0:
        print("\nDone. Run `mempalace repair` to rebuild the vector index if needed.")


def _print_stats(
    stats: dict[str, int],
    mapping_counts: dict[tuple[str, str, str, str], int],
) -> None:
    total = sum(stats.values())
    print(f"\n{'─'*60}")
    print(f"  Total processed:   {total}")
    print(f"  Reclassified:      {stats.get('reclassified', 0)}")
    print(f"  Metadata-only fix: {stats.get('metadata_only', 0)}")
    print(f"  Already correct:   {stats.get('unchanged', 0)}")
    print(f"  No embedding:      {stats.get('no_embedding', 0)}")
    print(f"  Errors:            {stats.get('error', 0)}")
    print(f"{'─'*60}")

    if mapping_counts:
        print("\nWing/room mapping breakdown:")
        # Group by new wing+room for a clean summary
        grouped: dict[tuple[str, str], list[tuple[str, str, int]]] = defaultdict(list)
        for (old_w, old_r, new_w, new_r), count in sorted(mapping_counts.items()):
            grouped[(new_w, new_r)].append((old_w, old_r, count))

        for (new_w, new_r), sources in sorted(grouped.items()):
            total_count = sum(c for _, _, c in sources)
            print(f"\n  → {new_w}/{new_r}  ({total_count} drawers)")
            for old_w, old_r, count in sources:
                marker = "  " if (old_w == new_w and old_r == new_r) else "  ✎"
                print(f"    {marker} {old_w}/{old_r}  ×{count}")


# ── CLI ─────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Reclassify misclassified codex-import drawers in MemPalace ChromaDB.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--palace",
        metavar="PATH",
        default="~/.mempalace/palace",
        help="Path to MemPalace directory (default: ~/.mempalace/palace)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview what would change without writing anything",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print each drawer's old → new mapping",
    )

    args = parser.parse_args()
    palace_path = str(Path(args.palace).expanduser().resolve())

    reclassify(
        palace_path=palace_path,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
