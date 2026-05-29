#!/usr/bin/env python3
"""
Bidirectional conversion script: codex-mcp-memory ↔ mempalace

Both systems use the same embedding model (all-MiniLM-L6-v2, 384-dim),
allowing lossless transfer in both directions.

DIRECTION 1 — codex → mempalace:
  Reads all memories from the PostgreSQL DB (codex-mcp-memory) and writes
  them as drawers into MemPalace (ChromaDB). ChromaDB embeds text automatically
  on insert — no null embeddings, full semantic search.

  Mapping:
    memory.type       → wing  (e.g. "user" → "wing_user", "feedback" → "wing_feedback")
    memory.source     → room  (e.g. "claude-code" → room-slug)
    memory.content    → content (human-readable text with metadata header)
    memory.tags       → in content + codex_tags metadata (for round-trip conversion)
    memory.confidence → in content + codex_confidence metadata
    memory.created_at → filed_at metadata

  Optional: --kg also builds the MemPalace Knowledge Graph.
  Supported wings (structured extraction):
    wing_release           → {project} --[released]--> {version}
    wing_decision          → {project} --[decided]--> {summary}
    wing_milestone         → {project} --[achieved]--> {milestone}
    wing_project-milestone → {project} --[achieved]--> {milestone}
    wing_bug-fix / bugfix  → {project} --[fixed]--> {summary}
    wing_session-summary   → {project} --[session_completed]--> {date}
    wing_project-status    → {project} --[status]--> {status}
    wing_optimization      → {project} --[optimized]--> {summary}

  For --kg: mempalace must be importable. Set PYTHONPATH to the mempalace repo,
  e.g. in your .env file:
    PYTHONPATH=/path/to/mempalace
  Without PYTHONPATH: falls back to direct SQLite access (also works).

DIRECTION 2 — mempalace → codex:
  Reads all drawers from MemPalace (ChromaDB) and writes them including their
  embeddings into the PostgreSQL DB (codex-mcp-memory). Embeddings are read
  directly from ChromaDB and transferred 1:1 — no regeneration needed.

  Mapping:
    drawer.wing      → memory.type   (e.g. "wing_user" → "user")
    drawer.room      → memory.source (prefixed with "mempalace:")
    drawer.content   → memory.content.body (wrapped in JSONB)
    drawer.embedding → memory.embedding (1:1 from ChromaDB, 384-dim)
    drawer.metadata  → memory.tags (wing + room as tags)
    codex_* metadata → restores original tags/confidence if present

REQUIREMENTS:
  uv run --with psycopg2-binary --with chromadb python convert_memories.py ...
  or: pip install psycopg2-binary chromadb

USAGE:
  # codex → mempalace
  python convert_memories.py codex-to-mempalace \\
    --db-url "postgresql://user:pass@localhost:5432/memories" \\
    --palace ~/.mempalace/palace

  # codex → mempalace + build Knowledge Graph
  python convert_memories.py codex-to-mempalace \\
    --db-url "postgresql://user:pass@localhost:5432/memories" \\
    --palace ~/.mempalace/palace \\
    --kg

  # mempalace → codex
  python convert_memories.py mempalace-to-codex \\
    --palace ~/.mempalace/palace \\
    --db-url "postgresql://user:pass@localhost:5432/memories"

  # Dry-run (no writes, preview only)
  python convert_memories.py codex-to-mempalace --dry-run ...

  # Use .env file from codex-mcp-memory
  python convert_memories.py codex-to-mempalace \\
    --env-file /path/to/codex-mcp-memory/.env \\
    --palace ~/.mempalace/palace
"""

import argparse
import json
import os
import re
import sys
import hashlib
from datetime import datetime
from pathlib import Path


# ── Helpers ────────────────────────────────────────────────────────────────────


def slugify(text: str) -> str:
    """Convert arbitrary text into a safe wing/room name."""
    text = str(text).strip().lower()
    text = re.sub(r"[^\w\s.-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = text.strip("-")
    return text[:128] or "unknown"


def type_to_wing(memory_type: str) -> str:
    """Map a codex memory.type to a MemPalace wing name."""
    type_map = {
        "user": "wing_user",
        "feedback": "wing_feedback",
        "project": "wing_project",
        "reference": "wing_reference",
    }
    if memory_type in type_map:
        return type_map[memory_type]
    return f"wing_{slugify(memory_type)}"


def wing_to_type(wing: str) -> str:
    """Map a MemPalace wing name back to a codex memory.type."""
    wing_map = {
        "wing_user": "user",
        "wing_feedback": "feedback",
        "wing_project": "project",
        "wing_reference": "reference",
    }
    if wing in wing_map:
        return wing_map[wing]
    if wing.startswith("wing_"):
        return wing[5:]
    return wing


def source_to_room(source: str) -> str:
    """Map a codex memory.source to a MemPalace room name."""
    if not source:
        return "unknown"
    return slugify(source)


def content_to_text(content, memory_type: str, source: str, tags: list, confidence: float,
                    created_at) -> str:
    """Serialize a codex memory as human-readable text for a MemPalace drawer."""
    lines = ["[CODEX MEMORY]", f"Type: {memory_type}", f"Source: {source}"]
    if tags:
        lines.append(f"Tags: {', '.join(tags)}")
    lines.append(f"Confidence: {confidence}")
    if created_at:
        lines.append(f"Created: {created_at}")
    lines.append("")

    if isinstance(content, dict):
        if "body" in content and len(content) == 1:
            lines.append(str(content["body"]))
        elif "name" in content and "description" in content:
            if "name" in content:
                lines.append(f"Name: {content['name']}")
            if "description" in content:
                lines.append(f"Description: {content['description']}")
            for k, v in content.items():
                if k not in ("name", "description", "type"):
                    lines.append(f"{k}: {v}")
        else:
            lines.append(json.dumps(content, ensure_ascii=False, indent=2))
    else:
        lines.append(str(content))

    return "\n".join(lines)


def text_to_content(drawer_text: str, wing: str, room: str, metadata: dict) -> dict:
    """Parse a MemPalace drawer text back into a codex memory content object."""
    if drawer_text.startswith("[CODEX MEMORY]"):
        lines = drawer_text.split("\n")
        content_start = 0
        for i, line in enumerate(lines):
            if line == "" and i > 0:
                content_start = i + 1
                break
        body_text = "\n".join(lines[content_start:]).strip()
        try:
            return json.loads(body_text)
        except (json.JSONDecodeError, ValueError):
            return {"body": body_text}
    else:
        return {
            "body": drawer_text,
            "wing": wing,
            "room": room,
            "source_file": metadata.get("source_file", ""),
            "added_by": metadata.get("added_by", "mempalace"),
        }


# ── PostgreSQL (codex-mcp-memory) ──────────────────────────────────────────────


def load_env_file(env_path: str) -> str | None:
    """Load DATABASE_URL from a .env file."""
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    val = line[len("DATABASE_URL="):].strip('"').strip("'")
                    return val
    except FileNotFoundError:
        print(f"[WARN] .env file not found: {env_path}", file=sys.stderr)
    return None


def get_db_connection(db_url: str):
    """Create a PostgreSQL connection."""
    try:
        import psycopg2
    except ImportError:
        print("[ERROR] psycopg2 not installed. Run: pip install psycopg2-binary",
              file=sys.stderr)
        sys.exit(1)
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


def fetch_all_codex_memories(conn) -> list[dict]:
    """Load all memories from the codex-mcp-memory PostgreSQL DB."""
    import psycopg2.extras
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, type, content, source, tags, confidence, created_at, updated_at
            FROM memories
            ORDER BY created_at ASC
        """)
        return [dict(row) for row in cur.fetchall()]


def insert_codex_memory_with_embedding(conn, memory: dict, embedding: list[float],
                                        dry_run: bool = False) -> bool:
    """Insert a memory including its embedding into the codex-mcp-memory DB."""
    import psycopg2
    import psycopg2.extras

    content_json = json.dumps(memory["content"], ensure_ascii=False)
    tags = memory.get("tags") or []
    confidence = float(memory.get("confidence") or 0.8)
    source = memory.get("source") or "mempalace-import"
    memory_type = memory.get("type") or "unknown"

    # Content hash for deduplication (identical to codex-mcp-memory's logic)
    def stable_stringify(v):
        if isinstance(v, list):
            return f"[{','.join(stable_stringify(x) for x in v)}]"
        if isinstance(v, dict):
            keys = sorted(k for k in v if v[k] is not None)
            return "{" + ",".join(f'"{k}":{stable_stringify(v[k])}' for k in keys) + "}"
        return json.dumps(v)

    normalized = f"{memory_type}::{source}::{stable_stringify(memory['content'])}"
    content_hash = hashlib.sha256(normalized.encode()).digest()

    embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"

    if dry_run:
        print(f"  [DRY-RUN] Would write: type={memory_type} source={source} "
              f"tags={tags} confidence={confidence} embedding_dims={len(embedding)}")
        return True

    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO memories (type, content, source, embedding, tags, confidence, content_hash)
                VALUES (%s, %s::jsonb, %s, %s::vector, %s, %s, %s)
                ON CONFLICT (content_hash) DO UPDATE
                    SET tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(memories.tags || EXCLUDED.tags))),
                        confidence = GREATEST(memories.confidence, EXCLUDED.confidence),
                        updated_at = NOW()
                RETURNING id
            """, (
                memory_type,
                content_json,
                source,
                embedding_str,
                tags,
                confidence,
                psycopg2.Binary(content_hash),
            ))
            result = cur.fetchone()
            conn.commit()
            return result is not None
    except Exception as e:
        conn.rollback()
        print(f"  [ERROR] DB insert failed: {e}", file=sys.stderr)
        return False


# ── ChromaDB (mempalace) ────────────────────────────────────────────────────────


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


def get_palace_collection(palace_path: str, create: bool = False):
    """Open the MemPalace ChromaDB collection."""
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
    if not db_file.exists() and not create:
        print(f"[ERROR] No MemPalace found at: {palace_path}", file=sys.stderr)
        print("  Initialize first: mempalace init <directory>", file=sys.stderr)
        sys.exit(1)

    _fix_chroma_blob_seq_ids(palace_path)

    client = chromadb.PersistentClient(path=palace_path)
    if create:
        collection = client.get_or_create_collection(
            "mempalace_drawers",
            metadata={"hnsw:space": "cosine"}
        )
    else:
        try:
            collection = client.get_collection("mempalace_drawers")
        except Exception:
            collection = client.get_or_create_collection(
                "mempalace_drawers",
                metadata={"hnsw:space": "cosine"}
            )

    return collection


def fetch_all_drawers_with_embeddings(collection) -> list[dict]:
    """Load all drawers from MemPalace including embeddings (paginated)."""
    total = collection.count()
    print(f"  Found {total} drawers total.")

    all_results = []
    offset = 0
    batch_size = 200  # smaller due to embedding data

    while offset < total:
        batch = collection.get(
            include=["documents", "metadatas", "embeddings"],
            limit=batch_size,
            offset=offset,
        )
        if not batch["ids"]:
            break

        embeddings = batch.get("embeddings") or []

        for i, drawer_id in enumerate(batch["ids"]):
            doc = batch["documents"][i] if batch["documents"] else ""
            meta = batch["metadatas"][i] if batch["metadatas"] else {}
            emb = list(embeddings[i]) if i < len(embeddings) and embeddings[i] is not None else []
            all_results.append({
                "id": drawer_id,
                "content": doc,
                "metadata": meta,
                "embedding": emb,
            })

        offset += len(batch["ids"])
        print(f"  Loaded: {min(offset, total)}/{total}", end="\r")

    print()
    return all_results


def fetch_all_drawers(collection) -> list[dict]:
    """Load all drawers without embeddings (for codex→mempalace where Chroma embeds itself)."""
    total = collection.count()
    print(f"  Found {total} drawers total.")

    all_results = []
    offset = 0
    batch_size = 500

    while offset < total:
        batch = collection.get(
            include=["documents", "metadatas"],
            limit=batch_size,
            offset=offset,
        )
        if not batch["ids"]:
            break

        for i, drawer_id in enumerate(batch["ids"]):
            doc = batch["documents"][i] if batch["documents"] else ""
            meta = batch["metadatas"][i] if batch["metadatas"] else {}
            all_results.append({"id": drawer_id, "content": doc, "metadata": meta})

        offset += len(batch["ids"])
        print(f"  Loaded: {min(offset, total)}/{total}", end="\r")

    print()
    return all_results


def insert_drawer(collection, drawer_id: str, content: str, metadata: dict,
                  dry_run: bool = False) -> bool:
    """Insert a drawer into MemPalace. ChromaDB embeds automatically."""
    if dry_run:
        print(f"  [DRY-RUN] Would write: {drawer_id} "
              f"wing={metadata.get('wing')} room={metadata.get('room')}")
        return True
    try:
        collection.upsert(ids=[drawer_id], documents=[content], metadatas=[metadata])
        return True
    except Exception as e:
        print(f"  [ERROR] Drawer insert failed for {drawer_id}: {e}", file=sys.stderr)
        return False


# ── Knowledge Graph extraction ─────────────────────────────────────────────────


def _kg_extract_triples(mem: dict) -> list[tuple[str, str, str, str | None]]:
    """Extract KG triples from a codex memory.

    Returns a list of (subject, predicate, object, valid_from) tuples.
    valid_from is an ISO date string or None.
    """
    wing = type_to_wing(mem["type"])
    content = mem.get("content") or {}
    created_at = mem.get("created_at")
    valid_from = str(created_at)[:10] if created_at else None

    if not isinstance(content, dict):
        return []

    triples: list[tuple[str, str, str, str | None]] = []

    project = content.get("project") or content.get("repository") or content.get("repo")
    # Fallback: extract from repo: tag
    if not project:
        for tag in (mem.get("tags") or []):
            if tag.startswith("repo:"):
                project = tag[5:]
                break
    if not project:
        return []

    if wing == "wing_release":
        version = content.get("version")
        if version:
            triples.append((project, "released", str(version), valid_from))
        status = content.get("status")
        if status:
            triples.append((project, "release_status", str(status), valid_from))

    elif wing == "wing_decision":
        decision = content.get("decision")
        if decision:
            triples.append((project, "decided", str(decision)[:200], valid_from))
        topic = content.get("topic")
        if topic:
            triples.append((project, "decision_topic", str(topic)[:200], valid_from))

    elif wing in ("wing_milestone", "wing_project-milestone"):
        milestone = content.get("milestone") or content.get("summary")
        if milestone:
            triples.append((project, "achieved", str(milestone)[:200], valid_from))
        status = content.get("status")
        if status:
            triples.append((project, "milestone_status", str(status)[:100], valid_from))

    elif wing in ("wing_bug-fix", "wing_bugfix"):
        summary = content.get("summary") or content.get("description")
        if summary:
            triples.append((project, "fixed", str(summary)[:200], valid_from))

    elif wing == "wing_session-summary":
        date = content.get("date") or valid_from
        if date:
            triples.append((project, "session_completed", str(date), valid_from))
        final_state = content.get("final_state", {})
        if isinstance(final_state, dict):
            version = final_state.get("version")
            if version:
                triples.append((project, "released", str(version), valid_from))
            status = final_state.get("status")
            if status:
                triples.append((project, "status", str(status), valid_from))

    elif wing == "wing_project-status":
        status = content.get("status") or content.get("state")
        if status:
            triples.append((project, "status", str(status)[:100], valid_from))

    elif wing in ("wing_optimization", "wing_optimization-complete"):
        summary = content.get("summary") or content.get("result")
        if summary:
            triples.append((project, "optimized", str(summary)[:200], valid_from))

    return triples


def build_kg_from_memories(memories: list[dict], palace_path: str, dry_run: bool = False):
    """Build the MemPalace Knowledge Graph from migrated codex memories.

    The KG lives at ~/.mempalace/knowledge_graph.sqlite3 (one level above palace/).

    For the native mempalace import, set PYTHONPATH to the mempalace repo,
    e.g. in your .env file: PYTHONPATH=/path/to/mempalace
    Without PYTHONPATH: falls back to direct SQLite access (also works).
    """
    # KG lives directly in ~/.mempalace/, not in the palace/ subdirectory
    kg_path = str(Path(palace_path).parent / "knowledge_graph.sqlite3")

    # Load mempalace repo from PYTHONPATH env var (recommended for uv workflows)
    mempalace_path = os.environ.get("PYTHONPATH")
    if mempalace_path:
        sys.path.insert(0, str(Path(mempalace_path).expanduser().resolve()))

    try:
        from mempalace.knowledge_graph import KnowledgeGraph
    except ImportError:
        if not mempalace_path:
            print("  [WARN] mempalace not found. Set PYTHONPATH for native import.",
                  file=sys.stderr)
            print("         Falling back to direct SQLite access.", file=sys.stderr)
        _build_kg_sqlite(memories, kg_path, dry_run)
        return

    kg = KnowledgeGraph(db_path=kg_path)

    stats = {"ok": 0, "skip": 0, "error": 0}
    seen: set[tuple] = set()

    for mem in memories:
        triples = _kg_extract_triples(mem)
        for subject, predicate, obj, valid_from in triples:
            key = (subject.lower(), predicate, obj.lower())
            if key in seen:
                stats["skip"] += 1
                continue
            seen.add(key)

            if dry_run:
                print(f"  [DRY-RUN] KG: {subject!r} --[{predicate}]--> {obj!r}"
                      f"  (valid_from={valid_from})")
                stats["ok"] += 1
                continue

            try:
                kg.add_triple(subject, predicate, obj, valid_from=valid_from)
                stats["ok"] += 1
            except Exception as e:
                print(f"  [ERROR] KG triple failed: {subject} {predicate} {obj}: {e}",
                      file=sys.stderr)
                stats["error"] += 1

    print(f"\nKG: {stats['ok']} triples written, {stats['skip']} duplicates skipped, "
          f"{stats['error']} errors")


def _build_kg_sqlite(memories: list[dict], kg_path: str, dry_run: bool = False):
    """Fallback: write KG directly via SQLite (without mempalace import)."""
    import sqlite3

    if dry_run:
        print(f"  [DRY-RUN] Would write KG to: {kg_path}")

    # Ensure schema matches mempalace/knowledge_graph.py
    if not dry_run:
        with sqlite3.connect(kg_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS triples (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subject TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    object TEXT NOT NULL,
                    valid_from TEXT,
                    valid_to TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_subject ON triples(subject)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_predicate ON triples(predicate)")
            conn.commit()

    stats = {"ok": 0, "skip": 0, "error": 0}
    seen: set[tuple] = set()
    rows = []

    for mem in memories:
        triples = _kg_extract_triples(mem)
        for subject, predicate, obj, valid_from in triples:
            key = (subject.lower(), predicate, obj.lower())
            if key in seen:
                stats["skip"] += 1
                continue
            seen.add(key)

            if dry_run:
                print(f"  [DRY-RUN] KG: {subject!r} --[{predicate}]--> {obj!r}"
                      f"  (valid_from={valid_from})")
                stats["ok"] += 1
                continue

            rows.append((subject, predicate, obj, valid_from))

    if rows and not dry_run:
        try:
            with sqlite3.connect(kg_path) as conn:
                conn.executemany(
                    "INSERT INTO triples (subject, predicate, object, valid_from) "
                    "VALUES (?, ?, ?, ?)",
                    rows,
                )
                conn.commit()
            stats["ok"] = len(rows)
        except Exception as e:
            print(f"  [ERROR] KG SQLite insert failed: {e}", file=sys.stderr)
            stats["error"] = len(rows)

    print(f"\nKG: {stats['ok']} triples written, {stats['skip']} duplicates skipped, "
          f"{stats['error']} errors")


# ── Direction 1: codex → mempalace ─────────────────────────────────────────────


def convert_codex_to_mempalace(db_url: str, palace_path: str, dry_run: bool = False,
                                skip_existing: bool = True, build_kg: bool = False):
    """Export all memories from codex-mcp-memory to MemPalace.

    ChromaDB embeds text automatically on insert using all-MiniLM-L6-v2
    (same model as codex-mcp-memory) — full semantic search without extra steps.

    With --kg: additionally extracts KG triples from structured memories
    (wing_release, wing_decision, wing_milestone, etc.) and writes them into
    the MemPalace Knowledge Graph (knowledge_graph.sqlite3).
    """
    print("\n=== codex-mcp-memory → MemPalace ===")
    print(f"Source: PostgreSQL ({db_url[:50]}...)")
    print(f"Target: {palace_path}")
    if build_kg:
        print("KG:     enabled (wing_release, wing_decision, wing_milestone, ...)")
    if dry_run:
        print("[DRY-RUN] No changes will be written.\n")

    conn = get_db_connection(db_url)
    collection = get_palace_collection(palace_path, create=True)

    existing_ids: set[str] = set()
    if skip_existing and not dry_run:
        existing_batch = collection.get(include=[])
        existing_ids = set(existing_batch.get("ids") or [])
        print(f"  {len(existing_ids)} existing drawers will be skipped.")

    print("\nLoading memories from PostgreSQL...")
    memories = fetch_all_codex_memories(conn)
    print(f"  {len(memories)} memories found.\n")

    stats = {"ok": 0, "skip": 0, "error": 0}

    for mem in memories:
        wing = type_to_wing(mem["type"])
        room = source_to_room(mem["source"])

        content_text = content_to_text(
            mem["content"], mem["type"], mem["source"],
            mem.get("tags") or [], mem.get("confidence"), mem.get("created_at"),
        )

        drawer_id = (
            f"drawer_{wing}_{room}_"
            f"{hashlib.sha256((wing + room + content_text).encode()).hexdigest()[:24]}"
        )

        if skip_existing and drawer_id in existing_ids:
            stats["skip"] += 1
            continue

        metadata = {
            "wing": wing,
            "room": room,
            "source_file": "",
            "chunk_index": 0,
            "added_by": "codex-import",
            "filed_at": str(mem.get("created_at") or datetime.now().isoformat()),
            # Preserve original codex metadata (enables lossless round-trip)
            "codex_id": str(mem["id"]),
            "codex_type": str(mem["type"]),
            "codex_source": str(mem.get("source") or ""),
            "codex_confidence": str(mem.get("confidence") or 0.8),
            "codex_tags": ",".join(mem.get("tags") or []),
        }

        ok = insert_drawer(collection, drawer_id, content_text, metadata, dry_run=dry_run)
        if ok:
            stats["ok"] += 1
            if not dry_run:
                print(f"  ✓ {wing}/{room} [{mem['type']}]")
        else:
            stats["error"] += 1

    conn.close()

    print(f"\nDone: {stats['ok']} imported, {stats['skip']} skipped, {stats['error']} errors")
    if not dry_run and stats["ok"] > 0:
        print("\nNote: ChromaDB embedded all drawers automatically (all-MiniLM-L6-v2).")
        print("For the closet index: mempalace mine <palace_path>")

    if build_kg:
        print("\n=== Knowledge Graph build ===")
        build_kg_from_memories(memories, palace_path, dry_run=dry_run)


# ── Direction 2: mempalace → codex ─────────────────────────────────────────────


def convert_mempalace_to_codex(palace_path: str, db_url: str, dry_run: bool = False,
                                skip_existing: bool = True,
                                only_wing: str = None, only_room: str = None):
    """Export all drawers from MemPalace to codex-mcp-memory.

    Embeddings are read directly from ChromaDB and transferred 1:1 into Postgres
    — no loss, no regeneration needed. Both systems use all-MiniLM-L6-v2 (384-dim),
    the vectors are compatible.
    """
    print("\n=== MemPalace → codex-mcp-memory ===")
    print(f"Source: {palace_path}")
    print(f"Target: PostgreSQL ({db_url[:50]}...)")
    if only_wing:
        print(f"Filter: wing={only_wing}")
    if only_room:
        print(f"Filter: room={only_room}")
    if dry_run:
        print("[DRY-RUN] No changes will be written.\n")

    collection = get_palace_collection(palace_path)
    conn = get_db_connection(db_url)

    existing_sources: set[str] = set()
    if skip_existing and not dry_run:
        import psycopg2.extras
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT source FROM memories WHERE source LIKE 'mempalace:%'")
            for row in cur.fetchall():
                existing_sources.add(row["source"])
        print(f"  {len(existing_sources)} already imported drawers will be skipped.")

    print("\nLoading drawers from MemPalace (including embeddings)...")
    drawers = fetch_all_drawers_with_embeddings(collection)
    print(f"  {len(drawers)} drawers loaded.\n")

    stats = {"ok": 0, "skip": 0, "error": 0, "no_embedding": 0}

    for drawer in drawers:
        meta = drawer["metadata"]
        wing = meta.get("wing", "unknown")
        room = meta.get("room", "unknown")

        if only_wing and wing != only_wing:
            stats["skip"] += 1
            continue
        if only_room and room != only_room:
            stats["skip"] += 1
            continue

        source = f"mempalace:{drawer['id']}"

        if skip_existing and source in existing_sources:
            stats["skip"] += 1
            continue

        embedding = drawer.get("embedding") or []
        if not embedding:
            print(f"  [WARN] No embedding for {drawer['id']} — skipped", file=sys.stderr)
            stats["no_embedding"] += 1
            continue
        if len(embedding) != 384:
            print(f"  [WARN] Unexpected embedding dimension {len(embedding)} for {drawer['id']}",
                  file=sys.stderr)
            stats["no_embedding"] += 1
            continue

        memory_type = wing_to_type(wing)
        content = text_to_content(drawer["content"], wing, room, meta)

        # Tags: wing + room + original codex tags if present
        tags = [f"wing:{wing}", f"room:{room}"]
        if meta.get("codex_tags"):
            original_tags = [t.strip() for t in meta["codex_tags"].split(",") if t.strip()]
            tags.extend(original_tags)
        # Normalize tags: only [a-z0-9:_-] (codex-mcp-memory validator)
        tags = [re.sub(r"[^a-z0-9:_\-]", "-", t.lower())[:100] for t in tags]
        tags = list(dict.fromkeys(tags))

        try:
            confidence = float(meta.get("codex_confidence") or 0.8)
        except (ValueError, TypeError):
            confidence = 0.8

        memory = {
            "type": memory_type,
            "content": content,
            "source": source,
            "tags": tags,
            "confidence": confidence,
        }

        ok = insert_codex_memory_with_embedding(conn, memory, embedding, dry_run=dry_run)
        if ok:
            stats["ok"] += 1
            if not dry_run:
                print(f"  ✓ {wing}/{room} → type={memory_type} ({len(embedding)}-dim embedding)")
        else:
            stats["error"] += 1

    conn.close()

    print(f"\nDone: {stats['ok']} imported, {stats['skip']} skipped, "
          f"{stats['error']} errors, {stats['no_embedding']} without embedding")
    if not dry_run and stats["ok"] > 0:
        print("\nEmbeddings transferred 1:1 from ChromaDB (all-MiniLM-L6-v2, 384-dim).")
        print("All imported memories are immediately searchable via semantic search.")


# ── CLI ────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Bidirectional conversion script: codex-mcp-memory ↔ mempalace",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # ── codex → mempalace ──
    p_c2m = subparsers.add_parser(
        "codex-to-mempalace",
        help="Import memories from codex-mcp-memory into MemPalace",
    )
    p_c2m.add_argument("--db-url", metavar="URL",
                        help="PostgreSQL connection string")
    p_c2m.add_argument("--env-file", metavar="PATH",
                        help="Path to .env file (reads DATABASE_URL)",
                        default="./codex-mcp-memory/.env")
    p_c2m.add_argument("--palace", metavar="PATH", required=True,
                        help="Path to MemPalace directory")
    p_c2m.add_argument("--dry-run", action="store_true",
                        help="Do not write anything, only preview what would happen")
    p_c2m.add_argument("--no-skip-existing", action="store_true",
                        help="Overwrite already existing drawers")
    p_c2m.add_argument("--kg", action="store_true",
                        help="Build Knowledge Graph from structured memories "
                             "(wing_release, wing_decision, wing_milestone, ...)")

    # ── mempalace → codex ──
    p_m2c = subparsers.add_parser(
        "mempalace-to-codex",
        help="Import drawers from MemPalace into codex-mcp-memory",
    )
    p_m2c.add_argument("--palace", metavar="PATH", required=True,
                        help="Path to MemPalace directory")
    p_m2c.add_argument("--db-url", metavar="URL",
                        help="PostgreSQL connection string")
    p_m2c.add_argument("--env-file", metavar="PATH",
                        help="Path to .env file (reads DATABASE_URL)",
                        default="./codex-mcp-memory/.env")
    p_m2c.add_argument("--dry-run", action="store_true",
                        help="Do not write anything, only preview what would happen")
    p_m2c.add_argument("--no-skip-existing", action="store_true",
                        help="Re-import already imported drawers")
    p_m2c.add_argument("--wing", metavar="NAME",
                        help="Only import drawers from this wing")
    p_m2c.add_argument("--room", metavar="NAME",
                        help="Only import drawers from this room")

    args = parser.parse_args()

    # Resolve DATABASE_URL: explicit argument > .env file > environment variable
    db_url = args.db_url
    if not db_url:
        db_url = load_env_file(args.env_file)
    if not db_url:
        db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("[ERROR] DATABASE_URL not found. Provide --db-url or --env-file.",
              file=sys.stderr)
        sys.exit(1)

    palace_path = str(Path(args.palace).expanduser().resolve())

    if args.command == "codex-to-mempalace":
        convert_codex_to_mempalace(
            db_url=db_url,
            palace_path=palace_path,
            dry_run=args.dry_run,
            skip_existing=not args.no_skip_existing,
            build_kg=args.kg,
        )
    elif args.command == "mempalace-to-codex":
        convert_mempalace_to_codex(
            palace_path=palace_path,
            db_url=db_url,
            dry_run=args.dry_run,
            skip_existing=not args.no_skip_existing,
            only_wing=getattr(args, "wing", None),
            only_room=getattr(args, "room", None),
        )


if __name__ == "__main__":
    main()
