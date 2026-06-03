import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent

DEFAULT_MODEL = "deepseek-v4-flash"
DEEPSEEK_MODELS = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "custom",
]
DEFAULT_MODEL_SETTINGS = {
    "use_unified_model": True,
    "unified_model": DEFAULT_MODEL,
    "custom_unified_model": "",
    "setting_expansion_model": DEFAULT_MODEL,
    "outline_model": DEFAULT_MODEL,
    "character_model": DEFAULT_MODEL,
    "chapter_model": DEFAULT_MODEL,
    "chapter_title_model": DEFAULT_MODEL,
    "summary_model": DEFAULT_MODEL,
    "custom_setting_expansion_model": "",
    "custom_outline_model": "",
    "custom_character_model": "",
    "custom_chapter_model": "",
    "custom_chapter_title_model": "",
    "custom_summary_model": "",
}
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip() or "https://api.deepseek.com"

OUTPUT_DIR = PROJECT_ROOT / "outputs"
WORKSPACE_DIR = PROJECT_ROOT / "workspace"
BOOKS_DIR = WORKSPACE_DIR / "books"
DOCS_DIR = PROJECT_ROOT / "docs"

MAX_REFERENCE_CHARS = 6000
MAX_PREVIOUS_CHAPTER_CHARS = 8000
MAX_SUMMARIES_CHARS = 5000
