// Resolve the same module instance the UI uses, including Vite's Windows /@fs/ URLs.
export async function installTestModuleLoader(context) {
  await context.addInitScript(() => {
    window.testModule = filename => {
      const storeUrl = performance.getEntriesByType('resource')
        .find(entry => new URL(entry.name).pathname.endsWith('/src/localStore.ts'))?.name;
      const base = storeUrl ? new URL('.', storeUrl) : new URL('/src/', location.origin);
      return import(new URL(filename, base).href);
    };
  });
}

// The browser context owns this private OPFS directory. Each page must reopen it explicitly.
export async function installTestWorkspace(context) {
  await installTestModuleLoader(context);
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('braipen-browser-test', { create: true });
      return {
        kind: directory.kind,
        name: directory.name,
        queryPermission: options => directory.queryPermission(options),
        requestPermission: options => directory.requestPermission(options),
        async getFileHandle(name, options) {
          const file = await directory.getFileHandle(name, options);
          if (!window.failTestWorkspaceWrite) return file;
          return {
            getFile: () => file.getFile(),
            async createWritable(options) {
              const stream = await file.createWritable(options);
              return {
                async write(blob) {
                  await window.failTestWorkspaceWrite?.(JSON.parse(await blob.text()));
                  await stream.write(blob);
                },
                close: () => stream.close(),
                abort: () => stream.abort(),
              };
            },
          };
        },
      };
    };
  });
}

export async function openTestWorkspace(page, allowReplace = false) {
  await page.waitForFunction(() => !document.getElementById('root') ||
    performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith('/src/localStore.ts')));
  await page.evaluate(async allowReplace => {
    const sync = await window.testModule('localFolderSync.ts');
    if (!await sync.chooseLocalFolder(allowReplace)) throw new Error('Could not open the test workspace');
  }, allowReplace);
}
