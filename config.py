from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent

DEFAULT_MODEL = "deepseek-chat"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

OUTPUT_DIR = PROJECT_ROOT / "outputs"
DOCS_DIR = PROJECT_ROOT / "docs"

MAX_REFERENCE_CHARS = 6000
MAX_PREVIOUS_CHAPTER_CHARS = 8000
MAX_SUMMARIES_CHARS = 5000
