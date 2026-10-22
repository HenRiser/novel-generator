import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

export function loadStyleModule(extra = {}) {
  const exports = {};
  const output = ts.transpileModule(readFileSync(new URL('../src/writingStyle.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(output, { exports, structuredClone, crypto: webcrypto, ...extra });
  return exports;
}

export function loadActivityModule() {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/workspaceActivity.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports });
  return exports;
}

/** Transactional event adapter, including rollback, for the real localStore module. */
export function memoryStyleStore({ beforeBrowserWrite } = {}) {
  const rows = { projects: new Map(), settings: new Map(), imports: new Map(), cover_media: new Map() };
  const db = { transaction(names, mode) {
    if (mode === 'readwrite') beforeBrowserWrite?.();
    const working = Object.fromEntries(names.map(name => [name, structuredClone(rows[name])])), tx = {};
    let pending = 0, closed = false;
    const complete = () => queueMicrotask(() => {
      if (closed || pending) return; closed = true;
      if (mode === 'readwrite') for (const name of names) rows[name] = working[name];
      tx.oncomplete?.();
    });
    const request = fn => {
      const r = {}; pending++;
      queueMicrotask(() => {
        if (closed) return;
        try { r.result = fn(); r.onsuccess?.({ target: r }); }
        catch (error) { tx.error = error; tx.abort(); }
        pending--; if (!pending) complete();
      }); return r;
    };
    tx.abort = () => { if (closed) return; closed = true; queueMicrotask(() => tx.onabort?.()); };
    tx.objectStore = name => {
      assert.ok(working[name]);
      return { get: key => request(() => structuredClone(working[name].get(key))), getAll: () => request(() => [...working[name].values()].map(v => structuredClone(v))),
        put: value => request(() => { working[name].set(name === 'settings' ? value.key : name === 'projects' ? value.project_ref : value.id, structuredClone(value)); }),
        add: value => request(() => { const key = name === 'settings' ? value.key : name === 'projects' ? value.project_ref : value.id; if (working[name].has(key)) throw new Error('duplicate'); working[name].set(key, structuredClone(value)); }),
        delete: key => request(() => working[name].delete(key)),
        clear: () => request(() => working[name].clear()),
      };
    };
    complete(); return tx;
  } };
  const indexedDB = { open() { const r = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
  const style = loadStyleModule(), activity = loadActivityModule(), exports = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/localStore.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, indexedDB, structuredClone, queueMicrotask, Blob, TextEncoder, DOMException, crypto: webcrypto, atob, btoa,
    require: name => { if (name === './writingStyle') return style; if (name === './workspaceActivity') return activity; if (name === './planningTrace') return {}; throw new Error(name); },
  });
  const types = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/localTypes.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: types, crypto: webcrypto });
  return { store: exports, style, activity, types, rows };
}
