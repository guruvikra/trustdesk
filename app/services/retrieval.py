import sqlite3
from typing import List, Dict, Any, Optional
from datetime import datetime
from app.database import db_session

def parse_iso(dt_str: str) -> datetime:
    """Parses ISO timestamp with timezone support."""
    if not dt_str:
        return datetime.min
    clean_str = dt_str.replace("Z", "+00:00")
    return datetime.fromisoformat(clean_str)

def check_policy_window_anchor(
    ticket_created_at: str,
    eligible_return_until: Optional[str]
) -> Dict[str, Any]:
    """
    CRITICAL REQUIREMENT: Evaluates return / warranty windows relative
    to each ticket's created_at, NEVER against the wall-clock date.
    """
    t_dt = parse_iso(ticket_created_at)
    if not eligible_return_until:
        return {"within_window": False, "reason": "No return window specified"}
    
    ret_dt = parse_iso(eligible_return_until)
    is_valid = t_dt <= ret_dt
    days_diff = (ret_dt - t_dt).days
    
    return {
        "within_window": is_valid,
        "ticket_created_at": ticket_created_at,
        "eligible_return_until": eligible_return_until,
        "days_remaining_relative_to_ticket": days_diff,
        "status": "ELIGIBLE" if is_valid else "EXPIRED"
    }

def search_lexical_candidates(query: str, limit: int = 8) -> List[Dict[str, Any]]:
    """
    Stage 1: Lexical retrieval using SQLite FTS5 with BM25 ranking fallback.
    Retrieves candidate documents for the Jev reranker.
    """
    results = []
    stopwords = {
        "what", "is", "the", "on", "for", "and", "are", "tell", "me", "how", 
        "can", "about", "with", "this", "that", "from", "your", "our", "a", 
        "an", "in", "to", "of", "do", "you", "policy", "please", "i", "my", "we"
    }
    
    with db_session() as conn:
        # 1. Try FTS5 match with BM25
        try:
            clean_query = "".join(c if c.isalnum() or c.isspace() else " " for c in query.lower()).strip()
            raw_tokens = [t for t in clean_query.split() if len(t) >= 3 and t not in stopwords]
            
            fts_clauses = []
            for t in raw_tokens:
                fts_clauses.append(f'"{t}"')
                if len(t) >= 4:
                    fts_clauses.append(f'{t[:5]}*')
                    
            if fts_clauses:
                fts_query = " OR ".join(fts_clauses)
                cursor = conn.execute(
                    """
                    SELECT doc_id, title, content, bm25(knowledge_documents_fts) as rank
                    FROM knowledge_documents_fts
                    WHERE knowledge_documents_fts MATCH ?
                    ORDER BY rank ASC
                    LIMIT ?
                    """,
                    (fts_query, limit)
                )
                rows = cursor.fetchall()
                for r in rows:
                    results.append({
                        "doc_id": r["doc_id"],
                        "title": r["title"],
                        "content": r["content"],
                        "source": "fts5"
                    })
        except Exception:
            pass

        # 2. Supplementary lexical retrieval from knowledge_documents table
        cursor = conn.execute("SELECT doc_id, title, content, is_untrusted FROM knowledge_documents")
        all_docs = cursor.fetchall()
        q_lower = query.lower()
        tokens = [t for t in q_lower.split() if len(t) >= 3 and t not in stopwords]
        
        scored_docs = []
        for d in all_docs:
            doc_id = d["doc_id"]
            if any(res["doc_id"] == doc_id for res in results):
                continue
            content_lower = d["content"].lower()
            title_lower = d["title"].lower()
            
            # Match score based on keyword presence
            score = 0
            for word in tokens:
                stem = word[:4]
                if word in title_lower or stem in title_lower:
                    score += 5
                if word in content_lower or stem in content_lower:
                    score += 2
            
            scored_docs.append((score, {
                "doc_id": doc_id,
                "title": d["title"],
                "content": d["content"],
                "is_untrusted": bool(d["is_untrusted"]),
                "source": "lexical"
            }))
        
        scored_docs.sort(key=lambda x: x[0], reverse=True)
        for _, doc in scored_docs:
            if len(results) >= limit:
                break
            results.append(doc)

    return results
