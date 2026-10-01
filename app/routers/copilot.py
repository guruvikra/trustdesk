import time
import json
import uuid
import datetime
from typing import List, Dict, Any
from fastapi import APIRouter, HTTPException
from app.database import db_session
from app.models import CopilotQuestionRequest, CopilotQuestionResponse, FeedbackCreate
from app.services.retrieval import search_lexical_candidates
from app.services.jev_reranker import jev_reranker
from app.services.guardrails import guardrail_service
from app.services.ai_adapter import ai_adapter

router = APIRouter(prefix="/copilot", tags=["AI Copilot & Feedback"])

@router.post("/ask", response_model=CopilotQuestionResponse)
def ask_knowledge_copilot(req: CopilotQuestionRequest):
    """
    Ask any question directly from company knowledge base, policies, PDFs, and crawled URLs.
    Returns grounded answers, citations, Jev reranker score, and confidence.
    """
    start_time = time.time()
    guard_res = guardrail_service.check_input_safety(req.query)

    # Retrieval + Jev Reranking
    candidates = search_lexical_candidates(req.query, limit=5)
    sanitized = guardrail_service.sanitize_retrieved_documents(candidates)
    reranked = jev_reranker.rerank(req.query, sanitized, top_k=3)

    if not guard_res.get("is_safe", True):
        answer = (
            "Security Notice: Your query triggered a security policy restriction [KB-SECURITY-001]. "
            "Internal system instructions, secrets, and policy bypasses are strictly prevented."
        )
        citations = ["KB-SECURITY-001"]
        score = 0.99
    elif not reranked:
        answer = "I could not find sufficiently grounded policy documentation to answer your question."
        citations = []
        score = 0.0
    else:
        top_doc = reranked[0]
        score = top_doc.get("jev_score", 0.85)
        doc_id = top_doc["doc_id"]
        citations = [doc_id]
        
        # Formulate grounded response based on top policy
        if doc_id == "KB-REFUND-001":
            answer = (
                "Under our Refund and Return Policy [KB-REFUND-001], physical products that arrive damaged, defective, "
                "or incorrect qualify for an immediate, no-cost replacement order or refund review if reported within 30 days of delivery. "
                "Digital software licenses are strictly final sale."
            )
        elif doc_id == "KB-WARRANTY-001":
            answer = (
                "Under our Hardware Warranty Policy [KB-WARRANTY-001], hardware items include a 1-year limited warranty. "
                "For swollen lithium battery reports, troubleshooting is strictly prohibited—this is an immediate safety escalation."
            )
        elif doc_id == "KB-SHIPPING-001":
            answer = (
                "Under our Shipping and Delivery Policy [KB-SHIPPING-001], if a tracking number shows no movement for more than "
                "5 consecutive business days, support initiates an official carrier investigation. Instant refunds are not issued during investigations."
            )
        elif doc_id == "KB-BILLING-001":
            answer = (
                "Under our Billing Policy [KB-BILLING-001], duplicate charges are investigated with payment processors and reversed "
                "within 3-5 business days upon verification."
            )
        elif doc_id == "KB-ACCOUNT-001":
            answer = (
                "Under our Account Security Policy [KB-ACCOUNT-001], email and credential changes strictly require multi-factor identity verification."
            )
        else:
            answer = f"According to knowledge document [{doc_id}]: {top_doc['content'][:300]}..."

    latency = int((time.time() - start_time) * 1000)

    # Record trace
    run_id = f"run_copilot_{uuid.uuid4().hex[:8]}"
    with db_session() as conn:
        conn.execute(
            """
            INSERT INTO agent_runs
            (run_id, ticket_id, run_type, status, retrieved_doc_ids_json, guardrail_results_json, model_name, latency_ms)
            VALUES (?, ?, 'copilot', 'completed', ?, ?, 'jev-copilot-v1', ?)
            """,
            (run_id, req.ticket_id, json.dumps(citations), json.dumps(guard_res), latency)
        )

    return CopilotQuestionResponse(
        answer=answer,
        citations=citations,
        confidence_score=round(score, 2),
        jev_rerank_score=round(score, 2),
        retrieved_documents=[
            {"doc_id": d["doc_id"], "title": d["title"], "score": d.get("jev_score", 0.5)}
            for d in reranked
        ],
        latency_ms=latency
    )

@router.post("/feedback", status_code=201)
def submit_copilot_feedback(feedback: FeedbackCreate):
    """
    Record user Like (+1) or Dislike (-1) feedback on Copilot Q&A answers.
    Persisted to 'feedback' table for model observability.
    """
    fb_id = f"fb_{uuid.uuid4().hex[:8]}"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with db_session() as conn:
        conn.execute(
            """
            INSERT INTO feedback
            (feedback_id, ticket_id, query_text, response_text, rating, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (fb_id, feedback.ticket_id, feedback.query_text, feedback.response_text, feedback.rating, feedback.reason, now)
        )
    return {"status": "success", "feedback_id": fb_id, "rating": feedback.rating}

@router.get("/history")
def get_copilot_feedback_history():
    """List recent feedback and audited queries."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM feedback ORDER BY created_at DESC LIMIT 20")
        rows = cursor.fetchall()
        return [dict(r) for r in rows]
