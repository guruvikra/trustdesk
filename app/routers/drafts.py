import uuid
import json
import datetime
from typing import List
from fastapi import APIRouter, HTTPException
from app.database import db_session
from app.models import DraftReplyResponse
from app.services.retrieval import search_lexical_candidates
from app.services.jev_reranker import jev_reranker
from app.services.guardrails import guardrail_service
from app.services.ai_adapter import ai_adapter

router = APIRouter(prefix="/tickets", tags=["Draft Replies"])

@router.post("/{ticket_id}/draft-reply", response_model=DraftReplyResponse)
def generate_draft_reply(ticket_id: str):
    """
    Generate a grounded support draft reply citing knowledge base doc IDs.
    Refuses or escalates unsupported or adversarial requests.
    """
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        ticket_row = cursor.fetchone()
        if not ticket_row:
            raise HTTPException(status_code=404, detail=f"Ticket '{ticket_id}' not found.")

        ticket = dict(ticket_row)
        customer = None
        order = None
        if ticket.get("customer_id"):
            c_cur = conn.execute("SELECT * FROM customers WHERE customer_id = ?", (ticket["customer_id"],))
            c_row = c_cur.fetchone()
            if c_row:
                customer = dict(c_row)
        if ticket.get("order_id"):
            o_cur = conn.execute("SELECT * FROM orders WHERE order_id = ?", (ticket["order_id"],))
            o_row = o_cur.fetchone()
            if o_row:
                order = dict(o_row)

        # 1. Guardrail input check
        combined_text = f"{ticket.get('subject', '')} {ticket.get('body', '')}"
        guardrail_result = guardrail_service.check_input_safety(combined_text)

        # 2. Retrieval + Jev Reranker
        candidates = search_lexical_candidates(combined_text, limit=6)
        sanitized = guardrail_service.sanitize_retrieved_documents(candidates)
        reranked = jev_reranker.rerank(combined_text, sanitized, top_k=3)

        # 3. Generate Draft with Citations
        draft_out = ai_adapter.generate_draft(ticket, customer, order, reranked, guardrail_result)

        # 4. Post-execution guardrail check
        safe_body, was_scrubbed = guardrail_service.sanitize_output(draft_out["body"])

        # 5. Store Draft in DB
        draft_id = f"dft_{uuid.uuid4().hex[:8]}"
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        conn.execute(
            """
            INSERT INTO draft_replies
            (draft_id, ticket_id, status, body, citations_json, recommended_actions_json, created_at)
            VALUES (?, ?, 'generated', ?, ?, ?, ?)
            """,
            (
                draft_id,
                ticket_id,
                safe_body,
                json.dumps(draft_out.get("citations", [])),
                json.dumps(draft_out.get("recommended_actions", [])),
                now
            )
        )

        # 6. Store Minimal Audit Trace
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        doc_ids = [d["doc_id"] for d in reranked]
        conn.execute(
            """
            INSERT INTO agent_runs
            (run_id, ticket_id, run_type, status, retrieved_doc_ids_json, tool_calls_json, guardrail_results_json, model_name, latency_ms)
            VALUES (?, ?, 'draft_reply', 'completed', ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                ticket_id,
                json.dumps(doc_ids),
                json.dumps(draft_out.get("recommended_actions", [])),
                json.dumps(guardrail_result),
                draft_out.get("model_name", "hybrid-engine"),
                draft_out.get("latency_ms", 0)
            )
        )

        return DraftReplyResponse(
            draft_id=draft_id,
            ticket_id=ticket_id,
            status="generated",
            body=safe_body,
            citations=draft_out.get("citations", []),
            recommended_actions=draft_out.get("recommended_actions", []),
            run_id=run_id
        )

@router.get("/{ticket_id}/drafts", response_model=List[DraftReplyResponse])
def list_drafts_for_ticket(ticket_id: str):
    """List all generated drafts for a ticket."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM draft_replies WHERE ticket_id = ? ORDER BY created_at DESC", (ticket_id,))
        rows = cursor.fetchall()
        return [
            DraftReplyResponse(
                draft_id=r["draft_id"],
                ticket_id=r["ticket_id"],
                status=r["status"],
                body=r["body"],
                citations=json.loads(r["citations_json"]),
                recommended_actions=json.loads(r["recommended_actions_json"]),
                run_id="run_history"
            )
            for r in rows
        ]
