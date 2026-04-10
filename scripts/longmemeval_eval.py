#!/usr/bin/env python3
"""
LongMemEval R@5 Benchmark for codex-mcp-memory
================================================
Evaluates the MCP memory server against the LongMemEval benchmark (ICLR 2025).

Dataset schema (verified against run_retrieval.py):
  Each item has:
    question_id, question_type, question, answer, question_date,
    haystack_session_ids  – list of session ID strings
    haystack_dates        – list of timestamps
    haystack_sessions     – list of sessions; each session is a list of turns:
                            {"role": "user"|"assistant", "content": "...",
                             "has_answer": true|false}   (has_answer on user turns only)
    answer_session_ids    – list of session IDs that contain the evidence

Embedding model: sentence-transformers/all-MiniLM-L6-v2
  (identical weights to Xenova/all-MiniLM-L6-v2 used by the MCP server)

Usage:
  # Full benchmark (download dataset first – see README)
  DATABASE_URL=postgres://... python scripts/longmemeval_eval.py \\
    --dataset data/longmemeval_s.json

  # Skip ingestion if already loaded
  DATABASE_URL=postgres://... python scripts/longmemeval_eval.py \\
    --dataset data/longmemeval_s.json --skip-ingestion

  # Quick smoke test (first 20 questions)
  DATABASE_URL=postgres://... python scripts/longmemeval_eval.py \\
    --dataset data/longmemeval_s.json --limit 20

  # With OpenAI QA evaluation (Phase 3)
  DATABASE_URL=postgres://... OPENAI_API_KEY=sk-... python scripts/longmemeval_eval.py \\
    --dataset data/longmemeval_s.json --qa-eval

  # Cleanup benchmark memories
  DATABASE_URL=postgres://... python scripts/longmemeval_eval.py --cleanup
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras
from sentence_transformers import SentenceTransformer

# ── Constants ────────────────────────────────────────────────────────────────

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
SEARCH_TOP_K = 5
BENCHMARK_TAG = "longmemeval"
MEMORY_TYPE = "longmemeval-turn"
SOURCE = "longmemeval-benchmark"
MAX_CONTENT_CHARS = 9000   # leave headroom below server's 10 000-char limit
MAX_TAGS = 20
TAG_RE = re.compile(r"^[a-z0-9:._/-]{1,100}$")

RESULTS_DIR = Path(__file__).parent.parent / "results"
RESULTS_FILE = RESULTS_DIR / "longmemeval_results.json"
QA_OUTPUT_FILE = RESULTS_DIR / "longmemeval_qa_output.jsonl"

# Comparison baselines (from the paper / public leaderboard)
BASELINES = {
    "MemPalace (verbatim + ChromaDB)": 96.6,
    "Mem0": 85.0,
    "Zep": 82.0,
    "Naive RAG": 52.0,
}

# ── Helpers ──────────────────────────────────────────────────────────────────


def stable_stringify_deep(obj):
    """Deterministic JSON serialisation matching the server's stableStringifyDeep."""
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float)):
        return json.dumps(obj)
    if isinstance(obj, str):
        return json.dumps(obj)
    if isinstance(obj, list):
        return "[" + ",".join(stable_stringify_deep(v) for v in obj) + "]"
    if isinstance(obj, dict):
        sorted_pairs = sorted(
            ((k, v) for k, v in obj.items() if v is not None),
            key=lambda x: x[0],
        )
        inner = ",".join(
            f"{json.dumps(k)}:{stable_stringify_deep(v)}" for k, v in sorted_pairs
        )
        return "{" + inner + "}"
    return json.dumps(obj)


def compute_content_hash(memory_type: str, source: str, content: dict) -> bytes:
    """Replicates the server's computeContentHash logic."""
    raw = f"{memory_type}::{source}::{stable_stringify_deep(content)}"
    return hashlib.sha256(raw.encode()).digest()


def normalize_tag(tag: str) -> str:
    """Lowercase and sanitise a tag to match server TAG_RE ^[a-z0-9:._/-]{1,100}$."""
    tag = tag.lower().strip()
    tag = re.sub(r"[^a-z0-9:._/\-]", "-", tag)
    tag = re.sub(r"-{2,}", "-", tag)
    return tag[:100]


def truncate_text(text: str, max_chars: int = MAX_CONTENT_CHARS) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "…"


# ── Database helpers ─────────────────────────────────────────────────────────


def get_connection(database_url: str):
    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    psycopg2.extras.register_uuid(conn)
    return conn


def ensure_vector_extension(conn):
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
    conn.commit()


def upsert_memory_direct(cur, embedding: list, memory_type: str, content: dict,
                          source: str, tags: list, confidence: float) -> str:
    """Insert memory directly into PostgreSQL, replicating server upsert logic."""
    c_hash = compute_content_hash(memory_type, source, content)
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    sql = """
        INSERT INTO memories (type, content, source, embedding, tags, confidence, content_hash)
        VALUES (%s, %s::jsonb, %s, %s::vector, %s, %s, %s)
        ON CONFLICT (content_hash) DO UPDATE
            SET tags = (SELECT ARRAY(SELECT DISTINCT UNNEST(memories.tags || EXCLUDED.tags))),
                confidence = GREATEST(memories.confidence, EXCLUDED.confidence),
                updated_at = NOW()
        RETURNING id
    """
    cur.execute(sql, (
        memory_type,
        json.dumps(content),
        source,
        embedding_str,
        tags,
        confidence,
        psycopg2.Binary(c_hash),
    ))
    return str(cur.fetchone()[0])


def search_memories_direct(cur, embedding: list, top_k: int = SEARCH_TOP_K,
                            tags_filter: list = None) -> list:
    """Semantic search replicating server's buildSearchQuery."""
    embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

    sql = """
        SELECT id, type, tags, confidence, created_at,
               1 - (embedding <#> %s::vector) AS similarity
        FROM memories
        WHERE 1=1
    """
    params = [embedding_str]

    if tags_filter:
        sql += " AND tags && %s::text[]"
        params.append(tags_filter)

    sql += " ORDER BY similarity DESC LIMIT %s"
    params.append(top_k)

    cur.execute(sql, params)
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in rows]


def delete_benchmark_memories(conn) -> int:
    """Remove all memories tagged with 'longmemeval'."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM memories WHERE %s = ANY(tags)", (BENCHMARK_TAG,))
        deleted = cur.rowcount
    conn.commit()
    return deleted


# ── Dataset loading ──────────────────────────────────────────────────────────


def load_dataset(path: str) -> list:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    # Some versions wrap in a dict key
    for key in ("data", "questions", "items"):
        if key in data:
            return data[key]
    return list(data.values())[0] if data else []


def iter_turns(item: dict):
    """
    Yield (session_id, turn_index, role, text, has_answer) for every USER turn.

    Dataset structure (verified from run_retrieval.py line 243):
      item['haystack_session_ids'] – list of session IDs
      item['haystack_sessions']    – parallel list of sessions;
                                     each session = list of {"role", "content", "has_answer?"}
    Only user turns are indexed (mirrors the paper's retrieval baseline).
    """
    session_ids = item.get("haystack_session_ids", [])
    sessions = item.get("haystack_sessions", [])

    for sess_id, session in zip(session_ids, sessions):
        for turn_idx, turn in enumerate(session):
            if turn.get("role") != "user":
                continue
            text = turn.get("content", "")
            if not text:
                continue
            yield {
                "session_id": str(sess_id),
                "turn_index": turn_idx,
                "role": "user",
                "text": text,
                "has_answer": bool(turn.get("has_answer", False)),
            }


def is_abstention(item: dict) -> bool:
    """Abstention questions (question_id ends with '_abs') are excluded from the metric."""
    return str(item.get("question_id", "")).endswith("_abs")


# ── Phase 1: Ingestion ───────────────────────────────────────────────────────


def run_ingestion(items: list, model: SentenceTransformer, conn,
                  batch_size: int = 32, verbose: bool = True) -> int:
    """Ingest all user-side conversation turns into the memory server."""
    print("\n=== Phase 1: Ingestion ===")

    # Collect everything first so we can batch-embed efficiently
    all_turns = []
    for item in items:
        question_id = str(item.get("question_id", ""))
        for turn in iter_turns(item):
            all_turns.append({**turn, "question_id": question_id})

    total = len(all_turns)
    print(f"Total user turns to ingest: {total:,}  (from {len(items)} questions)")

    ingested = skipped = 0
    start = time.time()

    with conn.cursor() as cur:
        for batch_start in range(0, total, batch_size):
            batch = all_turns[batch_start: batch_start + batch_size]
            texts = [truncate_text(t["text"]) for t in batch]
            embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)

            for turn_meta, emb in zip(batch, embeddings):
                sess_tag = normalize_tag(f"session-{turn_meta['session_id']}")
                turn_tag = normalize_tag(f"turn-{turn_meta['turn_index']}")
                tags = [BENCHMARK_TAG, sess_tag, turn_tag]
                if len(tags) < MAX_TAGS:
                    q_tag = normalize_tag(f"q-{turn_meta['question_id']}")
                    if TAG_RE.match(q_tag):
                        tags.append(q_tag)

                content = {
                    "text": truncate_text(turn_meta["text"]),
                    "session_id": turn_meta["session_id"],
                    "question_id": turn_meta["question_id"],
                    "turn_index": turn_meta["turn_index"],
                    "has_answer": turn_meta["has_answer"],
                }

                try:
                    upsert_memory_direct(cur, emb.tolist(), MEMORY_TYPE,
                                         content, SOURCE, tags, 1.0)
                    ingested += 1
                except Exception as e:
                    print(f"\n  [WARN] Insert failed: {e}", file=sys.stderr)
                    skipped += 1

            conn.commit()

            if verbose:
                done = min(batch_start + batch_size, total)
                elapsed = time.time() - start
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                print(f"  [{done:>6}/{total}]  {rate:5.1f} turns/s  ETA {eta:5.0f}s",
                      end="\r", flush=True)

    elapsed = time.time() - start
    print(f"\nIngestion complete: {ingested:,} turns in {elapsed:.1f}s  "
          f"({ingested / elapsed:.1f} turns/s)")
    if skipped:
        print(f"  Skipped: {skipped} turns (see warnings above)")
    return ingested


# ── Phase 2: Retrieval R@K ───────────────────────────────────────────────────


def run_retrieval(items: list, model: SentenceTransformer, conn,
                  top_k: int = SEARCH_TOP_K) -> dict:
    """
    Evaluate session-level Recall@K.

    Hit = at least one of the answer_session_ids appears in the session tags
    of the top-K retrieved turns. Abstention questions are excluded.
    """
    print(f"\n=== Phase 2: Retrieval (R@{top_k}) ===")

    results = []
    hits_by_type: dict = defaultdict(lambda: {"hits": 0, "total": 0})
    total_hits = total_evaluated = 0
    start = time.time()

    with conn.cursor() as cur:
        for idx, item in enumerate(items):
            question_id = str(item.get("question_id", idx))
            question = item.get("question", "")
            question_type = item.get("question_type", "unknown")
            answer_session_ids = set(str(s) for s in item.get("answer_session_ids", []))
            expected_answer = item.get("answer", "")

            # Exclude abstention questions from the metric (matches paper methodology)
            if is_abstention(item):
                continue
            if not question:
                print(f"  [WARN] {question_id} has no question text, skipping.")
                continue

            total_evaluated += 1

            # Embed query and retrieve top-K turns.
            # Filter to only this question's haystack (matches paper's per-question
            # index — the paper builds a fresh corpus per entry, not a shared index).
            q_tag = normalize_tag(f"q-{question_id}")
            q_emb = model.encode([question], normalize_embeddings=True)[0]
            retrieved = search_memories_direct(
                cur, q_emb.tolist(), top_k=top_k,
                tags_filter=[q_tag],
            )

            # Extract session IDs from tags of retrieved turns
            retrieved_session_ids = set()
            for row in retrieved:
                for tag in (row.get("tags") or []):
                    if tag.startswith("session-"):
                        retrieved_session_ids.add(tag[len("session-"):])

            hit = bool(answer_session_ids and
                       retrieved_session_ids & answer_session_ids)
            if hit:
                total_hits += 1
            hits_by_type[question_type]["hits"] += hit
            hits_by_type[question_type]["total"] += 1

            results.append({
                "question_id": question_id,
                "question": question,
                "question_type": question_type,
                "answer_session_ids": list(answer_session_ids),
                "retrieved_session_ids": list(retrieved_session_ids),
                "hit": hit,
                "similarity_scores": [round(float(r.get("similarity", 0)), 4)
                                       for r in retrieved],
                "expected_answer": expected_answer,
                "retrieved_memory_ids": [str(r["id"]) for r in retrieved],
                # kept for Phase 3
                "_retrieved_rows": [{"id": str(r["id"]), "tags": r.get("tags", [])}
                                    for r in retrieved],
            })

            if total_evaluated % 50 == 0:
                r_at_k = total_hits / total_evaluated * 100
                elapsed = time.time() - start
                print(f"  [{total_evaluated:>3}/{len(items)}]  "
                      f"R@{top_k} = {r_at_k:.1f}%  ({elapsed:.0f}s elapsed)")

    r_at_k = total_hits / total_evaluated * 100 if total_evaluated > 0 else 0.0

    print(f"\nR@{top_k} = {r_at_k:.2f}%  ({total_hits}/{total_evaluated})")
    print(f"  (abstention questions excluded from metric)\n")

    print(f"Breakdown by question type:")
    for qtype, stats in sorted(hits_by_type.items()):
        pct = stats["hits"] / stats["total"] * 100 if stats["total"] > 0 else 0
        print(f"  {qtype:<40}  {pct:5.1f}%  ({stats['hits']}/{stats['total']})")

    print(f"\nComparison to baselines:")
    for system, score in BASELINES.items():
        diff = r_at_k - score
        marker = "▲" if diff >= 0 else "▼"
        print(f"  {system:<48}  {score:5.1f}%  {marker}{abs(diff):.1f}pp")

    return {
        "r_at_k": r_at_k,
        "top_k": top_k,
        "total": total_evaluated,
        "hits": total_hits,
        "hits_by_type": dict(hits_by_type),
        "items": results,
    }


# ── Phase 3: QA evaluation (optional) ────────────────────────────────────────


def run_qa_eval(retrieval_results: dict, conn):
    """
    Generate answers using retrieved memories and write JSONL for evaluate_qa.py.

    Output format: {"question_id": ..., "hypothesis": ...}  (one line per question)
    """
    print("\n=== Phase 3: QA Evaluation (generating answers) ===")

    openai_api_key = os.getenv("OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_BASE_URL")  # optional, for custom endpoints
    openai_model = os.getenv("OPENAI_MODEL", "gpt-4o")
    if not openai_api_key:
        print("  [SKIP] OPENAI_API_KEY not set — writing retrieved context to JSONL only.")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    # Resume support: load already-processed question_ids
    done_ids = set()
    if QA_OUTPUT_FILE.exists():
        with open(QA_OUTPUT_FILE, "r", encoding="utf-8") as existing:
            for line in existing:
                try:
                    done_ids.add(json.loads(line)["question_id"])
                except Exception:
                    pass
    if done_ids:
        print(f"  Resuming — skipping {len(done_ids)} already processed questions.")

    total_items = len(retrieval_results["items"])
    with conn.cursor() as cur, open(QA_OUTPUT_FILE, "a", encoding="utf-8") as f:
        for i, item in enumerate(retrieval_results["items"]):
            if item["question_id"] in done_ids:
                continue
            print(f"  [{len(done_ids) + i + 1}/{total_items}] {item['question_id']}",
                  end="\r", flush=True)
            memory_ids = [m["id"] for m in item.get("_retrieved_rows", [])]
            context_parts = []

            for mem_id in memory_ids:
                try:
                    cur.execute("SELECT content FROM memories WHERE id = %s::uuid", (mem_id,))
                    row = cur.fetchone()
                    if row:
                        content = row[0]
                        if isinstance(content, str):
                            content = json.loads(content)
                        text = content.get("text", "")
                        if text:
                            context_parts.append(text)
                except Exception:
                    pass

            context = "\n\n".join(context_parts)
            hypothesis = ""

            if openai_api_key and context:
                try:
                    import openai  # noqa: PLC0415
                    client = openai.OpenAI(
                        api_key=openai_api_key,
                        **({"base_url": openai_base_url} if openai_base_url else {}),
                    )
                    resp = client.chat.completions.create(
                        model=openai_model,
                        messages=[
                            {
                                "role": "system",
                                "content": (
                                    "You are a helpful assistant. Answer the question "
                                    "using only the provided conversation context. "
                                    "If the answer is not in the context, say 'I don't know'."
                                ),
                            },
                            {
                                "role": "user",
                                "content": f"Context:\n{context}\n\nQuestion: {item['question']}",
                            },
                        ],
                        max_tokens=1024,
                        temperature=0,
                    )
                    hypothesis = resp.choices[0].message.content.strip()
                except Exception as e:
                    print(f"  [WARN] OpenAI call failed for {item['question_id']}: {e}")

            # evaluate_qa.py expects {"question_id": ..., "hypothesis": ...}
            f.write(json.dumps({
                "question_id": item["question_id"],
                "hypothesis": hypothesis,
            }, ensure_ascii=False) + "\n")
            f.flush()

    print(f"  QA output written to: {QA_OUTPUT_FILE}")
    print(f"  Run: python src/evaluation/evaluate_qa.py gpt-4o "
          f"{QA_OUTPUT_FILE} <dataset_file>")


# ── Output ────────────────────────────────────────────────────────────────────


def save_results(retrieval_results: dict, dataset_path: str):
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    # Strip internal _retrieved_rows before saving
    clean_items = [
        {k: v for k, v in r.items() if k != "_retrieved_rows"}
        for r in retrieval_results["items"]
    ]

    output = {
        "benchmark": "LongMemEval",
        "dataset": dataset_path,
        "embedding_model": EMBEDDING_MODEL,
        "top_k": retrieval_results["top_k"],
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "r_at_k": retrieval_results["r_at_k"],
        "total_questions": retrieval_results["total"],
        "hits": retrieval_results["hits"],
        "hits_by_type": retrieval_results["hits_by_type"],
        "baselines": BASELINES,
        "items": clean_items,
    }

    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nDetailed results → {RESULTS_FILE}")
    _print_readme_snippet(retrieval_results)


def _print_readme_snippet(retrieval_results: dict):
    r = retrieval_results["r_at_k"]
    k = retrieval_results["top_k"]
    n = retrieval_results["total"]
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    color = ("brightgreen" if r >= 85 else
             "green"       if r >= 70 else
             "yellow"      if r >= 55 else "red")
    badge = f"https://img.shields.io/badge/LongMemEval%20R%40{k}-{r:.1f}%25-{color}"

    print("\n" + "=" * 62)
    print("README snippet:")
    print("=" * 62)
    print(f"\n![LongMemEval R@{k}]({badge})\n")
    print(f"### Benchmark: LongMemEval R@{k}\n")
    print(f"Evaluated on `longmemeval_s` ({n} questions, abstentions excluded), {date}.\n")
    print(f"| System | R@{k} |")
    print("|---|---|")

    all_systems = [("**codex-mcp-memory (this)**", r)] + list(BASELINES.items())
    for name, score in sorted(all_systems, key=lambda x: -x[1]):
        print(f"| {name} | {score:.1f}% |")
    print()


# ── CLI ───────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="LongMemEval R@5 benchmark for codex-mcp-memory",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--dataset", default="data/longmemeval_s.json",
                        help="Path to longmemeval_s.json (default: data/longmemeval_s.json)")
    parser.add_argument("--top-k", type=int, default=SEARCH_TOP_K,
                        help=f"Retrieval top-K (default: {SEARCH_TOP_K})")
    parser.add_argument("--skip-ingestion", action="store_true",
                        help="Skip Phase 1 (use already-ingested data)")
    parser.add_argument("--qa-eval", action="store_true",
                        help="Run Phase 3 QA answer generation (requires OPENAI_API_KEY)")
    parser.add_argument("--cleanup", action="store_true",
                        help="Delete all longmemeval memories and exit")
    parser.add_argument("--batch-size", type=int, default=32,
                        help="Embedding batch size (default: 32)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Limit to first N questions (for smoke testing)")
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL environment variable is required.", file=sys.stderr)
        sys.exit(1)

    print("Connecting to database…")
    conn = get_connection(database_url)
    ensure_vector_extension(conn)

    if args.cleanup:
        print("Deleting all LongMemEval benchmark memories…")
        deleted = delete_benchmark_memories(conn)
        print(f"Deleted {deleted:,} memories tagged '{BENCHMARK_TAG}'.")
        conn.close()
        return

    if not Path(args.dataset).exists():
        print(f"ERROR: Dataset not found: {args.dataset}", file=sys.stderr)
        print("Download from https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
              file=sys.stderr)
        sys.exit(1)

    print(f"Loading dataset from {args.dataset}…")
    items = load_dataset(args.dataset)
    if args.limit:
        items = items[: args.limit]
    print(f"Loaded {len(items)} questions.")

    print(f"Loading embedding model: {EMBEDDING_MODEL}")
    model = SentenceTransformer(EMBEDDING_MODEL)
    print("Model ready.\n")

    if not args.skip_ingestion:
        run_ingestion(items, model, conn, batch_size=args.batch_size)
    else:
        print("[Skipping Phase 1 — using existing data]")

    retrieval_results = run_retrieval(items, model, conn, top_k=args.top_k)

    if args.qa_eval:
        run_qa_eval(retrieval_results, conn)

    save_results(retrieval_results, args.dataset)
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
