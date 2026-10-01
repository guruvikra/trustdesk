import uuid
import datetime
from typing import Dict, Any
from fastapi import APIRouter, HTTPException
from app.database import db_session
from app.services.retrieval import search_lexical_candidates
from app.services.jev_reranker import jev_reranker
from app.services.guardrails import guardrail_service
from app.services.ai_adapter import ai_adapter

router = APIRouter(prefix="/webhooks", tags=["Helpdesk Webhooks"])

@router.post("/{source}")
def ingest_helpdesk_webhook(source: str, payload: Dict[str, Any]):
    """
    Ingest incoming webhook from Zendesk, Freshdesk, or Intercom.
    Normalizes payload into TrustDesk ticket schema, triggers automated triage,
    and returns initial grounded recommendation.
    """
    source_lower = source.lower()
    if source_lower not in {"zendesk", "freshdesk", "intercom"}:
        raise HTTPException(status_code=400, detail=f"Unsupported webhook source '{source}'. Supported: zendesk, freshdesk, intercom")

    subject = "Incoming Support Ticket"
    body = "Customer inquiry"
    cust_email = "customer@example.com"
    order_id = None

    if source_lower == "zendesk":
        t_data = payload.get("ticket", {})
        subject = t_data.get("subject", subject)
        body = t_data.get("description", body)
        cust_email = t_data.get("customer_email", cust_email)
        order_id = t_data.get("order_id")
    elif source_lower == "freshdesk":
        t_data = payload.get("freshdesk_webhook", payload)
        subject = t_data.get("ticket_subject", subject)
        body = t_data.get("ticket_description", body)
        cust_email = t_data.get("ticket_requester_email", cust_email)
        order_id = t_data.get("order_id")
    elif source_lower == "intercom":
        item = payload.get("data", {}).get("item", payload)
        body = item.get("conversation_message", {}).get("body", item.get("body", body))
        subject = item.get("subject", "Intercom Live Chat Conversation")
        cust_email = item.get("user", {}).get("email", cust_email)

    ticket_id = f"tkt_{source_lower[:2]}_{uuid.uuid4().hex[:6]}"
    cust_id = f"cus_{uuid.uuid4().hex[:6]}"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    with db_session() as conn:
        # Check or create customer
        c_cur = conn.execute("SELECT customer_id FROM customers WHERE email = ?", (cust_email,))
        c_row = c_cur.fetchone()
        if c_row:
            cust_id = c_row["customer_id"]
        else:
            conn.execute(
                """
                INSERT INTO customers (customer_id, name, email, tier, country, created_at, verified, tags_json)
                VALUES (?, ?, ?, 'standard', 'US', ?, 1, '["webhook_ingested"]')
                """,
                (cust_id, cust_email.split("@")[0].capitalize(), cust_email, now)
            )

        # Insert Ticket
        conn.execute(
            """
            INSERT INTO tickets
            (ticket_id, customer_id, order_id, channel, subject, body, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
            """,
            (ticket_id, cust_id, order_id, source_lower, subject, body, now)
        )

    # Automated Triage & Draft
    combined = f"{subject} {body}"
    guard_res = guardrail_service.check_input_safety(combined)
    candidates = search_lexical_candidates(combined, limit=4)
    sanitized = guardrail_service.sanitize_retrieved_documents(candidates)
    reranked = jev_reranker.rerank(combined, sanitized, top_k=2)

    fake_ticket = {"subject": subject, "body": body}
    triage = ai_adapter.generate_triage(fake_ticket, {"customer_id": cust_id}, None, reranked, guard_res)
    draft = ai_adapter.generate_draft(fake_ticket, {"customer_id": cust_id}, None, reranked, guard_res)

    return {
        "status": "success",
        "source": source_lower,
        "ticket_id": ticket_id,
        "customer_id": cust_id,
        "ingested_at": now,
        "triage": {
            "category": triage["category"],
            "priority": triage["priority"],
            "should_escalate": triage["should_escalate"],
            "reason": triage["reason_summary"]
        },
        "draft": {
            "citations": draft.get("citations", []),
            "preview": draft.get("body", "")[:200] + "..."
        }
    }
