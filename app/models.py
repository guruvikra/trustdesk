from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field

# User / Staff & RBAC
class UserBase(BaseModel):
    name: str
    email: str
    role: str = Field(..., description="Role: owner, admin, support_manager, support_agent")

class UserCreate(UserBase):
    pass

class UserResponse(UserBase):
    user_id: str
    created_at: str
    is_active: bool

# Customer & Order
class CustomerResponse(BaseModel):
    customer_id: str
    name: str
    email: str
    tier: str
    country: str
    created_at: str
    verified: bool
    tags: List[str]

class OrderItem(BaseModel):
    sku: str
    name: str
    quantity: int
    unit_price: int

class OrderResponse(BaseModel):
    order_id: str
    customer_id: str
    status: str
    placed_at: str
    delivered_at: Optional[str] = None
    eligible_return_until: Optional[str] = None
    total: int
    currency: str
    payment_status: str
    tracking_number: Optional[str] = None
    items: List[Dict[str, Any]]

# Ticket
class TicketBase(BaseModel):
    channel: str = "email"
    subject: str
    body: str
    customer_id: str
    order_id: Optional[str] = None

class TicketCreate(TicketBase):
    pass

class TicketResponse(TicketBase):
    ticket_id: str
    created_at: str
    status: str
    expected_category: Optional[str] = None
    expected_priority: Optional[str] = None
    expected_sentiment: Optional[str] = None
    expected_escalation: Optional[bool] = None
    expected_actions: List[str] = []
    triage_category: Optional[str] = None
    triage_priority: Optional[str] = None
    triage_escalation: Optional[bool] = None
    triage_reason: Optional[str] = None
    customer: Optional[CustomerResponse] = None
    order: Optional[OrderResponse] = None

# Triage Result
class TriageResponse(BaseModel):
    ticket_id: str
    category: str
    priority: str
    sentiment: str = "neutral"
    should_escalate: bool
    reason_summary: str
    run_id: str
    guardrail_status: str = "PASSED"

# Draft Reply
class DraftReplyResponse(BaseModel):
    draft_id: str
    ticket_id: str
    status: str
    body: str
    citations: List[str]
    recommended_actions: List[Dict[str, Any]]
    run_id: str

# Tool Action
class ToolActionRequestCreate(BaseModel):
    ticket_id: str
    tool_name: str
    payload: Dict[str, Any]

class ToolActionResponse(BaseModel):
    action_id: str
    ticket_id: str
    tool_name: str
    payload: Dict[str, Any]
    risk_level: str
    requires_human_approval: bool
    status: str
    idempotency_key: str
    created_at: str
    executed_at: Optional[str] = None
    execution_result: Optional[Dict[str, Any]] = None
    is_cached_idempotent: bool = False

class ApprovalRequest(BaseModel):
    reviewer_id: str
    decision: str = Field(..., description="'approved' or 'rejected'")
    reason: Optional[str] = None

# Copilot & Knowledge Q&A
class CopilotQuestionRequest(BaseModel):
    query: str
    ticket_id: Optional[str] = None

class CopilotQuestionResponse(BaseModel):
    answer: str
    citations: List[str]
    confidence_score: float
    jev_rerank_score: float
    retrieved_documents: List[Dict[str, Any]]
    latency_ms: int

class FeedbackCreate(BaseModel):
    ticket_id: Optional[str] = None
    query_text: Optional[str] = None
    response_text: Optional[str] = None
    rating: int = Field(..., description="+1 for like, -1 for dislike")
    reason: Optional[str] = None

# Support Form Deflector
class DeflectorCheckRequest(BaseModel):
    subject: str
    message: str

class DeflectorCheckResponse(BaseModel):
    deflected: bool
    instant_solution: Optional[str] = None
    cited_doc_id: Optional[str] = None
    confidence: float = 0.0

class DeflectorResolveRequest(BaseModel):
    deflection_id: Optional[str] = None
    subject: str
    resolved: bool

# Evaluation
class EvalCaseResult(BaseModel):
    case_id: str
    ticket_id: str
    passed: bool
    predicted_category: str
    expected_category: str
    predicted_priority: str
    expected_priority: str
    citations: List[str]
    expected_citations: List[str]
    citations_passed: bool
    recommended_actions: List[str]
    blocked_actions: List[str]
    safety_passed: bool
    should_escalate: bool
    expected_escalation: bool
    escalation_passed: bool
    notes: str

class EvalRunResponse(BaseModel):
    eval_run_id: str
    started_at: str
    completed_at: str
    total_cases: int
    passed_cases: int
    category_accuracy: float
    priority_accuracy: float
    citation_coverage: float
    unsafe_action_block_rate: float
    escalation_accuracy: float
    case_results: List[EvalCaseResult]
