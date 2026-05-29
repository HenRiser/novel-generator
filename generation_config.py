from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


GENRE_OPTIONS = ["赛博朋克", "玄幻", "科幻", "悬疑", "都市", "仙侠", "奇幻", "末日废土", "自定义"]
WRITING_STYLE_OPTIONS = ["阴郁电影感", "轻小说", "网文爽文", "硬科幻", "黑暗成人向", "克制文学感", "日式赛博朋克", "自定义"]
WRITING_MODE_OPTIONS = ["长篇连载", "中篇故事", "单章完整故事", "电影式强剧情", "慢热铺陈", "高密度剧情推进"]
PLOT_DENSITY_OPTIONS = ["低：重氛围", "中：平衡", "高：高事件密度"]
NARRATIVE_PACE_OPTIONS = ["慢", "中", "快"]
WORLD_COMPLEXITY_OPTIONS = ["低", "中", "高"]
CHARACTER_SCALE_OPTIONS = ["少量核心角色", "中等角色群", "多势力群像"]
OUTLINE_GRANULARITY_OPTIONS = ["简略", "标准", "详细"]


@dataclass
class SettingExpansionOptions:
    genre: str = "赛博朋克"
    writing_style: str = "阴郁电影感"
    writing_mode: str = "长篇连载"
    expected_chapters: int = 12
    plot_density: str = "中：平衡"
    narrative_pace: str = "中"
    world_complexity: str = "中"
    character_scale: str = "中等角色群"
    outline_granularity: str = "标准"
    extra_requirements: str = ""


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _option_value(value: Any, options: list[str], default: str) -> str:
    cleaned = _clean(value)
    return cleaned if cleaned in options else default


def _free_text_or_default(value: Any, default: str) -> str:
    cleaned = _clean(value)
    if not cleaned or cleaned == "自定义":
        return default
    return cleaned


def infer_story_scale(expected_chapters: int) -> dict[str, str]:
    chapters = max(1, int(expected_chapters or 12))
    if chapters == 1:
        return {
            "scale": "单章完整故事",
            "rhythm": "高剧情压缩，开端、转折和收束必须集中完成",
            "characters": "少量核心角色，避免庞大配角群",
            "world": "世界观点到为止，只保留服务主线的规则",
            "subplot": "弱支线或无支线",
            "outline": "只规划单章内部的关键场景和情绪转折",
        }
    if chapters <= 5:
        return {
            "scale": "短篇",
            "rhythm": "结构紧凑，尽快进入核心冲突",
            "characters": "少量核心角色",
            "world": "只展开必要背景与规则",
            "subplot": "少支线，支线必须反哺主线",
            "outline": "按有限章节规划清晰起承转合",
        }
    if chapters <= 15:
        return {
            "scale": "中篇",
            "rhythm": "允许阶段反转，节奏保持稳步推进",
            "characters": "中等角色数量",
            "world": "可逐步展开一组核心规则",
            "subplot": "可有一条副线",
            "outline": "规划主要阶段和关键章节点",
        }
    if chapters <= 40:
        return {
            "scale": "长篇",
            "rhythm": "多阶段推进，允许铺垫与回收",
            "characters": "可多势力和多层关系",
            "world": "可建立较完整世界观",
            "subplot": "可铺设伏笔和多条辅助线",
            "outline": "规划分阶段主线、反转和阶段目标",
        }
    return {
        "scale": "超长连载",
        "rhythm": "多卷结构，长期成长线与阶段高潮交替",
        "characters": "多势力群像，但需要主次清晰",
        "world": "复杂世界观，可分层揭示",
        "subplot": "允许长线伏笔、多势力冲突和长期目标",
        "outline": "优先生成阶段性大纲，不必一次列满所有章节",
    }


def normalize_setting_options(raw_options: Any | None = None) -> SettingExpansionOptions:
    raw = raw_options if isinstance(raw_options, dict) else {}
    defaults = SettingExpansionOptions()

    try:
        expected_chapters = int(raw.get("expected_chapters", defaults.expected_chapters))
    except (TypeError, ValueError):
        expected_chapters = defaults.expected_chapters
    expected_chapters = min(200, max(1, expected_chapters))

    return SettingExpansionOptions(
        genre=_free_text_or_default(raw.get("genre"), defaults.genre),
        writing_style=_free_text_or_default(raw.get("writing_style"), defaults.writing_style),
        writing_mode=_option_value(raw.get("writing_mode"), WRITING_MODE_OPTIONS, defaults.writing_mode),
        expected_chapters=expected_chapters,
        plot_density=_option_value(raw.get("plot_density"), PLOT_DENSITY_OPTIONS, defaults.plot_density),
        narrative_pace=_option_value(raw.get("narrative_pace"), NARRATIVE_PACE_OPTIONS, defaults.narrative_pace),
        world_complexity=_option_value(raw.get("world_complexity"), WORLD_COMPLEXITY_OPTIONS, defaults.world_complexity),
        character_scale=_option_value(raw.get("character_scale"), CHARACTER_SCALE_OPTIONS, defaults.character_scale),
        outline_granularity=_option_value(
            raw.get("outline_granularity"),
            OUTLINE_GRANULARITY_OPTIONS,
            defaults.outline_granularity,
        ),
        extra_requirements=_clean(raw.get("extra_requirements")),
    )


def setting_options_to_dict(options: SettingExpansionOptions | dict[str, Any] | None) -> dict[str, Any]:
    normalized = normalize_setting_options(asdict(options) if isinstance(options, SettingExpansionOptions) else options)
    return asdict(normalized)


def format_setting_options_for_prompt(options: SettingExpansionOptions | dict[str, Any] | None) -> str:
    normalized = normalize_setting_options(asdict(options) if isinstance(options, SettingExpansionOptions) else options)
    scale = infer_story_scale(normalized.expected_chapters)
    lines = [
        f"- 小说类型：{normalized.genre}",
        f"- 写作风格：{normalized.writing_style}",
        f"- 写作模式：{normalized.writing_mode}",
        f"- 期望章节数：{normalized.expected_chapters}",
        f"- 自动推导篇幅规模：{scale['scale']}",
        f"- 节奏策略：{scale['rhythm']}",
        f"- 角色规模建议：{scale['characters']}；用户配置：{normalized.character_scale}",
        f"- 世界观复杂度建议：{scale['world']}；用户配置：{normalized.world_complexity}",
        f"- 支线与伏笔策略：{scale['subplot']}",
        f"- 大纲规划建议：{scale['outline']}；用户配置：{normalized.outline_granularity}",
        f"- 剧情密度：{normalized.plot_density}",
        f"- 叙事节奏：{normalized.narrative_pace}",
    ]
    if normalized.extra_requirements:
        lines.append(f"- 额外创作要求：{normalized.extra_requirements}")
    return "\n".join(lines)
