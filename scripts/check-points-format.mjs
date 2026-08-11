import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `Fonction ${name} introuvable`);
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Corps de ${name} incomplet`);
}

const context = { Intl };
vm.createContext(context);
vm.runInContext([
  functionSource('hasStatValue'),
  functionSource('parseLocalizedPoints'),
  functionSource('formatPoints'),
].join('\n'), context);

const examples = new Map([
  ['12 345 678', '12 345 678'],
  ['12,345,678', '12 345 678'],
  ['123456,78', '123 456,78'],
  ['123456.78', '123 456,78'],
]);

for (const [input, expected] of examples) {
  assert.equal(context.formatPoints(input), expected, input);
}
assert.equal(context.parseLocalizedPoints('12,345,678').number, 12345678);
assert.equal(context.parseLocalizedPoints('123456,78').number, 123456.78);

console.log('Points format checks OK: thousands and decimals use the French convention.');
