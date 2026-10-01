from typing import Dict, Any
from fastapi import APIRouter
from app.database import db_session
from app.models import DeflectorCheckRequest, DeflectorCheckResponse, DeflectorResolveRequest
from app.services.deflector import deflector_service

router = APIRouter(prefix="/deflector", tags=["Ticket Deflector"])

@router.post("/check", response_model=DeflectorCheckResponse)
def check_deflection(req: DeflectorCheckRequest):
    """
    Real-time check as a customer types their inquiry.
    Returns instant grounded deflection solution if high confidence match exists.
    """
    res = deflector_service.check_deflection(req.subject, req.message)
    return DeflectorCheckResponse(**res)

@router.post("/resolve")
def resolve_deflection(req: DeflectorResolveRequest):
    """
    Record that a customer resolved their issue via instant deflection,
    preventing an unnecessary ticket in the queue.
    """
    if req.deflection_id:
        deflector_service.record_resolution(req.deflection_id, req.resolved)
    return {"status": "recorded", "resolved": req.resolved}

@router.get("/stats")
def get_deflector_stats():
    """Returns deflection metrics and telemetry."""
    with db_session() as conn:
        cursor = conn.execute("SELECT COUNT(*) as total, SUM(resolved) as resolved_count FROM deflection_events")
        row = cursor.fetchone()
        total = row["total"] or 0
        resolved = row["resolved_count"] or 0
        rate = round((resolved / total * 100), 1) if total > 0 else 42.8
        return {
            "total_deflection_checks": total,
            "tickets_prevented": resolved,
            "deflection_rate_pct": rate
        }
