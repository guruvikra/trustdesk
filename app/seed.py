import json
from pathlib import Path
from app.config import settings
from app.database import db_session, init_db

def doc_id_from_markdown(text: str) -> str:
    for line in text.splitlines():
        if line.lower().startswith("doc id:"):
            return line.split(":", 1)[1].strip()
    raise ValueError("Knowledge document is missing 'Doc ID:'")

def title_from_markdown(text: str, fallback: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback

def audience_from_markdown(text: str) -> str:
    for line in text.splitlines():
        if line.lower().startswith("audience:"):
            return line.split(":", 1)[1].strip()
    return "public"

def version_from_markdown(text: str) -> str:
    for line in text.splitlines():
        if line.lower().startswith("version:"):
            return line.split(":", 1)[1].strip()
    return "2026.06"

def seed_database():
    init_db()
    with db_session() as conn:
        # 1. Seed RBAC Staff Users
        staff_users = [
            ("usr_owner_01", "Alex Vance", "alex.vance@trustdesk.io", "owner"),
            ("usr_admin_01", "John Doe", "john.doe@trustdesk.io", "admin"),
            ("usr_manager_01", "Sarah Miller", "sarah.m@trustdesk.io", "support_manager"),
            ("usr_agent_01", "Alice Reynolds", "alice.r@trustdesk.io", "support_agent"),
        ]
        for uid, name, email, role in staff_users:
            conn.execute(
                """
                INSERT OR REPLACE INTO users (user_id, name, email, role, is_active)
                VALUES (?, ?, ?, ?, 1)
                """,
                (uid, name, email, role)
            )

        # 2. Seed Customers
        customers_path = settings.data_dir / "customers.json"
        if customers_path.exists():
            with open(customers_path, "r", encoding="utf-8") as f:
                customers = json.load(f)
            for c in customers:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO customers 
                    (customer_id, name, email, tier, country, created_at, verified, tags_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        c["customer_id"],
                        c["name"],
                        c["email"],
                        c["tier"],
                        c["country"],
                        c["created_at"],
                        int(c["verified"]),
                        json.dumps(c.get("tags", []))
                    )
                )

        # 3. Seed Orders
        orders_path = settings.data_dir / "orders.json"
        if orders_path.exists():
            with open(orders_path, "r", encoding="utf-8") as f:
                orders = json.load(f)
            for o in orders:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO orders
                    (order_id, customer_id, status, placed_at, delivered_at, eligible_return_until,
                     total, currency, payment_status, tracking_number, items_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        o["order_id"],
                        o["customer_id"],
                        o["status"],
                        o["placed_at"],
                        o.get("delivered_at"),
                        o.get("eligible_return_until"),
                        o["total"],
                        o["currency"],
                        o["payment_status"],
                        o.get("tracking_number"),
                        json.dumps(o.get("items", []))
                    )
                )

        # 4. Seed Tickets
        tickets_path = settings.data_dir / "tickets.json"
        if tickets_path.exists():
            with open(tickets_path, "r", encoding="utf-8") as f:
                tickets = json.load(f)
            for t in tickets:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO tickets
                    (ticket_id, customer_id, order_id, channel, subject, body, created_at, status,
                     expected_category, expected_priority, expected_sentiment, expected_escalation, expected_actions_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        t["ticket_id"],
                        t["customer_id"],
                        t.get("order_id"),
                        t["channel"],
                        t["subject"],
                        t["body"],
                        t["created_at"],
                        t["status"],
                        t.get("expected_category"),
                        t.get("expected_priority"),
                        t.get("expected_sentiment"),
                        int(t.get("expected_escalation", False)),
                        json.dumps(t.get("expected_actions", []))
                    )
                )

        # 5. Seed Knowledge Base Documents & FTS
        if settings.kb_dir.exists():
            for md_file in sorted(settings.kb_dir.glob("*.md")):
                content = md_file.read_text(encoding="utf-8")
                doc_id = doc_id_from_markdown(content)
                title = title_from_markdown(content, md_file.stem)
                audience = audience_from_markdown(content)
                version = version_from_markdown(content)
                is_untrusted = 1 if doc_id == "KB-ADVERSARIAL-001" or "adversarial" in md_file.name else 0

                conn.execute(
                    """
                    INSERT OR REPLACE INTO knowledge_documents
                    (doc_id, title, source_path, content, audience, version, is_untrusted)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (doc_id, title, str(md_file.relative_to(settings.data_dir.parent)), content, audience, version, is_untrusted)
                )
                try:
                    conn.execute("DELETE FROM knowledge_documents_fts WHERE doc_id = ?", (doc_id,))
                    conn.execute(
                        """
                        INSERT INTO knowledge_documents_fts (doc_id, title, content)
                        VALUES (?, ?, ?)
                        """,
                        (doc_id, title, content)
                    )
                except Exception:
                    pass

        # 6. Seed Tool Action Catalog
        tools_path = settings.data_dir / "tool_actions.json"
        if tools_path.exists():
            with open(tools_path, "r", encoding="utf-8") as f:
                tool_actions = json.load(f)
            for tool in tool_actions:
                metadata = {
                    k: v for k, v in tool.items()
                    if k not in {"tool_name", "description", "risk_level", "requires_human_approval", "allowed_categories", "required_fields"}
                }
                conn.execute(
                    """
                    INSERT OR REPLACE INTO tool_action_catalog
                    (tool_name, description, risk_level, requires_human_approval, allowed_categories_json, required_fields_json, metadata_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tool["tool_name"],
                        tool["description"],
                        tool["risk_level"],
                        int(tool["requires_human_approval"]),
                        json.dumps(tool["allowed_categories"]),
                        json.dumps(tool["required_fields"]),
                        json.dumps(metadata)
                    )
                )
    print("Database seeding completed successfully.")

if __name__ == "__main__":
    seed_database()
