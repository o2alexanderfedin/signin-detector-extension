/// <reference types="chrome" />

import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PLT-03 -- MV3 requires every event listener that must survive a
 * service-worker restart to be registered SYNCHRONOUSLY, at the top level
 * of the script, with no `await`/`.then()` in front of it (Chrome only
 * replays buffered events to listeners attached during the very first,
 * synchronous turn of script execution).
 *
 * `entrypoints/background.ts` exports `defineBackground(main)`, and WXT's
 * real background-entrypoint wrapper calls `definition.main()` SYNCHRONOUSLY
 * immediately after importing this module (see
 * `wxt/dist/virtual/background-entrypoint.mjs`: `result = definition.main()`,
 * with no `await` in between) -- so calling `.main()` here, synchronously,
 * right after import, and asserting immediately afterward with NO further
 * `await`, faithfully reproduces the real synchronous-registration
 * invariant this module must uphold.
 *
 * `chrome`/`browser` are globally stubbed to `fakeBrowser` by WXT's Vitest
 * plugin (see vitest.config.ts). `fakeBrowser` does not implement
 * `chrome.cookies`/`chrome.webRequest` (same gap `cookieSensor.test.ts`/
 * `networkSensor.test.ts` document), so minimal stand-ins are attached
 * directly to the shared global `chrome` object before importing.
 *
 * Deliberately lives under `tests/entrypoints/`, NOT beside
 * `entrypoints/background.ts` itself -- WXT's entrypoint discovery
 * (`findEntrypoints`) scans every file directly under `entrypoints/` and
 * derives an entrypoint's name from the text before its FIRST `.`, so a
 * co-located `entrypoints/background.test.ts` collides with
 * `entrypoints/background.ts` under the name "background" and breaks
 * `wxt build`/`wxt prepare` ("Multiple entrypoints with the same name").
 */
describe('entrypoints/background.ts (PLT-03)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    // `content/messaging.ts` holds a module-level messenger singleton that
    // only allows ONE `sensorSignal` listener per JS context (see its own
    // doc comment) -- reset the module graph so each test's dynamic
    // `import('../../entrypoints/background')` re-executes that
    // singleton's construction fresh, rather than throwing on a second
    // `onSensorSignal` registration left over from a previous test in this
    // file.
    vi.resetModules();
  });

  it('registers cookies.onChanged, webRequest.onCompleted, runtime.onMessage, and tabs.onRemoved synchronously -- no await before any addListener call', async () => {
    const cookiesOnChangedAddListener = vi.fn();
    const webRequestOnCompletedAddListener = vi.fn();

    // fakeBrowser has no `cookies`/`webRequest` namespace at all -- attach
    // minimal stand-ins onto the SAME shared global object `chrome`/
    // `browser` both alias, so `entrypoints/background.ts`'s own
    // `chrome.cookies.onChanged.addListener(...)` call has something to
    // call into.
    Object.assign(globalThis.chrome, {
      cookies: {
        getAll: vi.fn().mockResolvedValue([]),
        onChanged: { addListener: cookiesOnChangedAddListener, removeListener: vi.fn() },
      },
      webRequest: {
        onCompleted: { addListener: webRequestOnCompletedAddListener, removeListener: vi.fn() },
      },
    });

    const runtimeOnMessageAddListenerSpy = vi.spyOn(chrome.runtime.onMessage, 'addListener');
    const tabsOnRemovedAddListenerSpy = vi.spyOn(chrome.tabs.onRemoved, 'addListener');

    // Importing the module only evaluates `defineBackground(() => {...})`
    // -- it does NOT invoke the callback (WXT's `defineBackground` just
    // returns `{ main }`; see `wxt/dist/utils/define-background.mjs`).
    const mod = await import('../../entrypoints/background');

    expect(cookiesOnChangedAddListener).not.toHaveBeenCalled();
    expect(webRequestOnCompletedAddListener).not.toHaveBeenCalled();
    expect(runtimeOnMessageAddListenerSpy).not.toHaveBeenCalled();
    expect(tabsOnRemovedAddListenerSpy).not.toHaveBeenCalled();

    // Synchronous call, exactly mirroring WXT's real background-entrypoint
    // wrapper (`result = definition.main()`, no await). Every assertion
    // below runs with NO further `await` between this call and the checks.
    mod.default.main();

    expect(cookiesOnChangedAddListener).toHaveBeenCalledTimes(1);
    expect(webRequestOnCompletedAddListener).toHaveBeenCalledTimes(1);
    expect(runtimeOnMessageAddListenerSpy).toHaveBeenCalledTimes(1);
    expect(tabsOnRemovedAddListenerSpy).toHaveBeenCalledTimes(1);
  });

  it('the webRequest.onCompleted registration requests responseHeaders only -- never a body extraInfoSpec (PRV-01/SEN-03)', async () => {
    const webRequestOnCompletedAddListener = vi.fn();
    Object.assign(globalThis.chrome, {
      cookies: { getAll: vi.fn().mockResolvedValue([]), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
      webRequest: { onCompleted: { addListener: webRequestOnCompletedAddListener, removeListener: vi.fn() } },
    });

    const mod = await import('../../entrypoints/background');
    mod.default.main();

    const [, , extraInfoSpec] = webRequestOnCompletedAddListener.mock.calls[0] as [unknown, unknown, readonly string[]];
    expect(extraInfoSpec).toEqual(['responseHeaders']);
  });
});
