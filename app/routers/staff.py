import uuid
import datetime
from typing import List, Dict, Any
from fastapi import APIRouter, HTTPException
from app.database import db_session
from app.models import UserResponse, UserCreate

router = APIRouter(prefix="/staff", tags=["Staff & RBAC"])

@router.get("", response_model=List[UserResponse])
def list_staff_members():
    """
    List all registered enterprise staff members and their active RBAC roles.
    Accessible to Owners and Admins.
    """
    with db_session() as conn:
        cursor = conn.execute("SELECT user_id, name, email, role, created_at, is_active FROM users ORDER BY created_at ASC")
        rows = cursor.fetchall()
        return [
            UserResponse(
                user_id=r["user_id"],
                name=r["name"],
                email=r["email"],
                role=r["role"],
                created_at=r["created_at"],
                is_active=bool(r["is_active"])
            )
            for r in rows
        ]

@router.post("", response_model=UserResponse, status_code=201)
def add_staff_member(user_in: UserCreate):
    """
    Add a new staff member via Staff API and assign RBAC role
    (owner, admin, support_manager, support_agent).
    """
    allowed_roles = {"owner", "admin", "support_manager", "support_agent"}
    if user_in.role.lower() not in allowed_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role '{user_in.role}'. Allowed: {', '.join(allowed_roles)}")

    user_id = f"usr_{uuid.uuid4().hex[:8]}"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    with db_session() as conn:
        # Check email uniqueness
        c = conn.execute("SELECT user_id FROM users WHERE email = ?", (user_in.email,))
        if c.fetchone():
            raise HTTPException(status_code=400, detail=f"User with email '{user_in.email}' already exists.")

        conn.execute(
            """
            INSERT INTO users (user_id, name, email, role, created_at, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
            """,
            (user_id, user_in.name, user_in.email, user_in.role.lower(), now)
        )

        return UserResponse(
            user_id=user_id,
            name=user_in.name,
            email=user_in.email,
            role=user_in.role.lower(),
            created_at=now,
            is_active=True
        )

@router.put("/{user_id}/role", response_model=UserResponse)
def update_staff_role(user_id: str, payload: Dict[str, str]):
    """Update role for a staff member."""
    new_role = payload.get("role", "").lower()
    allowed_roles = {"owner", "admin", "support_manager", "support_agent"}
    if new_role not in allowed_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role '{new_role}'. Allowed: {', '.join(allowed_roles)}")

    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"User '{user_id}' not found.")

        conn.execute("UPDATE users SET role = ? WHERE user_id = ?", (new_role, user_id))
        return UserResponse(
            user_id=row["user_id"],
            name=row["name"],
            email=row["email"],
            role=new_role,
            created_at=row["created_at"],
            is_active=bool(row["is_active"])
        )

@router.delete("/{user_id}")
def remove_staff_member(user_id: str):
    """Deactivate or remove a staff member."""
    with db_session() as conn:
        cursor = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"User '{user_id}' not found.")

        if row["role"] == "owner":
            raise HTTPException(status_code=400, detail="Cannot delete organization primary owner.")

        conn.execute("DELETE FROM users WHERE user_id = ?", (user_id,))
        return {"status": "success", "message": f"Staff member '{user_id}' removed."}
