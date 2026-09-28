"""A small shared JSON Schema subset. Domain validators remain authoritative."""
from __future__ import annotations
S = {"type": "string"}
I = {"type": "integer"}
B = {"type": "boolean"}
N = {"type": "number"}
def arr(items): return {"type": "array", "items": items}
def obj(**fields): return {"type": "object", "properties": fields, "required": list(fields), "additionalProperties": False}

WARNING = obj(code=S, message=S, constraint=S, evidence=S, suggestion=S)
ENTITY = obj(label=S, summary=S, evidence=S, aliases=arr(S))
# Preserve the field vocabulary already consumed by Story Delta normalization/review.
STORY_TEXT_FIELDS = ("type", "node_type", "label", "name", "character", "character_name", "title", "summary", "description", "changes", "change", "fact", "evidence", "rationale", "foreshadowing", "direction", "status", "suggested_status", "layer", "source", "target", "source_node_id", "target_node_id", "source_change_id", "target_change_id", "notes", "parent_id")
STORY_ENTITY = obj(**{k:S for k in STORY_TEXT_FIELDS}, importance=I, characters=arr(S), aliases=arr(S), tags=arr(S))
PAYLOAD = STORY_ENTITY
CHANGE = obj(id=S, operation=S, target=S, source=S, confidence=N, requires_review=B, evidence=S, rationale=S, payload=PAYLOAD)
SCHEMAS = {
    "connection_test": obj(ok=B),
    "expand_setting": obj(title_candidates=arr(S), recommended_title=S, protagonist_setting=S, supporting_characters_setting=S, world_setting=S, core_conflict=S),
    "summarize_chapter": obj(summary=S, warnings=arr(WARNING)),
    "import_chapter": obj(summary=S, characters=arr(ENTITY), facts=arr(ENTITY), relationships=arr(ENTITY), foreshadows=arr(ENTITY), warnings=arr(S)),
    "import_synthesis": obj(config=obj(title=S, genre=S, style=S, word_count_range=S, protagonist=S, supporting_characters=S, worldview=S, core_conflict=S), assets=obj(outline=S, characters=S, setting_expansion=S), warnings=arr(S)),
    "story_delta": obj(story_delta=obj(**{name: arr(STORY_ENTITY) for name in ("new_characters", "character_updates", "new_scenes", "new_items", "new_events", "foreshadowing_updates", "relationship_updates", "world_fact_updates")}),
        next_chapter_proposal=obj(target_chapter_number=I, suggested_goal=S, **{name:arr(STORY_ENTITY) for name in ("suggested_scenes", "suggested_conflicts", "suggested_foreshadowing_moves", "suggested_new_nodes", "suggested_new_edges", "suggested_plot_directions")}, risks=arr(S)), candidate_changes=arr(CHANGE), warnings=arr(S)),
}

def validate_schema(schema):
    if set(schema) - {"type", "properties", "required", "additionalProperties", "items"}:
        raise ValueError("Unsupported schema keyword")
    if schema.get("type") == "object":
        if schema.get("additionalProperties") is not False or set(schema["required"]) != set(schema["properties"]): raise ValueError("Invalid closed schema")
        for child in schema["properties"].values(): validate_schema(child)
    elif schema.get("type") == "array": validate_schema(schema["items"])
    elif schema.get("type") not in {"string", "integer", "number", "boolean"}: raise ValueError("Unsupported schema type")

for _schema in SCHEMAS.values(): validate_schema(_schema)
