import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
// Vite normally injects these values at build time; isolate each environment here.
const { outputText } = ts.transpileModule(source.replaceAll("import.meta.env", "viteEnv"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

async function checkOrigin(viteEnv, expected) {
  const exports = {};
  const requests = [];
  runInNewContext(outputText, {
    exports,
    viteEnv,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ status: "ok" }) };
    },
  });
  assert.equal(exports.API_BASE_URL, expected);
  await exports.getHealth();
  assert.equal(requests[0], `${expected}/api/health`);
}

test("生产构建未配置 API 地址时请求同源服务", async () => {
  await checkOrigin({ PROD: true }, "");
});

test("开发环境保留本地 8000 默认服务", async () => {
  await checkOrigin({ PROD: false }, "http://127.0.0.1:8000");
});

test("显式空值与斜杠选择同源，外部 API 地址去除尾斜杠", async () => {
  for (const PROD of [true, false]) {
    for (const VITE_API_BASE_URL of ["", "/"]) await checkOrigin({ PROD, VITE_API_BASE_URL }, "");
    await checkOrigin({ PROD, VITE_API_BASE_URL: "https://api.example.test///" }, "https://api.example.test");
  }
});
