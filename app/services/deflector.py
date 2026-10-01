import uuid
import datetime
from typing import Dict, Any, Optional
from app.database import db_session
from app.services.retrieval import search_lexical_candidates
from app.services.jev_reranker import jev_reranker
from app.services.guardrails import guardrail_service

class TicketDeflectorService:
    """
    Real-time Knowledge Base search for customer self-service ticket deflection.
    Resolves common inquiries before a ticket enters the queue.
    """

    def check_deflection(self, subject: str, message: str) -> Dict[str, Any]:
        combined = f"{subject} {message}"
        guard_res = guardrail_service.check_input_safety(combined)
        if not guard_res.get("is_safe", True):
            return {
                "deflected": False,
                "instant_solution": None,
                "cited_doc_id": None,
                "confidence": 0.0
            }

        candidates = search_lexical_candidates(combined, limit=4)
        sanitized = guardrail_service.sanitize_retrieved_documents(candidates)
        reranked = jev_reranker.rerank(combined, sanitized, top_k=1)

        if not reranked:
            return {
                "deflected": False,
                "instant_solution": None,
                "cited_doc_id": None,
                "confidence": 0.0
            }

        top_doc = reranked[0]
        score = top_doc.get("jev_score", 0.0)

        # High-confidence threshold for deflection
        if score >= 0.60:
            doc_id = top_doc["doc_id"]
            if doc_id == "KB-REFUND-001":
                solution = (
                    "We noticed you have a question regarding returns or replacements. "
                    "Under our standard policy [KB-REFUND-001], physical items damaged on arrival or defective "
                    "reported within 30 days of delivery qualify for an immediate, no-cost replacement order upon photo verification."
                )
            elif doc_id == "KB-SHIPPING-001":
                solution = (
                    "Regarding delivery tracking: carriers update tracking details within 24-48 hours. "
                    "If tracking shows no movement for more than 5 consecutive business days [KB-SHIPPING-001], "
                    "we will immediately launch an official carrier investigation."
                )
            elif doc_id == "KB-WARRANTY-001":
                solution = (
                    "For hardware warranty inquiries: devices include a 1-year limited warranty [KB-WARRANTY-001]. "
                    "Note: If you are reporting a swollen lithium battery, this is a critical safety issue—discontinue use immediately."
                )
            elif doc_id == "KB-BILLING-001":
                solution = (
                    "For billing or duplicate card charges: duplicate transactions are automatically audited and reversed within 3-5 business days [KB-BILLING-001]."
                )
            else:
                solution = f"According to our knowledge base [{doc_id}], your inquiry can be resolved under our published guidelines."

            deflection_id = f"defl_{uuid.uuid4().hex[:8]}"
            with db_session() as conn:
                conn.execute(
                    """
                    INSERT INTO deflection_events
                    (deflection_id, subject, query, suggested_doc_id, resolved)
                    VALUES (?, ?, ?, ?, 0)
                    """,
                    (deflection_id, subject, combined, doc_id)
                )

            return {
                "deflected": True,
                "deflection_id": deflection_id,
                "instant_solution": solution,
                "cited_doc_id": doc_id,
                "confidence": score
            }

        return {
            "deflected": False,
            "instant_solution": None,
            "cited_doc_id": None,
            "confidence": score
        }

    def record_resolution(self, deflection_id: str, resolved: bool) -> bool:
        with db_session() as conn:
            conn.execute(
                "UPDATE deflection_events SET resolved = ? WHERE deflection_id = ?",
                (int(resolved), deflection_id)
            )
        return True

deflector_service = TicketDeflectorService()
