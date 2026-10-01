import sqlite3
import json
from pathlib import Path
from contextlib import contextmanager
from app.config import settings

def get_connection():
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    # Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

@contextmanager
def db_session():
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_db():
    with db_session() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'support_manager', 'support_agent')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS customers (
            customer_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            tier TEXT NOT NULL,
            country TEXT NOT NULL,
            created_at TEXT NOT NULL,
            verified INTEGER NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS orders (
            order_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL REFERENCES customers(customer_id),
            status TEXT NOT NULL,
            placed_at TEXT NOT NULL,
            delivered_at TEXT,
            eligible_return_until TEXT,
            total INTEGER NOT NULL,
            currency TEXT NOT NULL,
            payment_status TEXT NOT NULL,
            tracking_number TEXT,
            items_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS tickets (
            ticket_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL REFERENCES customers(customer_id),
            order_id TEXT REFERENCES orders(order_id),
            channel TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            expected_category TEXT,
            expected_priority TEXT,
            expected_sentiment TEXT,
            expected_escalation INTEGER,
            expected_actions_json TEXT NOT NULL DEFAULT '[]',
            triage_category TEXT,
            triage_priority TEXT,
            triage_escalation INTEGER,
            triage_reason TEXT
        );

        CREATE TABLE IF NOT EXISTS knowledge_documents (
            doc_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source_path TEXT NOT NULL,
            content TEXT NOT NULL,
            audience TEXT NOT NULL DEFAULT 'public',
            version TEXT NOT NULL DEFAULT '2026.06',
            is_untrusted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tool_action_catalog (
            tool_name TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            risk_level TEXT NOT NULL,
            requires_human_approval INTEGER NOT NULL,
            allowed_categories_json TEXT NOT NULL,
            required_fields_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS draft_replies (
            draft_id TEXT PRIMARY KEY,
            ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
            status TEXT NOT NULL DEFAULT 'generated',
            body TEXT NOT NULL,
            citations_json TEXT NOT NULL DEFAULT '[]',
            recommended_actions_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tool_action_requests (
            action_id TEXT PRIMARY KEY,
            ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
            tool_name TEXT NOT NULL REFERENCES tool_action_catalog(tool_name),
            payload_json TEXT NOT NULL,
            risk_level TEXT NOT NULL,
            requires_human_approval INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'approval_required',
            idempotency_key TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            executed_at TEXT,
            execution_result_json TEXT
        );

        CREATE TABLE IF NOT EXISTS approvals (
            approval_id TEXT PRIMARY KEY,
            action_id TEXT NOT NULL REFERENCES tool_action_requests(action_id),
            reviewer_id TEXT NOT NULL REFERENCES users(user_id),
            decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
            reason TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
            run_id TEXT PRIMARY KEY,
            ticket_id TEXT REFERENCES tickets(ticket_id),
            run_type TEXT NOT NULL,
            status TEXT NOT NULL,
            retrieved_doc_ids_json TEXT NOT NULL DEFAULT '[]',
            tool_calls_json TEXT NOT NULL DEFAULT '[]',
            guardrail_results_json TEXT NOT NULL DEFAULT '{}',
            model_name TEXT NOT NULL DEFAULT 'hybrid-jev-adapter',
            latency_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS feedback (
            feedback_id TEXT PRIMARY KEY,
            ticket_id TEXT REFERENCES tickets(ticket_id),
            query_text TEXT,
            response_text TEXT,
            rating INTEGER NOT NULL,
            reason TEXT,
            corrected_response TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS deflection_events (
            deflection_id TEXT PRIMARY KEY,
            subject TEXT NOT NULL,
            query TEXT NOT NULL,
            suggested_doc_id TEXT REFERENCES knowledge_documents(doc_id),
            resolved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS eval_runs (
            eval_run_id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            total_cases INTEGER NOT NULL,
            metrics_json TEXT NOT NULL,
            case_results_json TEXT NOT NULL
        );
        """)

        # FTS5 Virtual Table for Knowledge Base search
        try:
            conn.executescript("""
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_documents_fts
            USING fts5(doc_id UNINDEXED, title, content);
            """)
        except sqlite3.OperationalError:
            pass
