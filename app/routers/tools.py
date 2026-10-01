import json
from typing import List, Dict, Any
from fastapi import APIRouter, HTTPException
from app.database import db_session
from app.models import ToolActionRequestCreate, ToolActionResponse, ApprovalRequest
from app.services.tools import tool_service

router = APIRouter(prefix="/tool-actions", tags=["Tool Actions"])

@router.post("", response_model=ToolActionResponse, status_code=201)
def request_tool_action(action_in: ToolActionRequestCreate):
    """
    Request execution of a tool action from catalog.
    Enforces idempotency key uniqueness and approval gating.
    """
    try:
        res = tool_service.request_action(
            ticket_id=action_in.ticket_id,
            tool_name=action_in.tool_name,
            payload=action_in.payload
        )
        return ToolActionResponse(**res)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/{action_id}/approve", response_model=ToolActionResponse)
def approve_or_reject_tool_action(action_id: str, approval_in: ApprovalRequest):
    """
    Human reviewer approves or rejects an approval-gated tool action.
    """
    try:
        res = tool_service.approve_and_execute_action(
            action_id=action_id,
            reviewer_id=approval_in.reviewer_id,
            decision=approval_in.decision,
            reason=approval_in.reason
        )
        return ToolActionResponse(**res)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/{action_id}", response_model=ToolActionResponse)
def get_tool_action(action_id: str):
    """Fetch tool action by ID."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM tool_action_requests WHERE action_id = ?", (action_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Action '{action_id}' not found.")
        return ToolActionResponse(**tool_service._row_to_dict(row))

@router.get("/ticket/{ticket_id}", response_model=List[ToolActionResponse])
def list_tool_actions_for_ticket(ticket_id: str):
    """List all tool actions associated with a ticket."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM tool_action_requests WHERE ticket_id = ? ORDER BY created_at DESC", (ticket_id,))
        rows = cursor.fetchall()
        return [ToolActionResponse(**tool_service._row_to_dict(r)) for r in rows]
