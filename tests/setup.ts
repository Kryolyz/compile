/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test setup file - runs before all tests
 * Installs localStorage shim for Node.js test environment
 */

// Install localStorage shim for Node.js
if (typeof localStorage === 'undefined') {
    const store = new Map<string, string>();
    (global as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}
