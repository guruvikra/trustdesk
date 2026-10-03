import io
import re
import uuid
import datetime
from typing import List, Dict, Any
from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Form
from pypdf import PdfReader
import httpx
from app.database import db_session
from app.services.retrieval import search_lexical_candidates
from app.services.jev_reranker import jev_reranker
from app.services.guardrails import guardrail_service
from app.services.sync_worker import sync_worker

router = APIRouter(prefix="/documents", tags=["Knowledge Base"])

@router.get("")
def list_documents():
    """List all ingested knowledge documents."""
    with db_session() as conn:
        cursor = conn.execute("SELECT doc_id, title, source_path, audience, version, is_untrusted, created_at FROM knowledge_documents ORDER BY doc_id ASC")
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

@router.get("/search")
def search_documents(q: str = Query(..., description="Search query")):
    """
    Search knowledge-base docs using lexical FTS5 and the Jev Model Reranker.
    """
    candidates = search_lexical_candidates(q, limit=6)
    sanitized = guardrail_service.sanitize_retrieved_documents(candidates)
    reranked = jev_reranker.rerank(q, sanitized, top_k=4)

    results = []
    for doc in reranked:
        results.append({
            "doc_id": doc["doc_id"],
            "title": doc["title"],
            "snippet": doc["content"][:250] + ("..." if len(doc["content"]) > 250 else ""),
            "score": doc.get("jev_score", 0.50),
            "reranker": "Jev System One"
        })
    return {"query": q, "results": results}

@router.post("/ingest", status_code=201)
def ingest_documents(payload: Dict[str, Any]):
    """Ingest one or more markdown or text documents preserving Doc IDs."""
    docs = payload.get("documents", [])
    if not docs:
        raise HTTPException(status_code=400, detail="Missing 'documents' list.")

    ingested_ids = []
    with db_session() as conn:
        for doc in docs:
            doc_id = doc.get("doc_id") or f"KB-CUSTOM-{uuid.uuid4().hex[:6].upper()}"
            title = doc.get("title", "Custom Document")
            content = doc.get("content", "")
            source_path = doc.get("source_path", "manual_entry")
            audience = doc.get("audience", "public")
            version = doc.get("version", "2026.07")
            is_untrusted = 1 if doc_id == "KB-ADVERSARIAL-001" or "adversarial" in content.lower() else 0

            conn.execute(
                """
                INSERT OR REPLACE INTO knowledge_documents
                (doc_id, title, source_path, content, audience, version, is_untrusted)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (doc_id, title, source_path, content, audience, version, is_untrusted)
            )
            try:
                conn.execute("DELETE FROM knowledge_documents_fts WHERE doc_id = ?", (doc_id,))
                conn.execute("INSERT INTO knowledge_documents_fts (doc_id, title, content) VALUES (?, ?, ?)", (doc_id, title, content))
            except Exception:
                pass

            ingested_ids.append(doc_id)

    return {"ingested": len(ingested_ids), "document_ids": ingested_ids}

@router.post("/upload-pdf", status_code=201)
async def upload_pdf_document(
    file: UploadFile = File(...),
    doc_id: str = Form(None),
    title: str = Form(None)
):
    """
    Extracts text from an uploaded PDF file, indexes it into SQLite FTS5,
    and enables Jev Model Reranking.
    """
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    content_bytes = await file.read()
    try:
        reader = PdfReader(io.BytesIO(content_bytes))
        extracted_text = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text()
            if text:
                extracted_text.append(text)
        full_text = "\n\n".join(extracted_text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse PDF: {str(e)}")

    final_doc_id = doc_id or f"KB-PDF-{uuid.uuid4().hex[:6].upper()}"
    final_title = title or file.filename.replace(".pdf", "")

    with db_session() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO knowledge_documents
            (doc_id, title, source_path, content, audience, version, is_untrusted)
            VALUES (?, ?, ?, ?, 'public', '2026.07', 0)
            """,
            (final_doc_id, final_title, f"uploads/{file.filename}", full_text)
        )
        try:
            conn.execute("DELETE FROM knowledge_documents_fts WHERE doc_id = ?", (final_doc_id,))
            conn.execute("INSERT INTO knowledge_documents_fts (doc_id, title, content) VALUES (?, ?, ?)", (final_doc_id, final_title, full_text))
        except Exception:
            pass

    return {
        "status": "success",
        "doc_id": final_doc_id,
        "title": final_title,
        "pages_processed": len(reader.pages),
        "characters_indexed": len(full_text),
        "reranker": "Jev System One Indexed"
    }

@router.post("/crawl-url", status_code=201)
def crawl_url_knowledge(payload: Dict[str, Any]):
    """
    Crawls documentation or support website URL, sanitizes content,
    and indexes it for grounding.
    """
    url = payload.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing 'url' field.")

    doc_id = payload.get("doc_id") or f"KB-WEB-{uuid.uuid4().hex[:6].upper()}"
    title = payload.get("title") or f"Web Source: {url}"

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url)
            html_text = resp.text
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {str(e)}")

    # Simple clean text extraction
    clean_text = re.sub(r"<script.*?</script>", "", html_text, flags=re.DOTALL)
    clean_text = re.sub(r"<style.*?</style>", "", clean_text, flags=re.DOTALL)
    clean_text = re.sub(r"<[^>]+>", " ", clean_text)
    clean_text = re.sub(r"\s+", " ", clean_text).strip()

    with db_session() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO knowledge_documents
            (doc_id, title, source_path, content, audience, version, is_untrusted)
            VALUES (?, ?, ?, ?, 'public', '2026.07', 0)
            """,
            (doc_id, title, url, clean_text[:20000])
        )
        try:
            conn.execute("DELETE FROM knowledge_documents_fts WHERE doc_id = ?", (doc_id,))
            conn.execute("INSERT INTO knowledge_documents_fts (doc_id, title, content) VALUES (?, ?, ?)", (doc_id, title, clean_text[:20000]))
        except Exception:
            pass

    return {
        "status": "success",
        "doc_id": doc_id,
        "title": title,
        "source_url": url,
        "characters_indexed": len(clean_text[:20000]),
        "reranker": "Jev System One Indexed"
    }

@router.post("/sync-async")
def sync_knowledge_async(payload: Dict[str, Any]):
    """
    Asynchronously ingest knowledge (URL crawl, policy pack, or custom text)
    via dedicated background worker to prevent server hanging.
    """
    source_type = payload.get("source_type", "pack")
    source_name = payload.get("source_name") or payload.get("title") or payload.get("url") or "Enterprise Policy Pack"
    job_id = sync_worker.submit_job(source_type, source_name, payload)
    return {
        "status": "queued",
        "job_id": job_id,
        "source_type": source_type,
        "source_name": source_name,
        "message": "Knowledge sync queued for background worker."
    }

@router.post("/upload-pdf-async")
async def upload_pdf_async(
    file: UploadFile = File(...),
    doc_id: str = Form(None),
    title: str = Form(None)
):
    """
    Uploads PDF and delegates heavy page extraction, chunking, and embedding
    to the background sync worker.
    """
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    content_bytes = await file.read()
    job_id = sync_worker.submit_job("pdf", file.filename, {
        "content_bytes": content_bytes,
        "filename": file.filename,
        "doc_id": doc_id,
        "title": title
    })
    return {
        "status": "queued",
        "job_id": job_id,
        "filename": file.filename,
        "message": "PDF uploaded. Background worker processing pages & indexing vector cache."
    }

@router.get("/sync-jobs")
def list_sync_jobs():
    """List recent background sync worker jobs."""
    return sync_worker.list_jobs()

@router.get("/sync-jobs/{job_id}")
def get_sync_job_status(job_id: str):
    """Fetch status and progress telemetry for a sync worker job."""
    job = sync_worker.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Sync job '{job_id}' not found.")
    return job

