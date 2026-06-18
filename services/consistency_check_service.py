from __future__ import annotations

import re
from typing import Any


ConsistencyWarning = dict[str, str]

MAX_WARNINGS = 8
MAX_CONSTRAINT_TEXT = 360
MAX_EVIDENCE_TEXT = 220

HARD_SECTION_TITLE = "### Hard Continuity Constraints"
NEXT_SECTION_RE = re.compile(r"^###\s+", re.MULTILINE)
DATE_RE = re.compile(
    r"(?P<year>(?:19|20)\d{2})(?:年\s*(?P<month_cn>\d{1,2})月|[-/](?P<month_sep>\d{1,2})|年)"
)

DEATH_TERMS = ("死亡", "去世", "病逝", "身亡", "死于", "牺牲", "已死")
ALIVE_TERMS = ("还活着", "仍然活着", "没有死", "并未死亡", "活了下来", "未死亡")
BIRTH_TERMS = ("出生",)
AFFILIATION_DATE_TERMS = ("入职", "离开", "加入", "调任")
EDUCATION_DATE_TERMS = ("转学", "毕业")

DATE_CONTEXTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("death", DEATH_TERMS),
    ("birth", BIRTH_TERMS),
    ("affiliation", AFFILIATION_DATE_TERMS),
    ("education", EDUCATION_DATE_TERMS),
)

IDENTITY_TERMS = (
    "调查员",
    "副局长",
    "时间连续者",
    "正式研究样本",
    "研究样本",
    "穿越者",
    "观察员",
)
IDENTITY_MARKERS = ("是", "被认定为", "正式", "属于")
IDENTITY_NEGATIONS = ("不是", "并非", "不再是", "从未是", "否认")

ORG_MARKERS = ("属于", "隶属", "加入", "调入", "任职于", "来自")
ORG_CONFLICT_TERMS = ("不属于", "脱离", "退出", "改隶属", "不再隶属")
ORG_TERM_RE = re.compile(r"[\u4e00-\u9fff]{2,14}(?:局|处|部|组织|公司|学校|大学|集团|委员会)")

COMMON_SURNAME_RE = re.compile(
    r"[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛"
    r"范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于傅皮卞齐康伍余"
    r"元卜顾孟平黄和穆萧尹钟][\u4e00-\u9fff]{1,2}(?:员|长|局长|处长)?"
)
ENTITY_STOP_PREFIXES = ("时间", "系统", "正文", "本章", "前世", "前一", "管理", "研究", "正式")


def check_generated_chapter_consistency(
    generated_text: str,
    narrative_context_text: str | None,
) -> list[ConsistencyWarning]:
    """Return non-blocking consistency warnings for generated prose.

    This intentionally stays regex-based and only checks the hard-constraint
    section that was actually injected into chapter generation.
    """

    chapter_text = str(generated_text or "")
    if not chapter_text.strip():
        return []

    constraints = extract_hard_constraints_from_prompt(narrative_context_text)
    if not constraints:
        return []

    warnings: list[ConsistencyWarning] = []
    seen: set[tuple[str, str, str]] = set()
    for constraint in constraints:
        for warning in _check_constraint(constraint, chapter_text):
            key = (warning["code"], warning["constraint"], warning["evidence"])
            if key in seen:
                continue
            seen.add(key)
            warnings.append(warning)
            if len(warnings) >= MAX_WARNINGS:
                return warnings
    return warnings


def extract_hard_constraints_from_prompt(narrative_context_text: str | None) -> list[str]:
    text = str(narrative_context_text or "")
    if not text.strip() or HARD_SECTION_TITLE not in text:
        return []

    section_start = text.find(HARD_SECTION_TITLE) + len(HARD_SECTION_TITLE)
    next_section_match = NEXT_SECTION_RE.search(text, section_start)
    section = text[section_start : next_section_match.start() if next_section_match else len(text)]
    constraints: list[str] = []
    current: list[str] = []

    def flush_current() -> None:
        if not current:
            return
        item = _clean_public_text(" ".join(current), MAX_CONSTRAINT_TEXT)
        current.clear()
        if not item or item.lower().startswith("no selected"):
            return
        constraints.append(item)

    for raw_line in section.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#### "):
            continue
        if stripped.startswith("- "):
            flush_current()
            current.append(stripped[2:].strip())
            continue
        if current and (raw_line.startswith(" ") or ":" in stripped):
            current.append(stripped)

    flush_current()
    return constraints


def _check_constraint(constraint: str, chapter_text: str) -> list[ConsistencyWarning]:
    warnings: list[ConsistencyWarning] = []
    warnings.extend(_check_date_conflicts(constraint, chapter_text))
    warnings.extend(_check_life_state_conflict(constraint, chapter_text))
    warnings.extend(_check_identity_conflict(constraint, chapter_text))
    warnings.extend(_check_organization_conflict(constraint, chapter_text))
    return warnings


def _check_date_conflicts(constraint: str, chapter_text: str) -> list[ConsistencyWarning]:
    expected_dates = _date_mentions_with_context(constraint)
    if not expected_dates:
        return []

    actual_dates = _date_mentions_with_context(chapter_text)
    if not actual_dates:
        return []

    warnings: list[ConsistencyWarning] = []
    entity_terms = _entity_terms(constraint)
    for expected in expected_dates:
        if not expected["classes"]:
            continue
        for actual in actual_dates:
            if not expected["classes"].intersection(actual["classes"]):
                continue
            if _same_or_compatible_date(expected, actual):
                continue
            evidence_context = _excerpt(chapter_text, actual["start"], actual["end"], 48)
            if entity_terms and not any(term in evidence_context for term in entity_terms):
                continue
            warnings.append(
                _warning(
                    code="possible_date_conflict",
                    message=f"正文可能改写了已确认事实：{_constraint_topic(constraint)}。",
                    constraint=constraint,
                    evidence=f"正文出现：{evidence_context}",
                    suggestion="建议检查该段落，或重新生成时保留已确认时间。",
                )
            )
            break
    return warnings


def _check_life_state_conflict(constraint: str, chapter_text: str) -> list[ConsistencyWarning]:
    constraint_has_death = _has_any(constraint, DEATH_TERMS)
    constraint_has_alive = _has_any(constraint, ALIVE_TERMS)
    if not constraint_has_death and not constraint_has_alive:
        return []

    entity_terms = _entity_terms(constraint)
    if constraint_has_death:
        evidence = _find_term_evidence(chapter_text, ALIVE_TERMS, entity_terms)
        if evidence:
            return [
                _warning(
                    code="possible_life_state_conflict",
                    message=f"正文可能改写了已确认生死状态：{_constraint_topic(constraint)}。",
                    constraint=constraint,
                    evidence=f"正文出现：{evidence}",
                    suggestion="建议检查人物生死状态，不要把已确认死亡写成存活。",
                )
            ]

    if constraint_has_alive:
        evidence = _find_term_evidence(chapter_text, DEATH_TERMS, entity_terms)
        if evidence:
            return [
                _warning(
                    code="possible_life_state_conflict",
                    message=f"正文可能改写了已确认生死状态：{_constraint_topic(constraint)}。",
                    constraint=constraint,
                    evidence=f"正文出现：{evidence}",
                    suggestion="建议检查人物生死状态，不要把已确认存活写成死亡。",
                )
            ]

    return []


def _check_identity_conflict(constraint: str, chapter_text: str) -> list[ConsistencyWarning]:
    if not _has_any(constraint, IDENTITY_MARKERS):
        return []

    identity_terms = [term for term in IDENTITY_TERMS if term in constraint]
    if not identity_terms:
        return []

    entity_terms = _entity_terms(constraint)
    for term in identity_terms:
        evidence = _find_negated_term_evidence(chapter_text, term, IDENTITY_NEGATIONS, entity_terms)
        if evidence:
            return [
                _warning(
                    code="possible_identity_state_conflict",
                    message=f"正文可能改写了已确认身份状态：{_constraint_topic(constraint)}。",
                    constraint=constraint,
                    evidence=f"正文出现：{evidence}",
                    suggestion="建议检查身份表述，避免否定已确认身份。",
                )
            ]
    return []


def _check_organization_conflict(constraint: str, chapter_text: str) -> list[ConsistencyWarning]:
    if not _has_any(constraint, ORG_MARKERS):
        return []

    organization_terms = _organization_terms(constraint)
    if not organization_terms:
        return []

    entity_terms = _entity_terms(constraint)
    for term in organization_terms:
        evidence = _find_negated_term_evidence(chapter_text, term, ORG_CONFLICT_TERMS, entity_terms)
        if evidence:
            return [
                _warning(
                    code="possible_organization_affiliation_conflict",
                    message=f"正文可能改写了已确认组织归属：{_constraint_topic(constraint)}。",
                    constraint=constraint,
                    evidence=f"正文出现：{evidence}",
                    suggestion="建议检查组织归属、调入调出或隶属关系。",
                )
            ]
    return []


def _date_mentions_with_context(text: str) -> list[dict[str, Any]]:
    mentions: list[dict[str, Any]] = []
    for match in DATE_RE.finditer(text):
        month_text = match.group("month_cn") or match.group("month_sep")
        mention = {
            "year": int(match.group("year")),
            "month": int(month_text) if month_text else None,
            "start": match.start(),
            "end": match.end(),
            "classes": _context_classes(text, match.start(), match.end()),
        }
        mentions.append(mention)
    return mentions


def _context_classes(text: str, start: int, end: int) -> set[str]:
    window = _excerpt(text, start, end, 24)
    classes = {
        context_name
        for context_name, terms in DATE_CONTEXTS
        if any(term in window for term in terms)
    }
    return classes


def _same_or_compatible_date(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    if expected["year"] != actual["year"]:
        return False
    expected_month = expected.get("month")
    actual_month = actual.get("month")
    if expected_month is not None and actual_month is not None and expected_month != actual_month:
        return False
    return True


def _find_term_evidence(text: str, terms: tuple[str, ...], entity_terms: list[str]) -> str:
    for term in terms:
        index = text.find(term)
        while index >= 0:
            evidence = _excerpt(text, index, index + len(term), 42)
            if not entity_terms or any(entity in evidence for entity in entity_terms):
                return _clean_public_text(evidence, MAX_EVIDENCE_TEXT)
            index = text.find(term, index + len(term))
    return ""


def _find_negated_term_evidence(
    text: str,
    term: str,
    negation_terms: tuple[str, ...],
    entity_terms: list[str],
) -> str:
    for match in re.finditer(re.escape(term), text):
        evidence = _excerpt(text, match.start(), match.end(), 36)
        if not any(negation in evidence for negation in negation_terms):
            continue
        if entity_terms and not any(entity in evidence for entity in entity_terms):
            continue
        return _clean_public_text(evidence, MAX_EVIDENCE_TEXT)
    return ""


def _organization_terms(text: str) -> list[str]:
    terms = {match.group(0) for match in ORG_TERM_RE.finditer(text)}
    if "特勤处" in text:
        terms.add("特勤处")
    return sorted(terms, key=len, reverse=True)


def _entity_terms(text: str) -> list[str]:
    terms = {
        match.group(0)
        for match in COMMON_SURNAME_RE.finditer(text)
        if not match.group(0).startswith(ENTITY_STOP_PREFIXES)
    }
    return sorted(terms, key=len, reverse=True)[:6]


def _constraint_topic(constraint: str) -> str:
    first_part = re.split(r"\s+Summary:|\s+\|", constraint, maxsplit=1)[0].strip()
    if first_part:
        return _clean_public_text(first_part, 80)
    entities = _entity_terms(constraint)
    return entities[0] if entities else "硬约束"


def _warning(
    *,
    code: str,
    message: str,
    constraint: str,
    evidence: str,
    suggestion: str,
) -> ConsistencyWarning:
    return {
        "code": code,
        "severity": "warning",
        "message": _clean_public_text(message, 160),
        "constraint": _clean_public_text(constraint, MAX_CONSTRAINT_TEXT),
        "evidence": _clean_public_text(evidence, MAX_EVIDENCE_TEXT),
        "suggestion": _clean_public_text(suggestion, 180),
    }


def _excerpt(text: str, start: int, end: int, radius: int) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    return text[left:right]


def _has_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def _clean_public_text(text: str, max_length: int) -> str:
    value = str(text or "")
    value = re.sub(r"(?i)(api[_-]?key|deepseek_api_key|openai_api_key)\s*[:=]\s*\S+", r"\1=[redacted]", value)
    value = re.sub(r"[A-Za-z]:[\\/][^\s]+", "[local_path]", value)
    value = re.sub(r"/home/[^\s]+", "[local_path]", value)
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= max_length:
        return value
    return value[: max_length - 1].rstrip() + "…"
