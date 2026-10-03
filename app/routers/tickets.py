import json
import uuid
import datetime
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends
from app.database import db_session
from app.models import TicketResponse, TicketCreate, CustomerResponse, OrderResponse
from app.services.retrieval import check_policy_window_anchor

router = APIRouter(prefix="/tickets", tags=["Tickets"])

def _format_ticket(row, conn) -> TicketResponse:
    t = dict(row)
    cust = None
    order = None

    if t.get("customer_id"):
        c_cur = conn.execute("SELECT * FROM customers WHERE customer_id = ?", (t["customer_id"],))
        c_row = c_cur.fetchone()
        if c_row:
            cust = CustomerResponse(
                customer_id=c_row["customer_id"],
                name=c_row["name"],
                email=c_row["email"],
                tier=c_row["tier"],
                country=c_row["country"],
                created_at=c_row["created_at"],
                verified=bool(c_row["verified"]),
                tags=json.loads(c_row["tags_json"])
            )

    if t.get("order_id"):
        o_cur = conn.execute("SELECT * FROM orders WHERE order_id = ?", (t["order_id"],))
        o_row = o_cur.fetchone()
        if o_row:
            order = OrderResponse(
                order_id=o_row["order_id"],
                customer_id=o_row["customer_id"],
                status=o_row["status"],
                placed_at=o_row["placed_at"],
                delivered_at=o_row["delivered_at"],
                eligible_return_until=o_row["eligible_return_until"],
                total=o_row["total"],
                currency=o_row["currency"],
                payment_status=o_row["payment_status"],
                tracking_number=o_row["tracking_number"],
                items=json.loads(o_row["items_json"])
            )

    return TicketResponse(
        ticket_id=t["ticket_id"],
        customer_id=t["customer_id"],
        order_id=t["order_id"],
        channel=t["channel"],
        subject=t["subject"],
        body=t["body"],
        created_at=t["created_at"],
        status=t["status"],
        expected_category=t.get("expected_category"),
        expected_priority=t.get("expected_priority"),
        expected_sentiment=t.get("expected_sentiment"),
        expected_escalation=bool(t.get("expected_escalation")) if t.get("expected_escalation") is not None else None,
        expected_actions=json.loads(t.get("expected_actions_json", "[]")),
        triage_category=t.get("triage_category"),
        triage_priority=t.get("triage_priority"),
        triage_escalation=bool(t.get("triage_escalation")) if t.get("triage_escalation") is not None else None,
        triage_reason=t.get("triage_reason"),
        customer=cust,
        order=order
    )

@router.get("", response_model=List[TicketResponse])
def list_tickets():
    """List all tickets with linked customer and order context."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM tickets ORDER BY created_at DESC")
        rows = cursor.fetchall()
        return [_format_ticket(r, conn) for r in rows]

@router.get("/{ticket_id}", response_model=TicketResponse)
def get_ticket(ticket_id: str):
    """Fetch ticket by ID with customer, order context, and anchored policy windows."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Ticket '{ticket_id}' not found.")
        return _format_ticket(row, conn)

@router.post("", response_model=TicketResponse, status_code=201)
def create_ticket(ticket_in: TicketCreate):
    """Create a new incoming ticket."""
    ticket_id = f"tkt_{uuid.uuid4().hex[:6]}"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    with db_session() as conn:
        conn.execute(
            """
            INSERT INTO tickets
            (ticket_id, customer_id, order_id, channel, subject, body, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
            """,
            (
                ticket_id,
                ticket_in.customer_id,
                ticket_in.order_id,
                ticket_in.channel,
                ticket_in.subject,
                ticket_in.body,
                now
            )
        )
        cursor = conn.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        row = cursor.fetchone()
        return _format_ticket(row, conn)

@router.post("/{ticket_id}/resolve")
def resolve_ticket(ticket_id: str, payload: Optional[dict] = None):
    """Mark ticket as resolved and record resolution event."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Ticket '{ticket_id}' not found.")
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        conn.execute("UPDATE tickets SET status = 'resolved' WHERE ticket_id = ?", (ticket_id,))
        cursor = conn.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        updated_row = cursor.fetchone()
        return {
            "status": "success",
            "message": f"Ticket {ticket_id} resolved successfully.",
            "ticket": _format_ticket(updated_row, conn),
            "resolved_at": now
        }

@router.post("/{ticket_id}/escalate")
def escalate_ticket(ticket_id: str, payload: Optional[dict] = None):
    """Hand over ticket to human support specialist."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Ticket '{ticket_id}' not found.")
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        reason = payload.get("reason", "Escalated by agent") if payload else "Escalated by agent"
        conn.execute("UPDATE tickets SET status = 'escalated', triage_escalation = 1 WHERE ticket_id = ?", (ticket_id,))
        cursor = conn.execute("SELECT * FROM tickets WHERE ticket_id = ?", (ticket_id,))
        updated_row = cursor.fetchone()
        return {
            "status": "success",
            "message": f"Ticket {ticket_id} escalated to human specialist.",
            "ticket": _format_ticket(updated_row, conn),
            "escalated_at": now,
            "reason": reason
        }
