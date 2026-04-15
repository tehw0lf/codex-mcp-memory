#!/usr/bin/env python3
"""
Bidirektionales Konvertierungsskript: codex-mcp-memory ↔ mempalace

Beide Systeme nutzen dasselbe Embedding-Modell (all-MiniLM-L6-v2, 384-dim),
weshalb ein verlustfreier Transfer möglich ist:

RICHTUNG 1 — codex → mempalace:
  Liest alle Memories aus der PostgreSQL-DB (codex-mcp-memory) und schreibt
  sie als Drawers in den MemPalace (ChromaDB). ChromaDB embedded den Text
  automatisch beim Einfügen — keine Null-Embeddings, volle Suchbarkeit.

  Mapping:
    memory.type      → wing  (z.B. "user" → "wing_user", "feedback" → "wing_feedback")
    memory.source    → room  (z.B. "claude-code" → room-slug)
    memory.content   → content (lesbarer Text mit Metadaten-Header)
    memory.tags      → in content + in codex_tags Metadaten (für Rückkonvertierung)
    memory.confidence→ in content + in codex_confidence Metadaten
    memory.created_at→ filed_at Metadatum

RICHTUNG 2 — mempalace → codex:
  Liest alle Drawers aus dem MemPalace (ChromaDB) und schreibt sie inkl.
  ihrer Embeddings in die PostgreSQL-DB (codex-mcp-memory). Die Embeddings
  werden direkt aus ChromaDB gelesen und 1:1 übertragen — keine Neugenerierung.

  Mapping:
    drawer.wing      → memory.type  (z.B. "wing_user" → "user")
    drawer.room      → memory.source (mit "mempalace:" Präfix)
    drawer.content   → memory.content.body (in JSONB eingewickelt)
    drawer.embedding → memory.embedding (1:1 aus ChromaDB, 384-dim)
    drawer.metadata  → memory.tags (wing + room als Tags)
    codex_* Metadaten → Original-Tags/Konfidenz wiederherstellen falls vorhanden

VORAUSSETZUNGEN:
  - Python 3.11+
  - pip install psycopg2-binary chromadb

USAGE:
  # codex → mempalace
  python convert_memories.py codex-to-mempalace \\
    --db-url "postgresql://user:pass@localhost:5432/memories" \\
    --palace ~/.mempalace/palace

  # mempalace → codex
  python convert_memories.py mempalace-to-codex \\
    --palace ~/.mempalace/palace \\
    --db-url "postgresql://user:pass@localhost:5432/memories"

  # Dry-run (kein Schreiben, nur Vorschau)
  python convert_memories.py codex-to-mempalace --dry-run ...

  # .env Datei aus codex-mcp-memory verwenden
  python convert_memories.py codex-to-mempalace \\
    --env-file /pfad/zu/codex-mcp-memory/.env \\
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


# ── Hilfsfunktionen ────────────────────────────────────────────────────────────


def slugify(text: str) -> str:
    """Wandle beliebigen Text in einen sicheren wing/room-Namen um."""
    text = str(text).strip().lower()
    text = re.sub(r"[^\w\s.-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = text.strip("-")
    return text[:128] or "unknown"


def type_to_wing(memory_type: str) -> str:
    """Mappe codex memory.type auf einen MemPalace wing-Namen."""
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
    """Mappe einen MemPalace wing-Namen zurück auf einen codex memory.type."""
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
    """Mappe codex memory.source auf einen MemPalace room-Namen."""
    if not source:
        return "unknown"
    return slugify(source)


def content_to_text(content, memory_type: str, source: str, tags: list, confidence: float,
                    created_at) -> str:
    """Serialisiere ein codex-Memory als lesbaren Text für einen MemPalace-Drawer."""
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
    """Parse einen MemPalace-Drawer-Text zurück in ein codex-Memory-Content-Objekt."""
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
    """Lade DATABASE_URL aus einer .env Datei."""
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    val = line[len("DATABASE_URL="):].strip('"').strip("'")
                    return val
    except FileNotFoundError:
        print(f"[WARN] .env Datei nicht gefunden: {env_path}", file=sys.stderr)
    return None


def get_db_connection(db_url: str):
    """Erstelle eine PostgreSQL-Verbindung."""
    try:
        import psycopg2
    except ImportError:
        print("[ERROR] psycopg2 nicht installiert. Bitte: pip install psycopg2-binary",
              file=sys.stderr)
        sys.exit(1)
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


def fetch_all_codex_memories(conn) -> list[dict]:
    """Lade alle Memories aus der codex-mcp-memory PostgreSQL-DB."""
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
    """Füge ein Memory inkl. Embedding in die codex-mcp-memory DB ein."""
    import psycopg2
    import psycopg2.extras

    content_json = json.dumps(memory["content"], ensure_ascii=False)
    tags = memory.get("tags") or []
    confidence = float(memory.get("confidence") or 0.8)
    source = memory.get("source") or "mempalace-import"
    memory_type = memory.get("type") or "unknown"

    # Content-Hash für Deduplication (identisch zu codex-mcp-memory's Logik)
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
        print(f"  [DRY-RUN] Würde schreiben: type={memory_type} source={source} "
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
        print(f"  [ERROR] DB-Insert fehlgeschlagen: {e}", file=sys.stderr)
        return False


# ── ChromaDB (mempalace) ────────────────────────────────────────────────────────


def _fix_chroma_blob_seq_ids(palace_path: str):
    """Behebt ChromaDB 0.6→1.5 Migrationsfehler (BLOB → INTEGER seq_ids)."""
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
        print(f"[WARN] BLOB seq_id Fix fehlgeschlagen: {e}", file=sys.stderr)


def get_palace_collection(palace_path: str, create: bool = False):
    """Öffne die MemPalace ChromaDB-Collection."""
    try:
        import chromadb
    except ImportError:
        print("[ERROR] chromadb nicht installiert. Bitte: pip install chromadb", file=sys.stderr)
        sys.exit(1)

    palace_path = str(Path(palace_path).expanduser().resolve())

    if not Path(palace_path).exists():
        print(f"[ERROR] Palace-Pfad existiert nicht: {palace_path}", file=sys.stderr)
        sys.exit(1)

    db_file = Path(palace_path) / "chroma.sqlite3"
    if not db_file.exists() and not create:
        print(f"[ERROR] Kein MemPalace gefunden unter: {palace_path}", file=sys.stderr)
        print("  Initialisiere zuerst: mempalace init <verzeichnis>", file=sys.stderr)
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
    """Lade alle Drawers aus dem MemPalace inkl. Embeddings (paginiert)."""
    total = collection.count()
    print(f"  Gesamt {total} Drawers gefunden.")

    all_results = []
    offset = 0
    batch_size = 200  # kleiner wegen Embedding-Daten

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
        print(f"  Geladen: {min(offset, total)}/{total}", end="\r")

    print()
    return all_results


def fetch_all_drawers(collection) -> list[dict]:
    """Lade alle Drawers ohne Embeddings (für codex→mempalace, wo Chroma selbst embedded)."""
    total = collection.count()
    print(f"  Gesamt {total} Drawers gefunden.")

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
        print(f"  Geladen: {min(offset, total)}/{total}", end="\r")

    print()
    return all_results


def insert_drawer(collection, drawer_id: str, content: str, metadata: dict,
                  dry_run: bool = False) -> bool:
    """Füge einen Drawer in den MemPalace ein. ChromaDB embedded automatisch."""
    if dry_run:
        print(f"  [DRY-RUN] Würde schreiben: {drawer_id} "
              f"wing={metadata.get('wing')} room={metadata.get('room')}")
        return True
    try:
        collection.upsert(ids=[drawer_id], documents=[content], metadatas=[metadata])
        return True
    except Exception as e:
        print(f"  [ERROR] Drawer-Insert fehlgeschlagen für {drawer_id}: {e}", file=sys.stderr)
        return False


# ── Konvertierung: codex → mempalace ───────────────────────────────────────────


def convert_codex_to_mempalace(db_url: str, palace_path: str, dry_run: bool = False,
                                skip_existing: bool = True):
    """Exportiere alle Memories aus codex-mcp-memory nach MemPalace.

    ChromaDB embedded den Text beim Einfügen automatisch mit all-MiniLM-L6-v2
    (dasselbe Modell wie codex-mcp-memory) — volle Suchbarkeit ohne Umwege.
    """
    print("\n=== codex-mcp-memory → MemPalace ===")
    print(f"Quelle: PostgreSQL ({db_url[:50]}...)")
    print(f"Ziel:   {palace_path}")
    if dry_run:
        print("[DRY-RUN] Keine Änderungen werden geschrieben.\n")

    conn = get_db_connection(db_url)
    collection = get_palace_collection(palace_path, create=True)

    existing_ids: set[str] = set()
    if skip_existing and not dry_run:
        existing_batch = collection.get(include=[])
        existing_ids = set(existing_batch.get("ids") or [])
        print(f"  {len(existing_ids)} bereits vorhandene Drawers werden übersprungen.")

    print("\nLade Memories aus PostgreSQL...")
    memories = fetch_all_codex_memories(conn)
    print(f"  {len(memories)} Memories gefunden.\n")

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
            # Originale codex-Metadaten erhalten (ermöglicht verlustfreie Rückkonvertierung)
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

    print(f"\nFertig: {stats['ok']} importiert, {stats['skip']} übersprungen, "
          f"{stats['error']} Fehler")
    if not dry_run and stats["ok"] > 0:
        print("\nHinweis: ChromaDB hat alle Drawers automatisch embedded (all-MiniLM-L6-v2).")
        print("Für den Closet-Index: mempalace mine <palace_path> ausführen.")


# ── Konvertierung: mempalace → codex ───────────────────────────────────────────


def convert_mempalace_to_codex(palace_path: str, db_url: str, dry_run: bool = False,
                                skip_existing: bool = True,
                                only_wing: str = None, only_room: str = None):
    """Exportiere alle Drawers aus MemPalace nach codex-mcp-memory.

    Die Embeddings werden direkt aus ChromaDB gelesen und 1:1 in Postgres
    geschrieben — kein Verlust, keine Neugenerierung nötig. Beide Systeme
    nutzen all-MiniLM-L6-v2 (384-dim), die Vektoren sind kompatibel.
    """
    print("\n=== MemPalace → codex-mcp-memory ===")
    print(f"Quelle: {palace_path}")
    print(f"Ziel:   PostgreSQL ({db_url[:50]}...)")
    if only_wing:
        print(f"Filter: wing={only_wing}")
    if only_room:
        print(f"Filter: room={only_room}")
    if dry_run:
        print("[DRY-RUN] Keine Änderungen werden geschrieben.\n")

    collection = get_palace_collection(palace_path)
    conn = get_db_connection(db_url)

    existing_sources: set[str] = set()
    if skip_existing and not dry_run:
        import psycopg2.extras
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT source FROM memories WHERE source LIKE 'mempalace:%'")
            for row in cur.fetchall():
                existing_sources.add(row["source"])
        print(f"  {len(existing_sources)} bereits importierte Drawers werden übersprungen.")

    print("\nLade Drawers aus MemPalace (inkl. Embeddings)...")
    drawers = fetch_all_drawers_with_embeddings(collection)
    print(f"  {len(drawers)} Drawers geladen.\n")

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
            print(f"  [WARN] Kein Embedding für {drawer['id']} — übersprungen", file=sys.stderr)
            stats["no_embedding"] += 1
            continue
        if len(embedding) != 384:
            print(f"  [WARN] Unerwartete Embedding-Dimension {len(embedding)} für {drawer['id']}",
                  file=sys.stderr)
            stats["no_embedding"] += 1
            continue

        memory_type = wing_to_type(wing)
        content = text_to_content(drawer["content"], wing, room, meta)

        # Tags: wing + room + originale codex-Tags falls vorhanden
        tags = [f"wing:{wing}", f"room:{room}"]
        if meta.get("codex_tags"):
            original_tags = [t.strip() for t in meta["codex_tags"].split(",") if t.strip()]
            tags.extend(original_tags)
        # Tags normalisieren: nur [a-z0-9:_-] (codex-mcp-memory Validator)
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

    print(f"\nFertig: {stats['ok']} importiert, {stats['skip']} übersprungen, "
          f"{stats['error']} Fehler, {stats['no_embedding']} ohne Embedding")
    if not dry_run and stats["ok"] > 0:
        print("\nEmbeddings wurden 1:1 aus ChromaDB übertragen (all-MiniLM-L6-v2, 384-dim).")
        print("Alle importierten Memories sind sofort über Semantik-Suche auffindbar.")


# ── CLI ────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Bidirektionales Konvertierungsskript: codex-mcp-memory ↔ mempalace",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # ── codex → mempalace ──
    p_c2m = subparsers.add_parser(
        "codex-to-mempalace",
        help="Importiere Memories aus codex-mcp-memory nach MemPalace",
    )
    p_c2m.add_argument("--db-url", metavar="URL",
                        help="PostgreSQL Connection String")
    p_c2m.add_argument("--env-file", metavar="PATH",
                        help="Pfad zur .env Datei (liest DATABASE_URL)",
                        default="./codex-mcp-memory/.env")
    p_c2m.add_argument("--palace", metavar="PATH", required=True,
                        help="Pfad zum MemPalace-Verzeichnis")
    p_c2m.add_argument("--dry-run", action="store_true",
                        help="Nichts schreiben, nur anzeigen was passieren würde")
    p_c2m.add_argument("--no-skip-existing", action="store_true",
                        help="Bereits vorhandene Drawers überschreiben")

    # ── mempalace → codex ──
    p_m2c = subparsers.add_parser(
        "mempalace-to-codex",
        help="Importiere Drawers aus MemPalace nach codex-mcp-memory",
    )
    p_m2c.add_argument("--palace", metavar="PATH", required=True,
                        help="Pfad zum MemPalace-Verzeichnis")
    p_m2c.add_argument("--db-url", metavar="URL",
                        help="PostgreSQL Connection String")
    p_m2c.add_argument("--env-file", metavar="PATH",
                        help="Pfad zur .env Datei (liest DATABASE_URL)",
                        default="./codex-mcp-memory/.env")
    p_m2c.add_argument("--dry-run", action="store_true",
                        help="Nichts schreiben, nur anzeigen was passieren würde")
    p_m2c.add_argument("--no-skip-existing", action="store_true",
                        help="Bereits importierte Drawers erneut importieren")
    p_m2c.add_argument("--wing", metavar="NAME",
                        help="Nur Drawers aus diesem Wing importieren")
    p_m2c.add_argument("--room", metavar="NAME",
                        help="Nur Drawers aus diesem Room importieren")

    args = parser.parse_args()

    # DATABASE_URL auflösen: explizites Argument > .env Datei > Umgebungsvariable
    db_url = args.db_url
    if not db_url:
        db_url = load_env_file(args.env_file)
    if not db_url:
        db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("[ERROR] DATABASE_URL nicht gefunden. Entweder --db-url angeben oder "
              "--env-file setzen.", file=sys.stderr)
        sys.exit(1)

    palace_path = str(Path(args.palace).expanduser().resolve())

    if args.command == "codex-to-mempalace":
        convert_codex_to_mempalace(
            db_url=db_url,
            palace_path=palace_path,
            dry_run=args.dry_run,
            skip_existing=not args.no_skip_existing,
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
