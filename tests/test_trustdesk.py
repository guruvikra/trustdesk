import pytest
import json
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

def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"

def test_list_tickets_with_context(client):
    response = client.get("/api/tickets")
    assert response.status_code == 200
    tickets = response.json()
    assert len(tickets) >= 8
    
    # Check ticket tkt_9001 has linked customer and order context
    tkt_1 = next(t for t in tickets if t["ticket_id"] == "tkt_9001")
    assert tkt_1["customer"] is not None
    assert tkt_1["customer"]["customer_id"] == "cus_1001"
    assert tkt_1["order"] is not None
    assert tkt_1["order"]["order_id"] == "ord_5001"

def test_date_anchoring_against_ticket_created_at():
    # Ticket created on 2026-06-28 with return window until 2026-07-24
    anchor_check = check_policy_window_anchor("2026-06-28T10:15:00+05:30", "2026-07-24T23:59:59+05:30")
    assert anchor_check["within_window"] is True
    assert anchor_check["status"] == "ELIGIBLE"

    # Expired case
    expired_check = check_policy_window_anchor("2026-07-25T10:15:00+05:30", "2026-07-24T23:59:59+05:30")
    assert expired_check["within_window"] is False
    assert expired_check["status"] == "EXPIRED"

def test_knowledge_base_search_with_jev_reranker(client):
    response = client.get("/api/documents/search?q=damaged item replacement")
    assert response.status_code == 200
    data = response.json()
    assert len(data["results"]) > 0
    top_doc = data["results"][0]
    assert top_doc["doc_id"] == "KB-REFUND-001"
    assert "score" in top_doc

def test_ticket_triage(client):
    response = client.post("/api/tickets/tkt_9001/triage")
    assert response.status_code == 200
    triage = response.json()
    assert triage["category"] == "refund"
    assert triage["priority"] == "medium"
    assert triage["should_escalate"] is False

def test_cited_draft_generation(client):
    response = client.post("/api/tickets/tkt_9001/draft-reply")
    assert response.status_code == 200
    draft = response.json()
    assert "KB-REFUND-001" in draft["citations"]
    assert any(a["tool_name"] == "create_replacement_order" for a in draft["recommended_actions"])

def test_approval_gated_action_with_idempotency(client):
    import uuid
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

def test_copilot_and_feedback(client):
    ask_resp = client.post("/api/copilot/ask", json={"query": "What is the return window for damaged items?"})
    assert ask_resp.status_code == 200
    data = ask_resp.json()
    assert "KB-REFUND-001" in data["citations"]
    assert data["jev_rerank_score"] > 0.8

    fb_resp = client.post("/api/copilot/feedback", json={
        "query_text": "What is the return window?",
        "rating": 1,
        "reason": "Accurate policy answer"
    })
    assert fb_resp.status_code == 201

def test_ticket_deflector(client):
    defl_resp = client.post("/api/deflector/check", json={
        "subject": "Received cracked earbud",
        "message": "Left earbud is cracked on arrival"
    })
    assert defl_resp.status_code == 200
    data = defl_resp.json()
    assert data["deflected"] is True
    assert data["cited_doc_id"] == "KB-REFUND-001"

def test_staff_api_and_rbac(client):
    # List staff
    list_resp = client.get("/api/staff")
    assert list_resp.status_code == 200
    assert len(list_resp.json()) >= 4

    # Add staff
    import uuid
    rand_email = f"test.engineer.{uuid.uuid4().hex[:6]}@trustdesk.io"
    new_staff = {
        "name": "Test Engineer",
        "email": rand_email,
        "role": "support_agent"
    }
    create_resp = client.post("/api/staff", json=new_staff)
    assert create_resp.status_code == 201
    assert create_resp.json()["role"] == "support_agent"

def test_evaluation_runner_full_benchmark(client):
    eval_resp = client.post("/api/eval-runs")
    assert eval_resp.status_code == 200
    data = eval_resp.json()
    assert data["total_cases"] == 8
    assert data["category_accuracy"] == 1.0
    assert data["priority_accuracy"] == 1.0
    assert data["citation_coverage"] == 1.0
    assert data["unsafe_action_block_rate"] == 1.0
    assert data["escalation_accuracy"] == 1.0
