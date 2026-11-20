# -*- coding: utf-8 -*-
"""Braipen 真实 DeepSeek API 全链路冒烟测试（deepseek-v4-flash）。

覆盖：健康检查 → 创建项目 → 生成大纲/人物卡 → 读取章节列表 →
      流式生成第 1 章 → 读取正文 → 对话式续写 → 知识草稿检查 →
      一致性/状态接口 → 清理测试项目。
"""
import json
import sys
import time
import urllib.request
import urllib.error
from uuid import uuid4

from project_context import BOOK_ID_PATTERN

BASE = "http://127.0.0.1:8000"
PASS = 0
FAIL = 0
FAILURES: list[str] = []


def req_stream(method: str, path: str, body: dict | None = None):
    """流式请求：逐行读取 NDJSON，返回 (status, lines)。"""
    url = f"{BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    r.add_header("Accept", "application/x-ndjson")
    lines: list[str] = []
    try:
        with urllib.request.urlopen(r, timeout=900) as resp:
            status = resp.status
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if line:
                    lines.append(line)
            return status, lines
    except urllib.error.HTTPError as e:
        return e.code, lines
    except Exception as e:
        return 0, [f'{{"type":"error","message":{json.dumps(str(e))}}}']


def req(method: str, path: str, body: dict | None = None, stream: bool = False):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if stream:
        r.add_header("Accept", "application/x-ndjson")
    try:
        with urllib.request.urlopen(r, timeout=600) as resp:
            if stream:
                return resp.status, resp.read().decode("utf-8")
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = {"error": {"message": str(e)}}
        return e.code, payload


def check(name: str, ok: bool, detail: str = ""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        FAILURES.append(name)
        print(f"  ✗ {name} — {detail}")


def owns_test_project(ref: object, title: str) -> bool:
    if not isinstance(ref, str) or not ref.startswith("book:") or not BOOK_ID_PATTERN.fullmatch(ref[5:]):
        return False
    code, project = req("GET", f"/api/projects/{ref}")
    return (code == 200 and isinstance(project, dict)
            and project.get("project_ref") == ref and project.get("title") == title)


def main():
    print("=" * 60)
    print("Braipen 真实 API 全链路测试 (deepseek-v4-flash)")
    print("=" * 60)

    # 1. 健康检查
    print("\n[1] 健康检查")
    code, resp = req("GET", "/api/health")
    healthy = code == 200 and isinstance(resp, dict) and resp.get("status") == "ok"
    check("GET /api/health", healthy, str(resp))
    if not healthy:
        return 1

    # 2. 项目列表（应为空）
    print("\n[2] 项目列表（清理后应为空）")
    code, resp = req("GET", "/api/projects")
    check("项目列表返回", code == 200, str(resp))
    empty = code == 200 and resp == []
    check("项目列表为空", empty, "冒烟测试需要空工作区。")
    if not empty:
        return 1

    # 3. 创建项目
    print("\n[3] 创建测试项目")
    project_body = {
        "title": f"全链路测试《灰剧场》-{uuid4().hex}",
        "seed_prompt": "一个在废弃剧场后台长大的少女，偶然发现剧场地下藏着一整座消失的城市。她要找出这座城消失的真相，并决定是否让整座城重现人间。",
        "genre": "悬疑",
        "style": "冷峻克制的悬疑笔调，短句，少用形容词",
        "model": "deepseek-v4-flash",
        "max_tokens": 8192,
        "temperature": 1.0,
    }
    code, resp = req("POST", "/api/projects", project_body)
    created = code == 200 and isinstance(resp, dict) and resp.get("ok") is True
    check("POST /api/projects", created, str(resp)[:200])
    if not created:
        return 1
    ref = resp.get("project_ref")
    title = project_body["title"]
    owned = resp.get("title") == title and owns_test_project(ref, title)
    check("返回本轮创建的工作区项目", owned)
    if not owned:
        return 1
    print(f"    项目 ref: {ref}")

    try:
        exercise_project(ref)
    finally:
        print("\n[13] 清理测试项目")
        try:
            if owns_test_project(ref, title):
                code, deleted = req("DELETE", f"/api/projects/{ref}")
                removed = (code == 200 and isinstance(deleted, dict)
                           and deleted.get("ok") is True and deleted.get("project_ref") == ref)
                check("DELETE project", removed, str(deleted)[:200])
            else:
                check("清理前核对项目归属", False, "无法确认本轮创建的项目，已停止清理。")
        except Exception as exc:
            check("DELETE project", False, str(exc))
    code, resp = req("GET", "/api/projects")
    check("项目列表回到空", code == 200 and resp == [])

    print("\n" + "=" * 60)
    print(f"结果: {PASS} 通过 / {FAIL} 失败")
    if FAILURES:
        print("失败项:")
        for name in FAILURES:
            print(f"  - {name}")
    print("=" * 60)
    return 1 if FAIL else 0


def exercise_project(ref: str):
    # 4. 生成大纲与人物卡
    print("\n[4] 生成大纲与人物卡（真实 DeepSeek 调用）")
    gen_body = {"model": "deepseek-v4-flash", "temperature": 1.0}
    t0 = time.time()
    code, resp = req("POST", f"/api/projects/{ref}/outline-characters/generate", gen_body)
    elapsed = time.time() - t0
    check("大纲/人物卡生成", code == 200 and resp.get("ok"), str(resp)[:300])
    check("返回文件路径", bool(resp.get("outline_file")) and bool(resp.get("characters_file")), str(resp)[:200])
    print(f"    耗时 {elapsed:.1f}s | outline: {resp.get('outline_file','')}")

    # 5. 章节列表（应包含第 1 章？大纲生成后章节可能为空，需要先生成）
    print("\n[5] 章节列表")
    code, resp = req("GET", f"/api/projects/{ref}/chapters")
    check("GET chapters", code == 200, str(resp)[:200])
    chapters_before = resp if isinstance(resp, list) else []
    print(f"    生成前章节数: {len(chapters_before)}")

    # 6. 流式生成第 1 章（关键链路）—— 不显式传 max_tokens，验证修复后的默认值 16384
    print("\n[6] 流式生成第 1 章（NDJSON 流式，默认参数）")
    stream_body = {
        "model": "deepseek-v4-flash",
        "temperature": 1.0,
        "writing_mode": "draft",
    }
    t0 = time.time()
    code, lines = req_stream("POST", f"/api/projects/{ref}/chapters/1/generate/stream", stream_body)
    elapsed = time.time() - t0
    check("流式接口 HTTP 200", code == 200, f"HTTP {code}")
    delta_chars = 0
    done_event = None
    error_event = None
    for line in lines:
        if not line.strip():
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if evt.get("type") == "delta":
            delta_chars += len(evt.get("text", ""))
        elif evt.get("type") == "done":
            done_event = evt
        elif evt.get("type") == "error":
            error_event = evt
    check("收到 delta 内容", delta_chars > 500, f"仅 {delta_chars} 字符")
    check("收到 done 事件", done_event is not None, f"error_event={error_event}")
    check("done 标记 ok", bool(done_event and done_event.get("ok")), str(done_event)[:200])
    print(f"    耗时 {elapsed:.1f}s | 生成 {delta_chars} 字符 | 章节标题: {done_event.get('title','') if done_event else '-'}")

    # 7. 读取第 1 章正文
    print("\n[7] 读取第 1 章正文")
    code, resp = req("GET", f"/api/projects/{ref}/chapters/1")
    check("GET chapter/1", code == 200, str(resp)[:200])
    content = resp.get("content", "") if isinstance(resp, dict) else ""
    check("正文非空", len(content) > 300, f"仅 {len(content)} 字符")
    print(f"    正文长度: {len(content)} 字符")

    # 8. 章节状态
    print("\n[8] 章节状态")
    code, resp = req("GET", f"/api/projects/{ref}/chapters/1/status")
    check("GET chapter/1/status", code == 200 and resp.get("ok"), str(resp)[:200])
    status = resp.get("chapter_status", {}) if isinstance(resp, dict) else {}
    check("章节文件已生成", bool(status.get("chapter", {}).get("exists")), str(status)[:300])

    # 9. 对话式续写（真实 DeepSeek 流式）
    print("\n[9] 对话式续写（真实 DeepSeek 流式）")
    continue_body = {
        "context_text": content[:3000],
        "instruction": "用更悬疑的笔调续写一段：少女在剧场地下城发现了一面会说话的镜子。",
        "model": "deepseek-v4-flash",
        "temperature": 0.9,
    }
    t0 = time.time()
    code, lines = req_stream("POST", f"/api/projects/{ref}/chapters/1/continue", continue_body)
    elapsed = time.time() - t0
    check("续写接口 HTTP 200", code == 200, f"HTTP {code}")
    cont_chars = 0
    cont_ok = False
    cont_err = None
    for line in lines:
        if not line.strip():
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if evt.get("type") == "delta":
            cont_chars += len(evt.get("text", ""))
        elif evt.get("type") == "done":
            cont_ok = True
        elif evt.get("type") == "error":
            cont_err = evt
    check("续写产生内容", cont_chars > 100, f"仅 {cont_chars} 字符")
    check("续写 done", cont_ok, str(cont_err)[:200])
    print(f"    耗时 {elapsed:.1f}s | 续写 {cont_chars} 字符")

    # 10. 章节任务单与场景计划接口（读接口，验证路由挂载）
    print("\n[10] 规划类接口")
    code, resp = req("GET", f"/api/projects/{ref}/chapter-tasks/1")
    check("GET chapter-tasks/1", code == 200, str(resp)[:200])
    code, resp = req("GET", f"/api/projects/{ref}/scene-plans/1")
    check("GET scene-plans/1", code == 200, str(resp)[:200])

    # 11. 工作流守卫（生成前检查）
    print("\n[11] 工作流守卫")
    code, resp = req("POST", f"/api/projects/{ref}/workflow-guard/check", {"action": "generate_chapter", "chapter_number": 2})
    check("workflow-guard/check", code == 200 and resp.get("ok"), str(resp)[:200])

    # 12. 导出接口（返回纯文本）
    print("\n[12] 导出接口")
    try:
        url = f"{BASE}/api/projects/{ref}/exports/chapters/1.txt"
        with urllib.request.urlopen(url, timeout=30) as resp:
            text = resp.read().decode("utf-8")
        check("导出第 1 章 TXT", resp.status == 200 and len(text) > 200, f"HTTP {resp.status}, {len(text)} 字符")
    except Exception as e:
        check("导出第 1 章 TXT", False, str(e))


if __name__ == "__main__":
    sys.exit(main())
