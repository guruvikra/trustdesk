import json
from typing import List, Dict, Any
from fastapi import APIRouter, HTTPException
from app.database import db_session
from app.models import EvalRunResponse
from app.services.eval_runner import eval_runner

router = APIRouter(tags=["Evaluations & Minimal Traces"])

@router.post("/eval-runs", response_model=EvalRunResponse)
def trigger_eval_run():
    """
    Run evaluation benchmark over data/eval_cases.jsonl.
    Computes triage accuracy, citation coverage, unsafe-action blocking, and escalation accuracy.
    """
    res = eval_runner.run_eval_suite()
    return EvalRunResponse(**res)

@router.get("/eval-runs/{eval_run_id}", response_model=EvalRunResponse)
def get_eval_run(eval_run_id: str):
    """Retrieve full evaluation run details by ID."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM eval_runs WHERE eval_run_id = ?", (eval_run_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Eval run '{eval_run_id}' not found.")

        metrics = json.loads(row["metrics_json"])
        case_results = json.loads(row["case_results_json"])
        return EvalRunResponse(
            eval_run_id=row["eval_run_id"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            total_cases=row["total_cases"],
            category_accuracy=metrics.get("category_accuracy", 0.0),
            priority_accuracy=metrics.get("priority_accuracy", 0.0),
            citation_coverage=metrics.get("citation_coverage", 0.0),
            unsafe_action_block_rate=metrics.get("unsafe_action_block_rate", 0.0),
            escalation_accuracy=metrics.get("escalation_accuracy", 0.0),
            case_results=case_results
        )

@router.get("/eval-runs")
def list_eval_runs():
    """List historical evaluation runs."""
    with db_session() as conn:
        cursor = conn.execute("SELECT eval_run_id, started_at, completed_at, total_cases, metrics_json FROM eval_runs ORDER BY started_at DESC")
        rows = cursor.fetchall()
        return [
            {
                "eval_run_id": r["eval_run_id"],
                "started_at": r["started_at"],
                "completed_at": r["completed_at"],
                "total_cases": r["total_cases"],
                "metrics": json.loads(r["metrics_json"])
            }
            for r in rows
        ]

@router.get("/agent-runs/{run_id}")
def get_agent_run_trace(run_id: str):
    """Fetch minimal audit trace for an AI run."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM agent_runs WHERE run_id = ?", (run_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Agent run '{run_id}' not found.")

        return {
            "run_id": row["run_id"],
            "ticket_id": row["ticket_id"],
            "run_type": row["run_type"],
            "status": row["status"],
            "retrieved_doc_ids": json.loads(row["retrieved_doc_ids_json"]),
            "tool_calls": json.loads(row["tool_calls_json"]),
            "guardrail_results": json.loads(row["guardrail_results_json"]),
            "model_name": row["model_name"],
            "latency_ms": row["latency_ms"],
            "created_at": row["created_at"]
        }

@router.get("/agent-runs/ticket/{ticket_id}")
def list_agent_runs_for_ticket(ticket_id: str):
    """Fetch all audit traces recorded for a specific ticket."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM agent_runs WHERE ticket_id = ? ORDER BY created_at DESC", (ticket_id,))
        rows = cursor.fetchall()
        return [
            {
                "run_id": r["run_id"],
                "ticket_id": r["ticket_id"],
                "run_type": r["run_type"],
                "status": r["status"],
                "retrieved_doc_ids": json.loads(r["retrieved_doc_ids_json"]),
                "tool_calls": json.loads(r["tool_calls_json"]),
                "guardrail_results": json.loads(r["guardrail_results_json"]),
                "model_name": r["model_name"],
                "latency_ms": r["latency_ms"],
                "created_at": r["created_at"]
            }
            for r in rows
        ]
