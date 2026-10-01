import uuid
import json
from fastapi import APIRouter, HTTPException
from app.database import db_session
from app.models import TriageResponse
from app.services.retrieval import search_lexical_candidates
from app.services.jev_reranker import jev_reranker
from app.services.guardrails import guardrail_service
from app.services.ai_adapter import ai_adapter

router = APIRouter(prefix="/tickets", tags=["AI Triage"])

@router.post("/{ticket_id}/triage", response_model=TriageResponse)
def triage_ticket(ticket_id: str):
    """
    Triage an incoming ticket: classify category, priority, sentiment,
    and escalation necessity, storing minimal audit trace.
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

        # 1. Pre-execution guardrail check
        combined_text = f"{ticket.get('subject', '')} {ticket.get('body', '')}"
        guardrail_result = guardrail_service.check_input_safety(combined_text)

        # 2. Retrieval + Jev Reranking
        candidates = search_lexical_candidates(combined_text, limit=6)
        sanitized = guardrail_service.sanitize_retrieved_documents(candidates)
        reranked = jev_reranker.rerank(combined_text, sanitized, top_k=3)

        # 3. AI Triage Generation
        triage_out = ai_adapter.generate_triage(ticket, customer, order, reranked, guardrail_result)

        # 4. Update Ticket with Triage Decisions
        conn.execute(
            """
            UPDATE tickets
            SET triage_category = ?, triage_priority = ?, triage_escalation = ?, triage_reason = ?
            WHERE ticket_id = ?
            """,
            (
                triage_out["category"],
                triage_out["priority"],
                int(triage_out["should_escalate"]),
                triage_out["reason_summary"],
                ticket_id
            )
        )

        # 5. Store Minimal Audit Trace
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        doc_ids = [d["doc_id"] for d in reranked]
        conn.execute(
            """
            INSERT INTO agent_runs
            (run_id, ticket_id, run_type, status, retrieved_doc_ids_json, guardrail_results_json, model_name, latency_ms)
            VALUES (?, ?, 'triage', 'completed', ?, ?, ?, ?)
            """,
            (
                run_id,
                ticket_id,
                json.dumps(doc_ids),
                json.dumps(guardrail_result),
                triage_out.get("model_name", "hybrid-engine"),
                triage_out.get("latency_ms", 0)
            )
        )

        return TriageResponse(
            ticket_id=ticket_id,
            category=triage_out["category"],
            priority=triage_out["priority"],
            sentiment=triage_out.get("sentiment", "neutral"),
            should_escalate=triage_out["should_escalate"],
            reason_summary=triage_out["reason_summary"],
            run_id=run_id,
            guardrail_status="PASSED" if guardrail_result.get("is_safe") else "VIOLATIONS_FLAGGED"
        )
