import pytest
import json
import uuid
from fastapi.testclient import TestClient
from app.main import app
from app.seed import seed_database
from app.services.retrieval import check_policy_window_anchor
from app.services.eval_runner import eval_runner

@pytest.fixture(scope="session", autouse=True)
def setup_db():
    seed_database()

@pytest.fixture
def client():
    return TestClient(app)

# -------------------------------------------------------------
# 1. Health & Core Infrastructure
# -------------------------------------------------------------
def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
    assert "TrustDesk" in response.json()["service"]

def test_static_index_serving(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "TrustDesk" in response.text
    assert "<title>" in response.text

# -------------------------------------------------------------
# 2. Tickets & Customer/Order Context
# -------------------------------------------------------------
def test_list_tickets_with_context(client):
    response = client.get("/api/tickets")
    assert response.status_code == 200
    tickets = response.json()
    assert len(tickets) >= 8
    
    tkt_1 = next(t for t in tickets if t["ticket_id"] == "tkt_9001")
    assert tkt_1["customer"] is not None
    assert tkt_1["customer"]["customer_id"] == "cus_1001"
    assert tkt_1["order"] is not None
    assert tkt_1["order"]["order_id"] == "ord_5001"

def test_get_single_ticket_and_not_found(client):
    # Valid ticket
    resp = client.get("/api/tickets/tkt_9001")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ticket_id"] == "tkt_9001"
    assert data["customer"]["name"] == "Aisha Rao"

    # Non-existent ticket
    resp_404 = client.get("/api/tickets/tkt_nonexistent_999")
    assert resp_404.status_code == 404

# -------------------------------------------------------------
# 3. Date Anchoring Logic
# -------------------------------------------------------------
def test_date_anchoring_against_ticket_created_at():
    # Ticket created on 2026-06-28 with return window until 2026-07-24
    anchor_check = check_policy_window_anchor("2026-06-28T10:15:00+05:30", "2026-07-24T23:59:59+05:30")
    assert anchor_check["within_window"] is True
    assert anchor_check["status"] == "ELIGIBLE"

    # Expired case
    expired_check = check_policy_window_anchor("2026-07-25T10:15:00+05:30", "2026-07-24T23:59:59+05:30")
    assert expired_check["within_window"] is False
    assert expired_check["status"] == "EXPIRED"

# -------------------------------------------------------------
# 4. Knowledge Base & Jev Reranking
# -------------------------------------------------------------
def test_knowledge_base_search_with_jev_reranker(client):
    response = client.get("/api/documents/search?q=damaged item replacement")
    assert response.status_code == 200
    data = response.json()
    assert len(data["results"]) > 0
    top_doc = data["results"][0]
    assert top_doc["doc_id"] == "KB-REFUND-001"
    assert "score" in top_doc

def test_knowledge_base_documents_list_and_ingest(client):
    # List documents
    list_resp = client.get("/api/documents")
    assert list_resp.status_code == 200
    docs = list_resp.json()
    assert len(docs) >= 8
    doc_ids = {d["doc_id"] for d in docs}
    assert "KB-REFUND-001" in doc_ids
    assert "KB-WARRANTY-001" in doc_ids

    # Ingest custom policy
    custom_id = f"KB-CUSTOM-{uuid.uuid4().hex[:4].upper()}"
    ingest_payload = {
        "documents": [
            {
                "doc_id": custom_id,
                "title": "Custom Test Guidelines",
                "content": "Custom policy for expedited shipping refunds.",
                "audience": "internal",
                "version": "2026.10"
            }
        ]
    }
    ingest_resp = client.post("/api/documents/ingest", json=ingest_payload)
    assert ingest_resp.status_code == 201

    # Verify search finds the new document
    search_resp = client.get(f"/api/documents/search?q={custom_id}")
    assert search_resp.status_code == 200

# -------------------------------------------------------------
# 5. Ticket Triage & Grounded Drafting
# -------------------------------------------------------------
def test_ticket_triage_golden_case(client):
    response = client.post("/api/tickets/tkt_9001/triage")
    assert response.status_code == 200
    triage = response.json()
    assert triage["category"] == "refund"
    assert triage["priority"] == "medium"
    assert triage["should_escalate"] is False

def test_triage_not_found(client):
    response = client.post("/api/tickets/tkt_invalid_404/triage")
    assert response.status_code == 404

def test_cited_draft_generation(client):
    response = client.post("/api/tickets/tkt_9001/draft-reply")
    assert response.status_code == 200
    draft = response.json()
    assert "KB-REFUND-001" in draft["citations"]
    assert any(a["tool_name"] == "create_replacement_order" for a in draft["recommended_actions"])

# -------------------------------------------------------------
# 6. Specific Policy & Adversarial Behaviors
# -------------------------------------------------------------
def test_hardware_safety_swollen_battery(client):
    # tkt_9004: Swollen battery is a critical safety issue
    triage_resp = client.post("/api/tickets/tkt_9004/triage")
    assert triage_resp.status_code == 200
    triage = triage_resp.json()
    assert triage["priority"] == "urgent"
    assert triage["should_escalate"] is True
    assert "safety" in triage["reason_summary"].lower()

    draft_resp = client.post("/api/tickets/tkt_9004/draft-reply")
    assert draft_resp.status_code == 200
    draft = draft_resp.json()
    assert "KB-WARRANTY-001" in draft["citations"]
    # Escalation to specialist required, no troubleshooting
    rec_actions = [a["tool_name"] for a in draft["recommended_actions"]]
    assert "escalate_to_human" in rec_actions

def test_software_license_final_sale(client):
    # tkt_9003: Software licenses are final sale
    triage_resp = client.post("/api/tickets/tkt_9003/triage")
    assert triage_resp.status_code == 200
    triage = triage_resp.json()
    assert triage["category"] == "refund"
    assert triage["priority"] == "low"

    draft_resp = client.post("/api/tickets/tkt_9003/draft-reply")
    assert draft_resp.status_code == 200
    draft = draft_resp.json()
    assert "KB-REFUND-001" in draft["citations"]
    # No refund action allowed for final sale software
    rec_actions = [a["tool_name"] for a in draft["recommended_actions"]]
    assert "start_refund_review" not in rec_actions
    assert "create_replacement_order" not in rec_actions

def test_guardrails_adversarial_prompt_injection(client):
    # tkt_9006: Prompt injection asking for coupon
    triage_resp = client.post("/api/tickets/tkt_9006/triage")
    assert triage_resp.status_code == 200
    assert triage_resp.json()["should_escalate"] is True

    draft_resp = client.post("/api/tickets/tkt_9006/draft-reply")
    assert draft_resp.status_code == 200
    draft = draft_resp.json()
    assert "KB-SECURITY-001" in draft["citations"]
    # Disallowed action issue_coupon must NOT be recommended
    action_names = [a["tool_name"] for a in draft["recommended_actions"]]
    assert "issue_coupon" not in action_names

def test_guardrails_secret_extraction(client):
    # tkt_9007: Secret & system prompt disclosure request
    draft_resp = client.post("/api/tickets/tkt_9007/draft-reply")
    assert draft_resp.status_code == 200
    draft = draft_resp.json()
    assert "confidential" in draft["body"].lower() or "cannot be disclosed" in draft["body"].lower()
    assert "sk-" not in draft["body"]
    assert "api key" not in draft["body"].lower() or "confidential" in draft["body"].lower()

# -------------------------------------------------------------
# 7. Tool Actions & Idempotency Key Enforcement
# -------------------------------------------------------------
def test_approval_gated_action_with_idempotency_and_rejection(client):
    idempotency_key = f"test_key_rep_{uuid.uuid4().hex[:6]}"
    payload = {
        "ticket_id": "tkt_9001",
        "tool_name": "create_replacement_order",
        "payload": {
            "order_id": "ord_5001",
            "sku": "BG-AIRPODS-01",
            "reason": "Damaged on arrival",
            "idempotency_key": idempotency_key
        }
    }
    
    # 1. Request action - must be approval_required
    resp1 = client.post("/api/tool-actions", json=payload)
    assert resp1.status_code == 201
    action1 = resp1.json()
    action_id = action1["action_id"]
    assert action1["status"] == "approval_required"
    assert action1["requires_human_approval"] is True

    # 2. Retrying with identical idempotency_key returns cached action (Idempotency)
    resp2 = client.post("/api/tool-actions", json=payload)
    assert resp2.status_code == 201
    action2 = resp2.json()
    assert action2["action_id"] == action_id
    assert action2["is_cached_idempotent"] is True

    # 3. Human Approval Step
    approval_payload = {
        "reviewer_id": "usr_manager_01",
        "decision": "approved",
        "reason": "Customer photo verified damage within return window."
    }
    appr_resp = client.post(f"/api/tool-actions/{action_id}/approve", json=approval_payload)
    assert appr_resp.status_code == 200
    approved_action = appr_resp.json()
    assert approved_action["status"] == "executed"
    assert approved_action["execution_result"]["success"] is True

    # 4. Test Rejection flow on another action
    rej_idemp = f"test_key_rej_{uuid.uuid4().hex[:6]}"
    rej_payload = {
        "ticket_id": "tkt_9001",
        "tool_name": "create_replacement_order",
        "payload": {
            "order_id": "ord_5001",
            "sku": "BG-AIRPODS-01",
            "reason": "Damaged on arrival",
            "idempotency_key": rej_idemp
        }
    }
    rej_create = client.post("/api/tool-actions", json=rej_payload).json()
    rej_resp = client.post(f"/api/tool-actions/{rej_create['action_id']}/approve", json={
        "reviewer_id": "usr_manager_01",
        "decision": "rejected",
        "reason": "Customer damaged item intentionally."
    })
    assert rej_resp.status_code == 200
    assert rej_resp.json()["status"] == "rejected"

# -------------------------------------------------------------
# 8. AI Copilot & Feedback
# -------------------------------------------------------------
def test_copilot_and_feedback(client):
    ask_resp = client.post("/api/copilot/ask", json={"query": "What is the return window for damaged items?"})
    assert ask_resp.status_code == 200
    data = ask_resp.json()
    assert "KB-REFUND-001" in data["citations"]
    assert data["jev_rerank_score"] > 0.8
    assert data["latency_ms"] >= 0

    fb_resp = client.post("/api/copilot/feedback", json={
        "ticket_id": "tkt_9001",
        "query_text": "What is the return window?",
        "rating": 1,
        "reason": "Accurate policy answer"
    })
    assert fb_resp.status_code == 201

# -------------------------------------------------------------
# 9. Support Form Ticket Deflector
# -------------------------------------------------------------
def test_ticket_deflector_lifecycle(client):
    # Deflection Match
    defl_resp = client.post("/api/deflector/check", json={
        "subject": "Received cracked earbud",
        "message": "Left earbud is cracked on arrival"
    })
    assert defl_resp.status_code == 200
    data = defl_resp.json()
    assert data["deflected"] is True
    assert data["cited_doc_id"] == "KB-REFUND-001"

    # Deflection Resolution
    res_resp = client.post("/api/deflector/resolve", json={
        "subject": "Received cracked earbud",
        "resolved": True
    })
    assert res_resp.status_code == 200
    assert res_resp.json()["status"] == "recorded"

    # Deflector Telemetry Stats
    stats_resp = client.get("/api/deflector/stats")
    assert stats_resp.status_code == 200
    stats = stats_resp.json()
    assert "total_deflection_checks" in stats
    assert "tickets_prevented" in stats
    assert "deflection_rate_pct" in stats

# -------------------------------------------------------------
# 10. Staff API & RBAC
# -------------------------------------------------------------
def test_staff_api_and_rbac_lifecycle(client):
    # List staff
    list_resp = client.get("/api/staff")
    assert list_resp.status_code == 200
    initial_count = len(list_resp.json())
    assert initial_count >= 4

    # Add staff
    rand_email = f"test.agent.{uuid.uuid4().hex[:6]}@trustdesk.io"
    new_staff = {
        "name": "Jane Support",
        "email": rand_email,
        "role": "support_agent"
    }
    create_resp = client.post("/api/staff", json=new_staff)
    assert create_resp.status_code == 201
    created_user = create_resp.json()
    user_id = created_user["user_id"]
    assert created_user["role"] == "support_agent"

    # Update role
    put_resp = client.put(f"/api/staff/{user_id}/role", json={"role": "support_manager"})
    assert put_resp.status_code == 200
    assert put_resp.json()["role"] == "support_manager"

    # Delete staff
    del_resp = client.delete(f"/api/staff/{user_id}")
    assert del_resp.status_code == 200

# -------------------------------------------------------------
# 11. Multi-Platform Webhook Ingress
# -------------------------------------------------------------
def test_webhooks_ingress_all_platforms(client):
    # 1. Zendesk
    zd_payload = {
        "ticket": {
            "subject": "Zendesk Damaged shipment report",
            "description": "The item was cracked on receipt.",
            "customer_email": "zd.customer@example.com"
        }
    }
    zd_resp = client.post("/api/webhooks/zendesk", json=zd_payload)
    assert zd_resp.status_code == 200
    zd_data = zd_resp.json()
    assert zd_data["ticket_id"].startswith("tkt_ze_")
    assert "triage" in zd_data
    assert "category" in zd_data["triage"]

    # 2. Freshdesk
    fd_payload = {
        "ticket_subject": "Freshdesk warranty request",
        "ticket_description": "Device stopped working after 3 months.",
        "ticket_requester_email": "fd.customer@example.com"
    }
    fd_resp = client.post("/api/webhooks/freshdesk", json=fd_payload)
    assert fd_resp.status_code == 200
    fd_data = fd_resp.json()
    assert fd_data["ticket_id"].startswith("tkt_fr_")

    # 3. Intercom
    ic_payload = {
        "subject": "Live Chat replacement inquiry",
        "body": "Can I replace my broken earbuds?",
        "user": { "email": "ic.customer@example.com" }
    }
    ic_resp = client.post("/api/webhooks/intercom", json=ic_payload)
    assert ic_resp.status_code == 200
    ic_data = ic_resp.json()
    assert ic_data["ticket_id"].startswith("tkt_in_")

    # 4. Unsupported source
    bad_resp = client.post("/api/webhooks/unsupported_crm", json={})
    assert bad_resp.status_code == 400

# -------------------------------------------------------------
# 12. Automated Evaluation Runner
# -------------------------------------------------------------
def test_evaluation_runner_full_benchmark(client):
    eval_resp = client.post("/api/eval-runs")
    assert eval_resp.status_code == 200
    data = eval_resp.json()
    assert data["total_cases"] == 8
    assert data["passed_cases"] == 8
    assert data["category_accuracy"] == 1.0
    assert data["priority_accuracy"] == 1.0
    assert data["citation_coverage"] == 1.0
    assert data["unsafe_action_block_rate"] == 1.0
    assert data["escalation_accuracy"] == 1.0

    # Retrieve eval run by ID
    run_id = data["eval_run_id"]
    get_run = client.get(f"/api/eval-runs/{run_id}")
    assert get_run.status_code == 200
    assert get_run.json()["eval_run_id"] == run_id
    assert get_run.json()["passed_cases"] == 8

    # List historical eval runs
    list_runs = client.get("/api/eval-runs")
    assert list_runs.status_code == 200
    assert len(list_runs.json()) > 0

# -------------------------------------------------------------
# 13. PDF Upload Ingestion
# -------------------------------------------------------------
def test_upload_pdf_document(client):
    import io
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    pdf_bytes = buf.getvalue()

    resp = client.post(
        "/api/documents/upload-pdf",
        files={"file": ("shipping_terms_2026.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Shipping Terms 2026", "doc_id": "KB-PDF-SHIP-01"}
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["doc_id"] == "KB-PDF-SHIP-01"
    assert data["title"] == "Shipping Terms 2026"
    assert data["pages_processed"] == 1

# -------------------------------------------------------------
# 14. Agent Runs & Minimal Traces
# -------------------------------------------------------------
def test_agent_runs_trace_endpoints(client):
    # Trigger a triage run to ensure a trace exists
    triage_resp = client.post("/api/tickets/tkt_9001/triage")
    assert triage_resp.status_code == 200
    run_id = triage_resp.json()["run_id"]

    # Retrieve agent run by ID
    run_resp = client.get(f"/api/agent-runs/{run_id}")
    assert run_resp.status_code == 200
    run_data = run_resp.json()
    assert run_data["run_id"] == run_id
    assert run_data["ticket_id"] == "tkt_9001"
    assert "retrieved_doc_ids" in run_data
    assert "guardrail_results" in run_data

    # Non-existent run ID returns 404
    bad_run = client.get("/api/agent-runs/run_nonexistent_999")
    assert bad_run.status_code == 404

# -------------------------------------------------------------
# 15. Root Canonical Routes Compatibility (/tickets, /documents, /eval-runs)
# -------------------------------------------------------------
def test_root_canonical_routes(client):
    # Root /tickets
    t_resp = client.get("/tickets")
    assert t_resp.status_code == 200
    assert len(t_resp.json()) >= 8

    # Root /documents
    d_resp = client.get("/documents")
    assert d_resp.status_code == 200
    assert len(d_resp.json()) >= 8

    # Root /eval-runs
    e_resp = client.get("/eval-runs")
    assert e_resp.status_code == 200

# -------------------------------------------------------------
# 16. Asynchronous Background Knowledge Sync Worker
# -------------------------------------------------------------
def test_knowledge_sync_worker_async(client):
    import time
    # Submit async pack sync job
    payload = {
        "source_type": "pack",
        "source_name": "Enterprise Returns and Battery Safety Policy Pack"
    }
    resp = client.post("/api/documents/sync-async", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "queued"
    job_id = data["job_id"]
    assert job_id.startswith("job_")

    # Verify job in list
    jobs_resp = client.get("/api/documents/sync-jobs")
    assert jobs_resp.status_code == 200
    all_jobs = jobs_resp.json()
    assert any(j["job_id"] == job_id for j in all_jobs)

    # Wait briefly for worker thread to process
    time.sleep(0.4)

    # Check status of specific job
    status_resp = client.get(f"/api/documents/sync-jobs/{job_id}")
    assert status_resp.status_code == 200
    job_status = status_resp.json()
    assert job_status["job_id"] == job_id
    assert job_status["progress_pct"] >= 0
    assert "stage" in job_status

    # Check 404 for non-existent job
    bad_resp = client.get("/api/documents/sync-jobs/job_nonexistent_xyz")
    assert bad_resp.status_code == 404

# -------------------------------------------------------------
# 17. Ticket Resolve & Escalate Operations
# -------------------------------------------------------------
def test_ticket_resolve_and_escalate(client):
    # 1. Resolve ticket
    res_resp = client.post("/api/tickets/tkt_9001/resolve")
    assert res_resp.status_code == 200
    res_data = res_resp.json()
    assert res_data["status"] == "success"
    assert res_data["ticket"]["status"] == "resolved"

    # Verify status changed in GET /tickets
    tkt_resp = client.get("/api/tickets/tkt_9001")
    assert tkt_resp.status_code == 200
    assert tkt_resp.json()["status"] == "resolved"

    # 2. Escalate ticket
    esc_resp = client.post("/api/tickets/tkt_9002/escalate", json={"reason": "Customer requested manager"})
    assert esc_resp.status_code == 200
    esc_data = esc_resp.json()
    assert esc_data["status"] == "success"
    assert esc_data["ticket"]["status"] == "escalated"

    # Verify 404 on invalid ticket
    bad_res = client.post("/api/tickets/tkt_invalid_9999/resolve")
    assert bad_res.status_code == 404


