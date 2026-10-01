import json
import uuid
import datetime
from typing import Dict, Any, Optional
from app.database import db_session

class ToolExecutionService:
    """
    Manages tool action requests, idempotency enforcement, and human approval workflow.
    """

    def request_action(
        self,
        ticket_id: str,
        tool_name: str,
        payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Creates or retrieves an existing tool action request using idempotency_key.
        """
        idempotency_key = payload.get("idempotency_key")
        if not idempotency_key:
            raise ValueError("Payload missing required 'idempotency_key' field.")

        with db_session() as conn:
            # Check if this idempotency key was already submitted
            cursor = conn.execute(
                "SELECT * FROM tool_action_requests WHERE idempotency_key = ?",
                (idempotency_key,)
            )
            existing = cursor.fetchone()
            if existing:
                # Return existing action (Idempotent return)
                return self._row_to_dict(existing, is_cached_idempotent=True)

            # Fetch tool specifications from catalog
            cursor = conn.execute(
                "SELECT * FROM tool_action_catalog WHERE tool_name = ?",
                (tool_name,)
            )
            catalog_item = cursor.fetchone()
            if not catalog_item:
                raise ValueError(f"Tool '{tool_name}' not found in tool catalog.")

            required_fields = json.loads(catalog_item["required_fields_json"])
            for field in required_fields:
                if field not in payload:
                    raise ValueError(f"Missing required field '{field}' for tool '{tool_name}'.")

            requires_human_approval = bool(catalog_item["requires_human_approval"])
            risk_level = catalog_item["risk_level"]
            status = "approval_required" if requires_human_approval else "executed"
            action_id = f"act_{uuid.uuid4().hex[:10]}"
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()

            exec_result = None
            exec_time = None
            if not requires_human_approval:
                exec_time = now
                exec_result = json.dumps({
                    "success": True,
                    "message": f"Action '{tool_name}' executed automatically.",
                    "timestamp": now
                })

            conn.execute(
                """
                INSERT INTO tool_action_requests
                (action_id, ticket_id, tool_name, payload_json, risk_level, requires_human_approval, status, idempotency_key, created_at, executed_at, execution_result_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    action_id,
                    ticket_id,
                    tool_name,
                    json.dumps(payload),
                    risk_level,
                    int(requires_human_approval),
                    status,
                    idempotency_key,
                    now,
                    exec_time,
                    exec_result
                )
            )

            # Record agent run trace for tool action
            run_id = f"run_{uuid.uuid4().hex[:8]}"
            conn.execute(
                """
                INSERT INTO agent_runs
                (run_id, ticket_id, run_type, status, tool_calls_json, guardrail_results_json)
                VALUES (?, ?, 'tool_recommendation', ?, ?, '{}')
                """,
                (run_id, ticket_id, status, json.dumps([{"tool_name": tool_name, "idempotency_key": idempotency_key}]))
            )

            cursor = conn.execute("SELECT * FROM tool_action_requests WHERE action_id = ?", (action_id,))
            created_row = cursor.fetchone()
            return self._row_to_dict(created_row, is_cached_idempotent=False)

    def approve_and_execute_action(
        self,
        action_id: str,
        reviewer_id: str,
        decision: str,
        reason: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Human reviewer approves or rejects an approval-gated action.
        """
        if decision not in {"approved", "rejected"}:
            raise ValueError("Decision must be 'approved' or 'rejected'.")

        with db_session() as conn:
            cursor = conn.execute("SELECT * FROM tool_action_requests WHERE action_id = ?", (action_id,))
            action = cursor.fetchone()
            if not action:
                raise ValueError(f"Action '{action_id}' not found.")

            # Record human approval decision in approvals audit table
            appr_id = f"appr_{uuid.uuid4().hex[:8]}"
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            conn.execute(
                """
                INSERT INTO approvals (approval_id, action_id, reviewer_id, decision, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (appr_id, action_id, reviewer_id, decision, reason, now)
            )

            if decision == "approved":
                new_status = "executed"
                exec_result = {
                    "success": True,
                    "message": f"Action '{action['tool_name']}' approved by reviewer '{reviewer_id}' and executed.",
                    "executed_at": now,
                    "idempotency_verified": True
                }
            else:
                new_status = "rejected"
                exec_result = {
                    "success": False,
                    "message": f"Action '{action['tool_name']}' rejected by reviewer '{reviewer_id}'. Reason: {reason or 'None'}",
                    "executed_at": now
                }

            conn.execute(
                """
                UPDATE tool_action_requests
                SET status = ?, executed_at = ?, execution_result_json = ?
                WHERE action_id = ?
                """,
                (new_status, now, json.dumps(exec_result), action_id)
            )

            cursor = conn.execute("SELECT * FROM tool_action_requests WHERE action_id = ?", (action_id,))
            updated_row = cursor.fetchone()
            return self._row_to_dict(updated_row, is_cached_idempotent=False)

    def _row_to_dict(self, row, is_cached_idempotent: bool = False) -> Dict[str, Any]:
        return {
            "action_id": row["action_id"],
            "ticket_id": row["ticket_id"],
            "tool_name": row["tool_name"],
            "payload": json.loads(row["payload_json"]),
            "risk_level": row["risk_level"],
            "requires_human_approval": bool(row["requires_human_approval"]),
            "status": row["status"],
            "idempotency_key": row["idempotency_key"],
            "created_at": row["created_at"],
            "executed_at": row["executed_at"],
            "execution_result": json.loads(row["execution_result_json"]) if row["execution_result_json"] else None,
            "is_cached_idempotent": is_cached_idempotent
        }

tool_service = ToolExecutionService()
