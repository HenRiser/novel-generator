import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/theme.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
function load(saved) {
  const exports = {};
  const properties = new Map([["--untouched", "keep"]]);
  const root = { dataset: { untouched: "keep" }, style: { setProperty: (key, value) => properties.set(key, value) } };
  const localStorage = { getItem: key => { assert.equal(key, "braipen.appearance.v1"); return saved; } };
  runInNewContext(outputText, { exports, window: { localStorage }, document: { documentElement: root }, require: () => ({ theme: { darkAlgorithm: "dark", defaultAlgorithm: "light" } }) });
  return { ...exports, root, properties };
}

test("默认铅印，已保存的三套主题可恢复，未知值不能成为样式", () => {
  for (const value of [null, "", "unknown", "night; color:red", '<script>', '"night"']) assert.equal(load(value).readAppearance(), "editorial");
  for (const value of ["editorial", "silver", "night"]) assert.equal(load(value).readAppearance(), value);
});

test("浏览器存储被禁用时仍能进入默认主题", () => {
  const exports = {};
  runInNewContext(outputText, { exports, window: { get localStorage() { throw new Error("blocked"); } }, require: () => ({ theme: {} }) });
  assert.equal(exports.readAppearance(), "editorial");
});

test("页面、阅读底色与组件共享同一份色板，不覆盖无关样式", () => {
  const theme = load(null);
  for (const appearance of ["editorial", "silver", "night"]) {
    theme.applyAppearance(appearance);
    const palette = theme.appearancePalettes[appearance];
    const config = theme.getAppearanceTheme(appearance);
    assert.equal(theme.root.dataset.appearance, appearance);
    assert.equal(theme.root.style.colorScheme, appearance === "night" ? "dark" : "light");
    for (const [name, color] of Object.entries(palette)) {
      assert.equal(theme.properties.get(`--${name}`), color);
      assert.equal(theme.properties.get(`--app-${name}`), color);
    }
    assert.equal(config.token.colorPrimary, theme.properties.get("--accent"));
    assert.equal(config.token.colorText, theme.properties.get("--ink"));
    assert.equal(config.components.Button.primaryColor, palette["on-accent"]);
    assert.equal(config.token.colorTextLightSolid, "#ffffff", "dark tooltip text must stay light even when primary buttons use dark text");
    assert.equal(config.algorithm, appearance === "night" ? "dark" : "light");
  }
  assert.equal(theme.properties.get("--untouched"), "keep");
  assert.equal(theme.root.dataset.untouched, "keep");
});

const luminance = hex => {
  const values = hex.slice(1).match(/../g).map(part => parseInt(part, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
test("三套主题的正文、说明文字和主要按钮满足普通文字对比度", () => {
  for (const [name, palette] of Object.entries(load(null).appearancePalettes)) {
    for (const background of ["paper", "surface", "surface-soft"]) {
      for (const foreground of ["ink", "muted", "faint"]) assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${name} ${foreground}/${background}`);
    }
    assert.ok(contrast(palette["on-accent"], palette.accent) >= 4.5, `${name} primary button`);
  }
});
