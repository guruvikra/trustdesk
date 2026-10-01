from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from app.config import settings
from app.seed import seed_database
from app.routers import (
    tickets,
    triage,
    drafts,
    tools,
    knowledge,
    copilot,
    deflector,
    webhooks,
    staff,
    evals
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Auto-seed canonical data on startup if not already initialized
    try:
        seed_database()
    except Exception as e:
        print(f"Warning during DB startup seed: {e}")
    yield

app = FastAPI(
    title="TrustDesk - AI Support Operations Agent",
    description="Enterprise AI-First Support Operations, RAG with Jev Model Reranker, Human-in-the-Loop Actions, and Ticket Deflector",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include all Core & SaaS Routers under /api
app.include_router(tickets.router, prefix="/api")
app.include_router(triage.router, prefix="/api")
app.include_router(drafts.router, prefix="/api")
app.include_router(tools.router, prefix="/api")
app.include_router(knowledge.router, prefix="/api")
app.include_router(copilot.router, prefix="/api")
app.include_router(deflector.router, prefix="/api")
app.include_router(webhooks.router, prefix="/api")
app.include_router(staff.router, prefix="/api")
app.include_router(evals.router, prefix="/api")

# Also include root-level routes for canonical API contract compatibility:
# /tickets, /documents, /tool-actions, /eval-runs, /agent-runs
app.include_router(tickets.router)
app.include_router(triage.router)
app.include_router(drafts.router)
app.include_router(tools.router)
app.include_router(knowledge.router)
app.include_router(evals.router)

from fastapi.responses import FileResponse

@app.get("/")
def serve_index():
    static_index = Path(__file__).resolve().parent / "static" / "index.html"
    if static_index.exists():
        return FileResponse(static_index)
    return {"message": "TrustDesk AI Support Operations API is live. Visit /docs for OpenAPI specifications."}

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "TrustDesk AI Support Operations",
        "version": "1.0.0",
        "reranker": "Jev System One",
        "guardrails": "Enforced"
    }
