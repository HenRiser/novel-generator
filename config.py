from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent

DEFAULT_MODEL = "deepseek-chat"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

OUTPUT_DIR = PROJECT_ROOT / "outputs"
SUMMARY_DIR = OUTPUT_DIR / "summaries"
DOCS_DIR = PROJECT_ROOT / "docs"

PROJECT_CONFIG_FILE = OUTPUT_DIR / "project_config.json"
OUTLINE_FILE = OUTPUT_DIR / "novel_outline.md"
CHARACTERS_FILE = OUTPUT_DIR / "characters.md"
CHAPTER_INDEX_FILE = OUTPUT_DIR / "chapter_index.md"

MAX_REFERENCE_CHARS = 6000
MAX_PREVIOUS_CHAPTER_CHARS = 8000
MAX_SUMMARIES_CHARS = 5000
