import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const key = "braipen.workspace-preferences.v1";
const source = readFileSync(new URL("../src/workspacePreferences.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const load = (localStorage) => {
  const exports = {};
  runInNewContext(outputText, { exports, localStorage });
  return exports;
};
const storage = (initial) => {
  let value = initial;
  return {
    getItem(name) { assert.equal(name, key); return value ?? null; },
    setItem(name, next) { assert.equal(name, key); value = next; },
  };
};

test("旧字号、项目、章节和阅读进度保留，新偏好使用默认值", () => {
  const previous = {
    recentProject: "example",
    fontSize: 15,
    projects: { example: { chapterNumber: 8, writingTab: "reader" } },
    positions: { '["example",8]': { version: "revision-1", progress: 0.45 } },
  };
  const saved = storage(JSON.stringify(previous));
  const preferences = load(saved);
  assert.equal(preferences.getReaderFontSize(), 15);
  assert.equal(preferences.getReaderFont(), "serif");
  assert.equal(preferences.getReaderTheme(), "auto");
  assert.equal(preferences.getRememberedProject(), "example");
  assert.equal(preferences.getProjectWorkspace("example").chapterNumber, 8);
  assert.equal(preferences.getProjectWorkspace("example").writingTab, "reader");
  assert.equal(preferences.getReadingPosition("example", 8, "revision-1"), 0.45);
  preferences.rememberReaderTheme("night");
  const persisted = JSON.parse(saved.getItem(key));
  assert.deepEqual(persisted.projects, previous.projects);
  assert.deepEqual(persisted.positions, previous.positions);
  assert.equal(persisted.recentProject, previous.recentProject);
});

test("非法阅读偏好回退，合法范围包含旧小字号与新增大字号", () => {
  for (const fontSize of [null, "20", 13, 29, 18.5]) {
    const preferences = load(storage(JSON.stringify({ fontSize, font: {}, theme: "unknown" })));
    assert.equal(preferences.getReaderFontSize(), 18);
    assert.equal(preferences.getReaderFont(), "serif");
    assert.equal(preferences.getReaderTheme(), "auto");
  }
  for (const fontSize of [14, 15, 23, 28]) {
    assert.equal(load(storage(JSON.stringify({ fontSize }))).getReaderFontSize(), fontSize);
  }
});

test("字号四舍五入并限制范围，非有限数字和非法枚举不污染会话", () => {
  const preferences = load(storage());
  for (const [input, expected] of [[0, 14], [99, 28], [19.6, 20]]) {
    preferences.rememberReaderFontSize(input);
    assert.equal(preferences.getReaderFontSize(), expected);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) preferences.rememberReaderFontSize(invalid);
  assert.equal(preferences.getReaderFontSize(), 20);
  preferences.rememberReaderFont("unknown");
  preferences.rememberReaderTheme(null);
  assert.equal(preferences.getReaderFont(), "serif");
  assert.equal(preferences.getReaderTheme(), "auto");
});

test("阅读偏好写入同一存储，并在重新加载后恢复", () => {
  const saved = storage();
  const preferences = load(saved);
  preferences.rememberReaderFontSize(26);
  preferences.rememberReaderFont("sans");
  preferences.rememberReaderTheme("night");
  const reloaded = load(saved);
  assert.equal(reloaded.getReaderFontSize(), 26);
  assert.equal(reloaded.getReaderFont(), "sans");
  assert.equal(reloaded.getReaderTheme(), "night");
  for (const theme of ["auto", "paper", "white", "night"]) {
    reloaded.rememberReaderTheme(theme);
    assert.equal(load(saved).getReaderTheme(), theme);
  }
});

test("损坏或不可用的浏览器存储不阻断会话内偏好", () => {
  const unavailable = {
    getItem() { throw new Error("Storage blocked"); },
    setItem() { throw new Error("Storage blocked"); },
  };
  for (const saved of [storage("{broken"), storage("null"), storage("[]"), unavailable, undefined]) {
    const preferences = load(saved);
    assert.equal(preferences.getReaderFontSize(), 18);
    preferences.rememberReaderFontSize(22);
    preferences.rememberReaderFont("sans");
    preferences.rememberReaderTheme("paper");
    assert.equal(preferences.getReaderFontSize(), 22);
    assert.equal(preferences.getReaderFont(), "sans");
    assert.equal(preferences.getReaderTheme(), "paper");
  }
});
