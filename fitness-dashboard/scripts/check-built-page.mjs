// Exercise the actual bundled inline script, including its dependency scope.
// This catches build-tool helpers accidentally injected into browser code.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const path = process.argv[2];
assert.ok(path, 'Pass the bundled Worker entry point');
// A data URL ensures ESM parsing even for bundles outside the package directory.
const bundle = await import('data:text/javascript;base64,' + Buffer.from(readFileSync(resolve(path))).toString('base64'));
const response = await bundle.default.fetch(new Request('https://fitness.test/'), {});
assert.equal(response.status, 200);
const html = await response.text();
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'Inline browser program exists');
const elements = new Map();
const calls = [];
const element = id => {
  if (!elements.has(id)) elements.set(id, { hidden: false, setAttribute() {}, addEventListener() {} });
  return elements.get(id);
};
runInNewContext(script, {
  document: { getElementById: element, querySelectorAll: () => [] },
  location: { href: 'https://fitness.test/' }, URL, URLSearchParams, AbortController,
  fetch: url => { calls.push(url); return new Promise(() => {}); },
}, { timeout: 1000 });
assert.deepEqual(calls, ['/api/dashboard?range=7']);
assert.equal(elements.get('dashboard').hidden, true);
console.log('Bundled HTML: inline script starts and requests dashboard data without external helpers.');
