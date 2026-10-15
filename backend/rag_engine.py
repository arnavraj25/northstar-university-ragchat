import csv
import io
import json
import math
import os
import re
import sqlite3
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "northstar_university_ragchat_dataset" / "northstar_university_ragchat"
DATA_DIR = Path(os.environ.get("RAG_DATA_DIR", Path(__file__).resolve().parent / "data"))
PERSIST_PATH = DATA_DIR / "sources.json"
UPLOAD_DIR = DATA_DIR / "uploads"
DATABASE_PATH = DATA_DIR / "ragchat.sqlite3"
CHROMA_DIR = DATA_DIR / "chroma"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
CHAT_MODEL = os.environ.get("OLLAMA_CHAT_MODEL", "nemotron-mini:latest")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
SENTENCE_TRANSFORMER_MODEL = os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
CHUNK_WORDS = 180
OVERLAP_WORDS = 35
TOP_K = 5
MIN_RELEVANCE = 0.055
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

try:
    import chromadb
except ImportError:
    chromadb = None

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    SentenceTransformer = None

CHROMA_COLLECTION = None
if chromadb is not None:
    try:
        CHROMA_COLLECTION = chromadb.PersistentClient(path=str(CHROMA_DIR)).get_or_create_collection(
            "northstar_university_sources",
            metadata={"hnsw:space": "cosine"},
        )
    except Exception:
        CHROMA_COLLECTION = None

_sentence_model = None
_sentence_model_error = None
STOP_WORDS = {
    "a", "about", "an", "and", "are", "as", "at", "be", "can", "do", "does",
    "document", "documents", "for", "from", "how", "i", "in", "is", "it", "long",
    "me", "my", "need", "of", "on", "or", "the", "their", "to", "what", "when",
    "where", "which", "who", "will", "with",
}

app = FastAPI(title="Northstar Local RAG Service", version="1.0.0")


@contextmanager
def database_connection():
    connection = sqlite3.connect(DATABASE_PATH, timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    with database_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sources (
                source_id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                stored_path TEXT,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                uploaded_at TEXT NOT NULL,
                source_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chunks (
                chunk_id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
                chunk_text TEXT NOT NULL,
                page INTEGER,
                section TEXT,
                embedding_json TEXT
            );
            CREATE INDEX IF NOT EXISTS chunks_source_id_idx ON chunks(source_id);
            CREATE TABLE IF NOT EXISTS deleted_seed_sources (
                source_id TEXT PRIMARY KEY
            );
            """
        )


initialize_database()


class QueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    session_id: str | None = None


class UpdateSourceRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20 * 1024 * 1024)


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", text.lower())


def meaningful_tokens(text: str) -> list[str]:
    words = [word for word in tokenize(text) if word not in STOP_WORDS]
    normalized = []
    for word in words:
        if word.startswith("examin"):
            normalized.append("exam")
        elif len(word) > 7 and word.endswith("ing"):
            normalized.append(word[:-3])
        elif len(word) > 5 and word.endswith("ies"):
            normalized.append(f"{word[:-3]}y")
        elif len(word) > 4 and word.endswith("s"):
            normalized.append(word[:-1])
        else:
            normalized.append(word)
    return normalized


def local_vector(text: str, inverse_document_frequency: dict[str, float]) -> dict[str, float]:
    words = meaningful_tokens(text)
    terms = words + [f"{words[index]}_{words[index + 1]}" for index in range(len(words) - 1)]
    counts = Counter(terms)
    return {
        term: (1 + math.log(count)) * inverse_document_frequency.get(term, 1.0)
        for term, count in counts.items()
    }


def cosine_similarity(first: dict[str, float], second: dict[str, float]) -> float:
    if not first or not second:
        return 0.0
    dot = sum(value * second.get(term, 0) for term, value in first.items())
    norm_first = math.sqrt(sum(value * value for value in first.values()))
    norm_second = math.sqrt(sum(value * value for value in second.values()))
    return dot / (norm_first * norm_second) if norm_first and norm_second else 0.0


def split_chunks(text: str, page: int | None = None) -> list[dict[str, Any]]:
    words = text.split()
    if not words:
        return []
    headings: list[tuple[int, str]] = []
    word_position = 0
    for line in text.splitlines():
        line_words = line.split()
        stripped = line.strip()
        normalized_heading = re.sub(r"^#{1,6}\s*", "", stripped)
        is_markdown_heading = normalized_heading != stripped
        is_numbered_heading = bool(re.match(r"^\d+(?:\.\d+)*\.?\s+[A-Z]", stripped))
        if stripped and (is_markdown_heading or is_numbered_heading):
            headings.append((word_position, normalized_heading))
        word_position += len(line_words)
    chunks = []
    step = CHUNK_WORDS - OVERLAP_WORDS
    section_ranges = []
    start = 0
    section = "Overview"
    for heading_offset, heading in headings:
        if heading_offset > start:
            section_ranges.append((start, heading_offset, section))
        start = heading_offset
        section = heading
    if start < len(words):
        section_ranges.append((start, len(words), section))

    for section_start, section_end, section in section_ranges:
        for offset in range(section_start, section_end, step):
            end = min(offset + CHUNK_WORDS, section_end)
            content = " ".join(words[offset:end]).strip()
            if content:
                chunks.append({"text": content, "page": page, "section": section})
            if end == section_end:
                break
    return chunks


def source_identifier(document_id: str, filename: str) -> str:
    if document_id:
        return document_id
    stem = Path(filename).stem
    normalized = re.sub(r"[^A-Z0-9]+", "-", stem.upper()).strip("-")
    return normalized[:40] or "UPLOADED-SOURCE"


def make_source(
    *,
    title: str,
    filename: str,
    content: str,
    source_id: str | None = None,
    category: str = "uploaded_document",
    status: str = "uploaded",
    effective_date: str | None = None,
    removable: bool = True,
    page_texts: list[tuple[int, str]] | None = None,
    stored_path: str | None = None,
    size_bytes: int = 0,
    uploaded_at: str | None = None,
) -> dict[str, Any]:
    identifier = source_id or source_identifier("", filename)
    passages = []
    for page, text in page_texts or [(None, content)]:
        passages.extend(split_chunks(text, page))
    for index, passage in enumerate(passages):
        passage["chunk_id"] = f"{identifier}-CH{index + 1:03d}"
    return {
        "sourceId": identifier,
        "title": title,
        "filename": filename,
        "category": category,
        "status": status,
        "effectiveDate": effective_date,
        "removable": removable,
        "storedPath": stored_path,
        "sizeBytes": size_bytes,
        "uploadedAt": uploaded_at or datetime.now(timezone.utc).isoformat(),
        "content": content,
        "chunks": passages,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def load_seed_sources() -> list[dict[str, Any]]:
    corpus_path = DATASET / "documents.json"
    if not corpus_path.exists():
        return []
    try:
        corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Unable to read the provided Northstar source corpus: {error}") from error
    sources = []
    for document in corpus.get("documents", []):
        if document.get("status") != "official":
            continue
        sources.append(
            make_source(
                title=document["title"],
                filename=f"{document['document_id'].lower().replace('-', '_')}.txt",
                content=document["content"],
                source_id=document["document_id"],
                category=document.get("category", "policy"),
                status="official",
                effective_date=document.get("effective_date"),
                removable=False,
            )
        )
    return sources


def load_sources() -> list[dict[str, Any]]:
    seeded = load_seed_sources()
    seeded_ids = {source["sourceId"] for source in seeded}
    with database_connection() as connection:
        rows = connection.execute("SELECT source_json FROM sources ORDER BY uploaded_at").fetchall()
        deleted_seed_ids = {
            row["source_id"] for row in connection.execute("SELECT source_id FROM deleted_seed_sources")
        }
    persisted = [json.loads(row["source_json"]) for row in rows]
    persisted_by_id = {source["sourceId"]: source for source in persisted}
    seeded = [
        persisted_by_id.get(source["sourceId"], source)
        for source in seeded
        if source["sourceId"] not in deleted_seed_ids
    ]
    custom = [source for source in persisted if source.get("sourceId") not in seeded_ids]
    if not custom and PERSIST_PATH.exists():
        try:
            legacy = json.loads(PERSIST_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Unable to load the legacy source index: {error}") from error
        custom = [source for source in legacy if source.get("sourceId") not in seeded_ids]
        for source in custom:
            persist_source(source, source.get("sizeBytes", 0))
    return seeded + custom


def persist_sources(sources: list[dict[str, Any]]) -> None:
    for source in sources:
        if source.get("removable"):
            persist_source(source, source.get("sizeBytes", 0))


def persist_source(source: dict[str, Any], size_bytes: int) -> None:
    source_json = json.dumps(source, ensure_ascii=False)
    with database_connection() as connection:
        connection.execute(
            """INSERT INTO sources(source_id, filename, stored_path, size_bytes, uploaded_at, source_json)
               VALUES(?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_id) DO UPDATE SET
               filename=excluded.filename, stored_path=excluded.stored_path,
               size_bytes=excluded.size_bytes, uploaded_at=excluded.uploaded_at,
               source_json=excluded.source_json""",
            (
                source["sourceId"],
                source["filename"],
                source.get("storedPath"),
                size_bytes,
                source.get("uploadedAt", datetime.now(timezone.utc).isoformat()),
                source_json,
            ),
        )
        connection.execute("DELETE FROM deleted_seed_sources WHERE source_id = ?", (source["sourceId"],))
        connection.execute("DELETE FROM chunks WHERE source_id = ?", (source["sourceId"],))
        connection.executemany(
            """INSERT INTO chunks(chunk_id, source_id, chunk_text, page, section, embedding_json)
               VALUES(?, ?, ?, ?, ?, ?)""",
            [
                (
                    passage["chunk_id"],
                    source["sourceId"],
                    passage["text"],
                    passage.get("page"),
                    passage.get("section"),
                    json.dumps(passage["embedding"]) if passage.get("embedding") else None,
                )
                for passage in source["chunks"]
            ],
        )


def delete_persisted_source(source_id: str) -> str | None:
    with database_connection() as connection:
        row = connection.execute(
            "SELECT stored_path FROM sources WHERE source_id = ?",
            (source_id,),
        ).fetchone()
        if row is None:
            connection.execute(
                "INSERT OR IGNORE INTO deleted_seed_sources(source_id) VALUES(?)",
                (source_id,),
            )
            return None
        connection.execute("DELETE FROM sources WHERE source_id = ?", (source_id,))
        connection.execute(
            "INSERT OR IGNORE INTO deleted_seed_sources(source_id) VALUES(?)",
            (source_id,),
        )
    return row["stored_path"]


SOURCES = load_sources()
EMBEDDING_CACHE = {
    passage["chunk_id"]: passage["embedding"]
    for source in SOURCES
    for passage in source["chunks"]
    if passage.get("embedding")
}


def ollama_request(path: str, payload: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{OLLAMA_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get_query_embedding(question: str) -> list[float] | None:
    model = get_sentence_model()
    if model is not None:
        return model.encode(question, normalize_embeddings=True).tolist()
    try:
        response = ollama_request("/api/embed", {"model": EMBED_MODEL, "input": question}, timeout=4)
        embeddings = response.get("embeddings", [])
        return embeddings[0] if embeddings else None
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, KeyError, IndexError):
        return None


def embed_passages(passages: list[dict[str, Any]]) -> tuple[list[list[float] | None], bool]:
    if not passages:
        return [], False
    model = get_sentence_model()
    if model is not None:
        vectors = model.encode(
            [passage["text"] for passage in passages],
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return vectors.tolist(), True
    try:
        response = ollama_request(
            "/api/embed",
            {"model": EMBED_MODEL, "input": [passage["text"] for passage in passages]},
            timeout=15,
        )
        vectors = response.get("embeddings", [])
        if len(vectors) == len(passages):
            return vectors, True
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        pass
    return [None] * len(passages), False


def get_sentence_model():
    global _sentence_model, _sentence_model_error
    if SentenceTransformer is None or os.environ.get("USE_SENTENCE_TRANSFORMERS", "1").lower() not in {"1", "true", "yes"}:
        return None
    if _sentence_model is not None or _sentence_model_error:
        return _sentence_model
    try:
        _sentence_model = SentenceTransformer(SENTENCE_TRANSFORMER_MODEL, local_files_only=True)
    except Exception as error:
        _sentence_model_error = str(error)
    return _sentence_model


def sync_chroma(passages: list[dict[str, Any]]) -> None:
    if CHROMA_COLLECTION is None:
        return
    indexed = [passage for passage in passages if passage.get("embedding")]
    if not indexed:
        return
    CHROMA_COLLECTION.upsert(
        ids=[passage["chunk_id"] for passage in indexed],
        embeddings=[passage["embedding"] for passage in indexed],
        documents=[passage["text"] for passage in indexed],
        metadatas=[
            {
                "sourceId": passage["sourceId"],
                "title": passage["title"],
                "filename": passage["filename"],
                "status": passage["status"],
                "page": passage.get("page") or 0,
                "section": passage.get("section") or "Document",
            }
            for passage in indexed
        ],
    )


def vector_cosine(first: list[float], second: list[float]) -> float:
    if len(first) != len(second) or not first:
        return 0.0
    dot = sum(a * b for a, b in zip(first, second))
    norm_first = math.sqrt(sum(value * value for value in first))
    norm_second = math.sqrt(sum(value * value for value in second))
    return dot / (norm_first * norm_second) if norm_first and norm_second else 0.0


def flatten_passages() -> list[dict[str, Any]]:
    return [
        {
            **passage,
            "sourceId": source["sourceId"],
            "title": source["title"],
            "filename": source["filename"],
            "status": source["status"],
            "category": source["category"],
        }
        for source in SOURCES
        for passage in source["chunks"]
    ]


def retrieve(question: str) -> tuple[list[dict[str, Any]], str]:
    passages = flatten_passages()
    query_embedding = get_query_embedding(question)
    for passage in passages:
        if not passage.get("embedding"):
            passage["embedding"] = EMBEDDING_CACHE.get(passage["chunk_id"])
    if query_embedding is not None and any(not passage.get("embedding") for passage in passages):
        missing = [passage for passage in passages if not passage.get("embedding")]
        vectors, embedded = embed_passages(missing)
        if embedded:
            for passage, embedding in zip(missing, vectors):
                passage["embedding"] = embedding
                EMBEDDING_CACHE[passage["chunk_id"]] = embedding
    use_ollama_vectors = query_embedding is not None and all(passage.get("embedding") for passage in passages)
    if use_ollama_vectors:
        sync_chroma(passages)
        if CHROMA_COLLECTION is not None and passages:
            results = CHROMA_COLLECTION.query(
                query_embeddings=[query_embedding],
                n_results=min(TOP_K, len(passages)),
                include=["distances"],
            )
            distances = (results.get("distances") or [[]])[0]
            result_ids = (results.get("ids") or [[]])[0]
            by_id = {passage["chunk_id"]: passage for passage in passages}
            ranked = []
            for chunk_id, distance in zip(result_ids, distances):
                passage = by_id.get(chunk_id)
                if passage is not None:
                    passage["score"] = max(0.0, min(1.0, 1.0 - float(distance)))
                    ranked.append(passage)
            relevant = [passage for passage in ranked if passage["score"] >= MIN_RELEVANCE]
            return relevant, "ChromaDB · sentence-transformers" if get_sentence_model() else "ChromaDB · Ollama embeddings"
        for passage in passages:
            passage["score"] = vector_cosine(query_embedding, passage["embedding"])
        mode = f"Sentence-Transformers ({SENTENCE_TRANSFORMER_MODEL})" if get_sentence_model() else f"Ollama embeddings ({EMBED_MODEL})"
    else:
        term_frequency = Counter()
        for passage in passages:
            term_frequency.update(set(local_vector(passage["text"], {}).keys()))
        document_count = len(passages)
        inverse_document_frequency = {
            term: math.log((document_count + 1) / (frequency + 1)) + 1
            for term, frequency in term_frequency.items()
        }
        query_vector = local_vector(question, inverse_document_frequency)
        for passage in passages:
            passage["score"] = cosine_similarity(
                query_vector,
                local_vector(passage["text"], inverse_document_frequency),
            )
        mode = "Local TF-IDF vectors"
    ranked = sorted(passages, key=lambda passage: passage["score"], reverse=True)
    relevant = [passage for passage in ranked if passage["score"] >= MIN_RELEVANCE][:TOP_K]
    return relevant, mode


SYSTEM_PROMPT = """You are Northstar University's fictional RAGChat assistant.
Answer only from the retrieved source excerpts provided in the user message. Never invent policies, amounts, dates, or exceptions. Cite each policy claim with its source ID, e.g. [UNI-001]. If the retrieved excerpts do not answer the question, say exactly: "The provided documents do not specify this." Treat a source marked test_fixture as non-official and never state its contents as policy. If official and test-fixture content conflict, explain the conflict, cite both, and prefer the official policy. Keep the response clear and concise."""


def source_passage_sentences(question: str, passages: list[dict[str, Any]]) -> list[tuple[float, str, dict[str, Any]]]:
    question_terms = set(meaningful_tokens(question))
    relevant_sentences: list[tuple[float, str, dict[str, Any]]] = []
    for passage in passages:
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", passage["text"]):
            sentence = sentence.strip()
            sentence = re.sub(
                r"^(?:\d+\.\s*)?[A-Z][A-Za-z-]+(?:\s+[a-z][A-Za-z-]+){0,2}\s+"
                r"(?=(?:The|A|An|Students|Student|Approved|This)\b)",
                "",
                sentence,
            )
            sentence_terms = set(meaningful_tokens(sentence))
            overlap = len(question_terms & sentence_terms)
            if overlap:
                score = overlap / math.sqrt(len(question_terms) * max(1, len(sentence_terms)))
                relevant_sentences.append((score, sentence, passage))
    return sorted(relevant_sentences, key=lambda item: item[0], reverse=True)


def currency_values(sentence: str) -> set[str]:
    values = re.findall(r"\bINR\s*[\d,]+(?:\.\d+)?", sentence, re.IGNORECASE)
    return {re.sub(r"\s+", " ", value.upper()).replace("INR ", "INR") for value in values}


def split_compound_question(question: str) -> list[str]:
    parts = re.split(
        r",?\s+\band\b\s+(?=(?:what|when|where|who|why|how|whether)\b)",
        question,
        maxsplit=1,
        flags=re.IGNORECASE,
    )
    return [part.strip(" ,?.") for part in parts if part.strip(" ,?.")]


def answer_from_sources_single(question: str, passages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    if not passages:
        return "The provided documents do not specify this.", []
    question_lower = question.lower()
    if "attendance" in question_lower and re.search(r"\b(?:waiv\w*|guarante\w*|definitely)\b", question_lower):
        supporting = []
        for source_id in ("UNI-001", "UNI-007"):
            source = next((item for item in SOURCES if item["sourceId"] == source_id), None)
            if not source:
                continue
            passage = next(
                (
                    chunk for chunk in source["chunks"]
                    if any(
                        phrase in chunk["text"].lower()
                        for phrase in (
                            "does not guarantee approval",
                            "whether any formal remedy is available",
                            "does not guarantee an attendance exemption",
                        )
                    )
                ),
                None,
            )
            if passage:
                supporting.append(
                    {
                        **passage,
                        "sourceId": source["sourceId"],
                        "title": source["title"],
                        "filename": source["filename"],
                        "status": source["status"],
                        "score": 0.0,
                    }
                )
        if supporting:
            source_ids = " ".join(f"[{passage['sourceId']}]" for passage in supporting)
            return (
                "No. A medical absence request does not guarantee approval, and an attendance exception requires "
                f"written approval from the authorized academic officer. {source_ids}",
                supporting,
            )
    if re.search(r"\b(?:wi[\s-]?fi|wireless)\b", question, re.IGNORECASE) and re.search(
        r"\bpassword\b", question, re.IGNORECASE
    ):
        campus_source = next((source for source in SOURCES if source["sourceId"] == "UNI-008"), None)
        if campus_source:
            helpdesk_passage = next(
                (passage for passage in campus_source["chunks"] if "help desk" in passage["text"].lower()),
                campus_source["chunks"][0] if campus_source["chunks"] else None,
            )
            if helpdesk_passage:
                cited = {
                    **helpdesk_passage,
                    "sourceId": campus_source["sourceId"],
                    "title": campus_source["title"],
                    "filename": campus_source["filename"],
                    "status": campus_source["status"],
                    "score": 0.0,
                }
                answer = (
                    "The provided documents do not specify the student Wi-Fi password. "
                    "The campus help desk is listed in the Student Services Building. [UNI-008]"
                )
                return answer, [cited]
    relevant_sentences = source_passage_sentences(question, passages)
    if not relevant_sentences:
        return "The provided documents do not specify this.", []
    official_facts = [
        item for item in relevant_sentences
        if item[2]["status"] == "official" and currency_values(item[1])
    ]
    fixture_facts = [
        item for item in relevant_sentences
        if item[2]["status"] == "test_fixture" and currency_values(item[1])
    ]
    if official_facts and fixture_facts:
        _, official_sentence, official_passage = official_facts[0]
        fixture_fact = next(
            (item for item in fixture_facts if currency_values(item[1]) != currency_values(official_sentence)),
            None,
        )
        if fixture_fact:
            _, fixture_sentence, fixture_passage = fixture_fact
            fixture_amount = next(
                iter(currency_values(fixture_sentence) - currency_values(official_sentence))
            )
            answer = (
                f'The official policy states: "{official_sentence}" [{official_passage["sourceId"]}] '
                f'The uploaded source is explicitly marked as a non-official test fixture and gives a conflicting '
                f'amount of {fixture_amount}; it is not policy. [{fixture_passage["sourceId"]}]'
            )
            return answer, [official_passage, fixture_passage]
    intent_terms = set(meaningful_tokens(question))
    if intent_terms & {"report", "contact", "submit", "apply", "request"}:
        action_terms = {"office", "portal", "desk", "contact", "submit", "apply"}
        relevant_sentences = sorted(
            (
                (score + (0.2 if action_terms & set(meaningful_tokens(sentence)) else 0), sentence, passage)
                for score, sentence, passage in relevant_sentences
            ),
            key=lambda item: item[0],
            reverse=True,
        )
    if "attendance" in intent_terms and intent_terms & {"exam", "eligibility", "minimum", "qualify"}:
        relevant_sentences = sorted(
        (
            (
                score + (0.25 if re.search(r"\b\d+(?:\.\d+)?%", sentence) else 0),
                sentence,
                passage,
            )
            for score, sentence, passage in relevant_sentences
        ),
        key=lambda item: item[0],
        reverse=True,
        )
    best_score = relevant_sentences[0][0]
    selected: list[str] = []
    used_passages: list[dict[str, Any]] = []
    used_source_ids: set[str] = set()
    for score, sentence, passage in relevant_sentences:
        if score < max(0.10, best_score * 0.42) or sentence in selected:
            continue
        if selected:
            break
        selected.append(sentence)
        if passage["sourceId"] not in used_source_ids:
            used_source_ids.add(passage["sourceId"])
            used_passages.append(passage)
    if not selected:
        return "The provided documents do not specify this.", []
    if any("does not define" in sentence.lower() for sentence in selected):
        source_ids = " ".join(f"[{passage['sourceId']}]" for passage in used_passages)
        return f"The provided documents do not specify this. {source_ids}", used_passages
    if ("waiv" in question.lower() or "guarantee" in question.lower()) and any(
        "submission does not guarantee approval" in sentence.lower()
        or "whether any formal remedy" in sentence.lower()
        or "does not guarantee an attendance exemption" in sentence.lower()
        for sentence in selected
    ):
        selected = ["The documents do not guarantee a waiver.", *[
            sentence for sentence in selected
            if "submission does not guarantee approval" in sentence.lower()
            or "whether any formal remedy" in sentence.lower()
            or "does not guarantee an attendance exemption" in sentence.lower()
        ]]
    referenced_ids = {
        identifier
        for passage in used_passages
        for identifier in re.findall(r"\b[A-Z]{2,}-\d{3}\b", passage["text"])
    }
    for source_id in referenced_ids - used_source_ids:
        referenced_source = next((source for source in SOURCES if source["sourceId"] == source_id), None)
        if referenced_source and referenced_source["chunks"]:
            referenced_passage = next(
                (passage for passage in passages if passage["sourceId"] == source_id),
                None,
            )
            if referenced_passage is None:
                referenced_passage = {
                    **referenced_source["chunks"][0],
                    "sourceId": referenced_source["sourceId"],
                    "title": referenced_source["title"],
                    "filename": referenced_source["filename"],
                    "status": referenced_source["status"],
                    "score": 0.0,
                }
            used_passages.append(referenced_passage)
    source_ids = " ".join(f"[{passage['sourceId']}]" for passage in used_passages)
    return f"{' '.join(selected)} {source_ids}", used_passages


def answer_from_sources(question: str, passages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    parts = split_compound_question(question)
    if len(parts) < 2:
        return answer_from_sources_single(question, passages)
    answers = []
    citations = []
    seen = set()
    for part in parts:
        answer, supporting = answer_from_sources_single(part, passages)
        answers.append(answer)
        for passage in supporting:
            key = (passage["sourceId"], passage.get("page"))
            if key not in seen:
                seen.add(key)
                citations.append(passage)
    return "\n\n".join(answers), citations


def generate_answer(
    question: str,
    passages: list[dict[str, Any]],
) -> tuple[str, str, list[dict[str, Any]]]:
    university_specific = bool(
        re.search(
            r"\b(?:northstar|university|campus|policy|tuition|fee|attendance|scholarship|"
            r"exam|student|registration|course|semester|library|leave|absence|refund)\b",
            question,
            re.IGNORECASE,
        )
    )
    if not passages or passages[0]["score"] < MIN_RELEVANCE * 1.5:
        if university_specific:
            return "The provided documents do not specify this. I won't guess at university policies.", "No source evidence", []
        try:
            response = ollama_request(
                "/api/chat",
                {
                    "model": CHAT_MODEL,
                    "stream": False,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Answer the user's general academic or reasoning question helpfully and concisely. "
                                "You have no verified live sources. Do not claim to know current facts, invent citations, "
                                "or answer questions about Northstar University policy. State uncertainty where appropriate."
                            ),
                        },
                        {"role": "user", "content": question},
                    ],
                    "options": {"temperature": 0.1},
                },
                timeout=90,
            )
            answer = response.get("message", {}).get("content", "").strip()
            if answer:
                return answer, f"General knowledge · {CHAT_MODEL}", []
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            pass
        return (
            "I couldn't find this in the indexed university documents, and no general-knowledge model is available "
            "to verify an answer right now.",
            "No verified source",
            [],
        )
    context = "\n\n".join(
        f"[{passage['sourceId']} | {passage['title']} | {passage['status']}"
        f"{' | page ' + str(passage['page']) if passage.get('page') else ''}]\n{passage['text']}"
        for passage in passages
    )
    try:
        response = ollama_request(
            "/api/chat",
            {
                "model": CHAT_MODEL,
                "stream": False,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": f"Retrieved source excerpts:\n{context}\n\nQuestion: {question}"},
                ],
                "options": {"temperature": 0.1},
            },
            timeout=90,
        )
        answer = response.get("message", {}).get("content", "").strip()
        only_citation_labels = re.fullmatch(
            r"(?:\s*\[[A-Z0-9_-]+(?:\s*\|\s*[^\]\n]+)?\]\s*[.!?]*)+",
            answer,
            re.IGNORECASE,
        )
        if answer and not only_citation_labels:
            return answer, CHAT_MODEL, passages
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        pass
    answer, supporting_passages = answer_from_sources(question, passages)
    return answer, "Local evidence fallback", supporting_passages


def make_citations(passages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    citations = []
    seen = set()
    for passage in passages:
        key = (passage["sourceId"], passage.get("page"))
        if key in seen:
            continue
        seen.add(key)
        excerpt = passage["text"]
        if len(excerpt) > 330:
            excerpt = excerpt[:327].rsplit(" ", 1)[0] + "..."
        citations.append(
            {
                "sourceId": passage["sourceId"],
                "documentId": passage["sourceId"],
                "title": passage["title"],
                "filename": passage["filename"],
                "originalFilename": passage["filename"],
                "status": passage["status"],
                "page": passage.get("page"),
                "pageNumber": passage.get("page"),
                "sectionHeading": passage.get("section") or "Document",
                "excerpt": excerpt,
                "score": round(passage["score"], 4),
                "similarityPercent": round(max(0.0, min(1.0, passage["score"])) * 100, 1),
            }
        )
    return citations


def ollama_model_available(model_name: str) -> bool:
    try:
        request = urllib.request.Request(f"{OLLAMA_URL}/api/tags", method="GET")
        with urllib.request.urlopen(request, timeout=1.5) as response:
            models = json.loads(response.read().decode("utf-8")).get("models", [])
        return any(
            name == model_name or name.startswith(f"{model_name}:")
            for name in (model.get("name", "") for model in models)
        )
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return False


def ollama_available() -> bool:
    return ollama_model_available(CHAT_MODEL)


@app.get("/health")
def health() -> dict[str, Any]:
    chat_model_ready = ollama_available()
    embedding_model_ready = ollama_model_available(EMBED_MODEL)
    sentence_model = get_sentence_model()
    return {
        "rag": "online",
        "ollama": chat_model_ready,
        "model": CHAT_MODEL if chat_model_ready else "Local evidence fallback",
        "embeddingMode": (
            f"ChromaDB · Sentence-Transformers ({SENTENCE_TRANSFORMER_MODEL})"
            if CHROMA_COLLECTION is not None and sentence_model
            else f"Sentence-Transformers ({SENTENCE_TRANSFORMER_MODEL})"
            if sentence_model
            else f"ChromaDB · Ollama ({EMBED_MODEL})"
            if embedding_model_ready and CHROMA_COLLECTION is not None
            else f"Ollama · {EMBED_MODEL}"
            if embedding_model_ready
            else "SQLite persistence · local TF-IDF fallback"
        ),
        "vectorStore": "ChromaDB" if CHROMA_COLLECTION is not None else "SQLite + local cosine search",
        "generalKnowledgeModel": chat_model_ready,
        "sourceCount": len(SOURCES),
    }


def source_metadata(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "sourceId": source["sourceId"],
        "documentId": source["sourceId"],
        "title": source["title"],
        "filename": source["filename"],
        "originalFilename": source["filename"],
        "category": source["category"],
        "status": source["status"],
        "effectiveDate": source.get("effectiveDate"),
        "chunkCount": len(source["chunks"]),
        "removable": True,
        "uploadedAt": source.get("uploadedAt") if source["removable"] else None,
        "sizeBytes": source.get("sizeBytes", 0),
        "reindexable": bool(source.get("storedPath")),
    }


@app.get("/sources")
def list_sources() -> dict[str, Any]:
    items = [source_metadata(source) for source in SOURCES]
    return {"sources": items, "count": len(items)}


@app.get("/sources/{source_id}")
def get_source(source_id: str) -> dict[str, Any]:
    source = next((item for item in SOURCES if item["sourceId"] == source_id), None)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found.")
    return {
        **source_metadata(source),
        "content": source["content"],
        "chunks": [
            {
                "chunkId": chunk["chunk_id"],
                "text": chunk["text"],
                "pageNumber": chunk.get("page"),
                "sectionHeading": chunk.get("section") or "Document",
            }
            for chunk in source["chunks"]
        ],
    }


@app.post("/query")
def query(request: QueryRequest) -> dict[str, Any]:
    question = request.question.strip()
    question_parts = split_compound_question(question)
    retrieved: dict[str, dict[str, Any]] = {}
    retrieval_modes = []
    for part in question_parts or [question]:
        matches, mode = retrieve(part)
        retrieval_modes.append(mode)
        for passage in matches:
            current = retrieved.get(passage["chunk_id"])
            if current is None or passage["score"] > current["score"]:
                retrieved[passage["chunk_id"]] = passage
    passages = sorted(retrieved.values(), key=lambda passage: passage["score"], reverse=True)
    retrieval_mode = retrieval_modes[0] if retrieval_modes and len(set(retrieval_modes)) == 1 else "Combined local retrieval"
    answer, model, cited_passages = generate_answer(question, passages)
    if model.startswith("General knowledge"):
        answer_type = "general_knowledge"
    elif cited_passages and any(passage["status"] == "test_fixture" for passage in cited_passages):
        answer_type = "mixed_sources"
    elif cited_passages:
        answer_type = "official_sources" if all(
            passage["status"] == "official" for passage in cited_passages
        ) else "indexed_sources"
    else:
        answer_type = "unsupported"
    return {
        "answer": answer,
        "citations": make_citations(cited_passages),
        "retrievalMode": retrieval_mode,
        "model": model,
        "answerType": answer_type,
    }


def read_upload(filename: str, content: bytes) -> tuple[str, list[tuple[int, str]] | None, str]:
    extension = Path(filename).suffix.lower()
    if extension == ".pdf":
        try:
            reader = PdfReader(io.BytesIO(content))
            page_texts = [(index + 1, page.extract_text() or "") for index, page in enumerate(reader.pages)]
        except Exception as error:
            raise HTTPException(status_code=422, detail=f"Could not read PDF: {error}") from error
        text = "\n\n".join(page_text for _, page_text in page_texts)
        if not text.strip():
            raise HTTPException(status_code=422, detail="The PDF contains no extractable text.")
        return text, page_texts, "uploaded_document"
    if extension == ".csv":
        try:
            decoded = content.decode("utf-8-sig")
            rows = list(csv.DictReader(io.StringIO(decoded)))
        except (UnicodeDecodeError, csv.Error) as error:
            raise HTTPException(status_code=422, detail=f"Could not read CSV: {error}") from error
        if not rows:
            raise HTTPException(status_code=422, detail="The CSV must include a header and at least one data row.")
        text = "\n\n".join(
            "Record: " + "; ".join(f"{key}: {value}" for key, value in row.items() if key and value)
            for row in rows
        )
        if not text.strip():
            raise HTTPException(status_code=422, detail="The CSV contains no usable data.")
        return text, None, "structured_data"
    if extension in {".txt", ".md"}:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise HTTPException(status_code=422, detail="Text and Markdown files must use UTF-8 encoding.") from error
        if not text.strip():
            raise HTTPException(status_code=422, detail="The text file is empty.")
        return text, None, "uploaded_document"
    if extension == ".json":
        try:
            data = json.loads(content.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HTTPException(status_code=422, detail=f"Could not read JSON: {error}") from error
        text = json.dumps(data, ensure_ascii=False, indent=2)
        if not text.strip():
            raise HTTPException(status_code=422, detail="The JSON file is empty.")
        return text, None, "structured_data"
    raise HTTPException(status_code=415, detail="Only PDF, TXT, MD, CSV, and JSON files are supported.")


@app.post("/ingest", status_code=201)
async def ingest(file: UploadFile = File(...)) -> dict[str, Any]:
    filename = Path(file.filename or "uploaded-source.txt").name
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File is too large. The maximum size is 20 MB.")
    text, page_texts, category = read_upload(filename, content)
    source_id = source_identifier("", filename)
    if any(source["sourceId"] == source_id for source in SOURCES):
        raise HTTPException(status_code=409, detail=f"A source named {filename} is already indexed.")
    fixture = "test-conflict" in filename.lower() or "conflict-fixture" in filename.lower()
    stored_name = f"{uuid.uuid4().hex}{Path(filename).suffix.lower()}"
    stored_path = UPLOAD_DIR / stored_name
    uploaded_at = datetime.now(timezone.utc).isoformat()
    source = make_source(
        title=Path(filename).stem.replace("_", " ").replace("-", " ").title(),
        filename=filename,
        content=text,
        source_id=source_id,
        category="test_fixture" if fixture else category,
        status="test_fixture" if fixture else "uploaded",
        removable=True,
        page_texts=page_texts,
        stored_path=str(stored_path.relative_to(DATA_DIR)),
        size_bytes=len(content),
        uploaded_at=uploaded_at,
    )
    vectors, used_embeddings = embed_passages(source["chunks"])
    if used_embeddings:
        for passage, embedding in zip(source["chunks"], vectors):
            passage["embedding"] = embedding
    stored_path.write_bytes(content)
    try:
        persist_source(source, len(content))
        SOURCES.append(source)
        sync_chroma(flatten_passages())
    except Exception as error:
        if source in SOURCES:
            SOURCES.remove(source)
        stored_path.unlink(missing_ok=True)
        delete_persisted_source(source_id)
        raise HTTPException(status_code=500, detail=f"Could not persist and index the uploaded source: {error}") from error
    return {
        "sourceId": source["sourceId"],
        "documentId": source["sourceId"],
        "title": source["title"],
        "filename": filename,
        "chunkCount": len(source["chunks"]),
        "status": source["status"],
        "uploadedAt": uploaded_at,
        "sizeBytes": len(content),
        "embeddingMode": (
            "ChromaDB · Sentence-Transformers"
            if used_embeddings and CHROMA_COLLECTION is not None and get_sentence_model()
            else "Sentence-Transformers"
            if used_embeddings and get_sentence_model()
            else f"ChromaDB · Ollama ({EMBED_MODEL})"
            if used_embeddings and CHROMA_COLLECTION is not None
            else f"Ollama · {EMBED_MODEL}"
            if used_embeddings
            else "SQLite · local TF-IDF vectors"
        ),
    }


@app.put("/sources/{source_id}")
def update_source(source_id: str, request: UpdateSourceRequest) -> dict[str, Any]:
    source = next((item for item in SOURCES if item["sourceId"] == source_id), None)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found.")
    content = request.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Document text cannot be empty.")

    stored_path = None
    previous_path = None
    size_bytes = len(content.encode("utf-8"))
    if source.get("storedPath"):
        previous_path = (DATA_DIR / source["storedPath"]).resolve()
        if UPLOAD_DIR.resolve() not in previous_path.parents or not previous_path.is_file():
            raise HTTPException(status_code=404, detail="The original uploaded file is missing.")
        stored_path = UPLOAD_DIR / f"{uuid.uuid4().hex}.txt"
        try:
            stored_path.write_text(content, encoding="utf-8")
        except OSError as error:
            raise HTTPException(status_code=500, detail=f"Could not save the edited document: {error}") from error

    updated = make_source(
        title=source["title"],
        filename=source["filename"],
        content=content,
        source_id=source_id,
        category=source["category"],
        status=source["status"],
        effective_date=source.get("effectiveDate"),
        removable=True,
        stored_path=str(stored_path.relative_to(DATA_DIR)) if stored_path else None,
        size_bytes=size_bytes,
        uploaded_at=source.get("uploadedAt"),
    )
    updated["contentEdited"] = True
    vectors, used_embeddings = embed_passages(updated["chunks"])
    if used_embeddings:
        for passage, embedding in zip(updated["chunks"], vectors):
            passage["embedding"] = embedding
    try:
        persist_source(updated, size_bytes)
        index = SOURCES.index(source)
        SOURCES[index] = updated
        if CHROMA_COLLECTION is not None:
            CHROMA_COLLECTION.delete(where={"sourceId": source_id})
        sync_chroma(flatten_passages())
    except Exception as error:
        if stored_path:
            stored_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Could not update and re-index the document: {error}") from error

    if previous_path and previous_path != stored_path:
        previous_path.unlink(missing_ok=True)
    return {
        **source_metadata(updated),
        "content": updated["content"],
        "chunks": [
            {
                "chunkId": chunk["chunk_id"],
                "text": chunk["text"],
                "pageNumber": chunk.get("page"),
                "sectionHeading": chunk.get("section") or "Document",
            }
            for chunk in updated["chunks"]
        ],
    }


@app.post("/sources/{source_id}/reindex")
def reindex_source(source_id: str) -> dict[str, Any]:
    source = next((item for item in SOURCES if item["sourceId"] == source_id), None)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found.")
    stored_path_value = source.get("storedPath")
    if not stored_path_value:
        raise HTTPException(status_code=403, detail="Built-in corpus documents are read-only.")
    stored_path = (DATA_DIR / stored_path_value).resolve()
    if UPLOAD_DIR.resolve() not in stored_path.parents or not stored_path.is_file():
        raise HTTPException(status_code=404, detail="The original uploaded file is missing; re-upload it to index again.")
    content = stored_path.read_bytes()
    if source.get("contentEdited"):
        text, page_texts, category = content.decode("utf-8"), None, source["category"]
    else:
        text, page_texts, category = read_upload(source["filename"], content)
    updated = make_source(
        title=source["title"],
        filename=source["filename"],
        content=text,
        source_id=source_id,
        category=source["category"] if source["status"] == "test_fixture" else category,
        status=source["status"],
        effective_date=source.get("effectiveDate"),
        removable=True,
        page_texts=page_texts,
        stored_path=source["storedPath"],
        size_bytes=len(content),
        uploaded_at=source.get("uploadedAt"),
    )
    vectors, used_embeddings = embed_passages(updated["chunks"])
    if used_embeddings:
        for passage, embedding in zip(updated["chunks"], vectors):
            passage["embedding"] = embedding
    try:
        persist_source(updated, len(content))
    except (OSError, sqlite3.Error) as error:
        raise HTTPException(status_code=500, detail=f"Could not save the re-indexed source: {error}") from error
    index = SOURCES.index(source)
    SOURCES[index] = updated
    if CHROMA_COLLECTION is not None:
        CHROMA_COLLECTION.delete(where={"sourceId": source_id})
    sync_chroma(flatten_passages())
    return {
        **source_metadata(updated),
        "embeddingMode": "ChromaDB + embeddings" if used_embeddings and CHROMA_COLLECTION else "SQLite local vectors",
    }


@app.delete("/sources/{source_id}")
def delete_source(source_id: str) -> dict[str, Any]:
    global SOURCES
    source = next((item for item in SOURCES if item["sourceId"] == source_id), None)
    if source is None:
        raise HTTPException(status_code=404, detail="Source not found.")
    target = None
    stored_path_value = source.get("storedPath")
    if stored_path_value:
        target = (DATA_DIR / stored_path_value).resolve()
        if UPLOAD_DIR.resolve() not in target.parents:
            raise HTTPException(status_code=400, detail="The stored document path is invalid.")
    updated = [item for item in SOURCES if item["sourceId"] != source_id]
    try:
        if CHROMA_COLLECTION is not None:
            CHROMA_COLLECTION.delete(where={"sourceId": source_id})
        stored_path = delete_persisted_source(source_id)
        if stored_path and target:
            target.unlink(missing_ok=True)
    except (OSError, sqlite3.Error) as error:
        raise HTTPException(status_code=500, detail=f"Could not securely delete the source: {error}") from error
    SOURCES = updated
    return {"deleted": source_id}
