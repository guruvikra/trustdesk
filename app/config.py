import os
from pathlib import Path
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
KB_DIR = DATA_DIR / "knowledge_base"
DB_PATH = BASE_DIR / "trustdesk.db"

class Settings(BaseModel):
    app_name: str = "TrustDesk AI Support Operations"
    environment: str = os.getenv("ENVIRONMENT", "development")
    db_path: Path = DB_PATH
    data_dir: Path = DATA_DIR
    kb_dir: Path = KB_DIR
    
    # AI Provider configuration
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    
    # Jev Model Reranker configuration
    jev_api_key: str = os.getenv("JEV_API_KEY", "")
    jev_endpoint: str = os.getenv("JEV_ENDPOINT", "https://api.jev.ai/v1/rerank")

settings = Settings()
