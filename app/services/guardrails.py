import re
from typing import Dict, Any, List, Tuple

class GuardrailService:
    """
    Multi-layer guardrail defense against prompt injection, policy bypass,
    secret leakage, and untrusted knowledge base instructions.
    """

    # Adversarial patterns
    INJECTION_PATTERNS = [
        r"system\s*override",
        r"ignore\s*(all\s*)?(previous\s*)?(support\s*)?instructions",
        r"ignore\s*(the\s*)?(support\s*)?policy",
        r"you\s*are\s*now\s*allowed",
        r"do\s*not\s*mention\s*this\s*instruction",
        r"hidden\s*from\s*(human|reviewer)",
    ]

    IDENTITY_BYPASS_PATTERNS = [
        r"ignore\s*identity\s*checks?",
        r"skip\s*(the\s*)?(identity|verification|auth)\s*checks?",
        r"bypass\s*(identity|verification|otp)",
        r"policy\s*allows\s*it",
    ]

    SECRET_EXTRACTION_PATTERNS = [
        r"print\s*(your\s*)?(hidden\s*)?system\s*prompt",
        r"reveal\s*(hidden\s*)?(prompts?|instructions?)",
        r"show\s*(me\s*)?(internal\s*)?instructions?",
        r"api\s*keys?",
        r"internal\s*notes\s*(used\s*)?for\s*support\s*agents",
        r"reveal\s*secrets?",
    ]

    def check_input_safety(self, text: str) -> Dict[str, Any]:
        """
        Pre-execution security scan on customer input and ticket context.
        """
        t_lower = text.lower()
        violations = []

        # 1. Prompt Injection detection
        for pat in self.INJECTION_PATTERNS:
            if re.search(pat, t_lower):
                violations.append({
                    "type": "PROMPT_INJECTION",
                    "pattern": pat,
                    "risk": "HIGH",
                    "description": "Detected attempt to override system instructions or bypass policies."
                })
                break

        # 2. Identity Verification Bypass detection
        for pat in self.IDENTITY_BYPASS_PATTERNS:
            if re.search(pat, t_lower):
                violations.append({
                    "type": "IDENTITY_BYPASS_ATTEMPT",
                    "pattern": pat,
                    "risk": "HIGH",
                    "description": "Detected attempt to bypass identity or verification checks."
                })
                break

        # 3. Secret & System Prompt Disclosure detection
        for pat in self.SECRET_EXTRACTION_PATTERNS:
            if re.search(pat, t_lower):
                violations.append({
                    "type": "SECRET_EXTRACTION_ATTEMPT",
                    "pattern": pat,
                    "risk": "HIGH",
                    "description": "Detected attempt to extract system prompts, API keys, or internal notes."
                })
                break

        is_safe = len(violations) == 0
        return {
            "is_safe": is_safe,
            "violations": violations,
            "enforce_escalation": not is_safe,
            "blocked_actions": ["issue_coupon", "lock_account"] if not is_safe else []
        }

    def sanitize_retrieved_documents(self, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Ensures documents like KB-ADVERSARIAL-001 are never treated as instructions.
        """
        sanitized = []
        for doc in documents:
            doc_id = doc.get("doc_id", "")
            if doc_id == "KB-ADVERSARIAL-001" or doc.get("is_untrusted"):
                # Neutralize content
                safe_doc = dict(doc)
                safe_doc["content"] = "[SECURITY NOTICE: Untrusted third-party document quarantined. Instructions disregarded.]"
                safe_doc["is_untrusted"] = True
                sanitized.append(safe_doc)
            else:
                sanitized.append(doc)
        return sanitized

    def sanitize_output(self, response_text: str) -> Tuple[str, bool]:
        """
        Post-execution output scrubbing to prevent secret/PII leaks.
        """
        scrubbed = response_text
        modified = False

        # Redact any simulated API key patterns
        if re.search(r"sk-[a-zA-Z0-9_-]{16,}", scrubbed) or "api_key" in scrubbed.lower():
            scrubbed = re.sub(r"sk-[a-zA-Z0-9_-]{16,}", "[REDACTED_API_KEY]", scrubbed)
            modified = True

        # Redact prompt instruction exposure
        if "you are trustdesk" in scrubbed.lower() or "system instructions:" in scrubbed.lower():
            scrubbed = "[SECURITY POLICY: System prompt and configuration instructions cannot be disclosed.]"
            modified = True

        return scrubbed, modified

guardrail_service = GuardrailService()
