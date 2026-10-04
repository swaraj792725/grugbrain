/**
 * The long-session bench task: one Claude Code session, six prompts in a row (resumed), in a shop repo of about 25
 * files. It is where context piles up (reads from step 1 are still re-sent in step 6), which the one-prompt tasks
 * never reach. Graded at the end by a check script Claude never sees.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SHOP_STEPS = [
  'Read through this project and explain in at most 6 bullets how an order goes from cart to receipt (which modules, in which order). Do not change anything.',
  'Add percentage discount codes: export applyDiscount(cents, code) from src/discounts.js, using the codes in config/discounts.json (an unknown or missing code means no discount; round to whole cents). checkout() in src/checkout.js should accept an optional third argument `code` and apply it to the subtotal before tax and shipping. Keep the existing tests passing.',
  'Run the test suite (npm test) and fix whatever fails. Fix the code, not the tests.',
  'Where is the free-shipping threshold set? Change it from 50 to 75 dollars everywhere it is actually used.',
  'Rename the function calcTax to computeTax everywhere in the codebase (definition, imports, calls).',
  'Add tests for the discount feature to test.js and make sure npm test passes. Then summarize in a few lines what changed in this session.'
];

const MODULES: [string, string[]][] = [
  ['catalog', ['listProducts', 'productById', 'searchProducts', 'productsInCategory']],
  ['inventory', ['stockFor', 'reserveStock', 'releaseStock', 'lowStockReport']],
  ['users', ['userById', 'createUser', 'updateEmail', 'deactivateUser']],
  ['auth', ['hashPassword', 'checkPassword', 'issueToken', 'verifyToken']],
  ['addresses', ['normalizeAddress', 'isDomestic', 'formatAddress', 'postcodeZone']],
  ['payments', ['authorizeCard', 'captureCharge', 'refundCharge', 'maskCard']],
  ['notifications', ['orderEmail', 'shippingEmail', 'refundEmail', 'queueEmail']],
  ['analytics', ['trackEvent', 'dailyRevenue', 'topProducts', 'conversionRate']],
  ['reviews', ['addReview', 'reviewsFor', 'averageRating', 'flagReview']],
  ['wishlist', ['addToWishlist', 'removeFromWishlist', 'wishlistFor', 'moveToCart']],
  ['returns', ['openReturn', 'approveReturn', 'returnWindowOpen', 'restock']],
  ['currency', ['formatCents', 'parsePrice', 'roundCents', 'convert']],
  ['logger', ['logInfo', 'logWarn', 'logError', 'withContext']],
  ['cache', ['cacheGet', 'cacheSet', 'cacheDelete', 'cacheStats']]
];

/** A plausible filler module: four small functions over an in-memory table. */
function filler(name: string, fns: string[]): string {
  const table = `${name.toUpperCase()}_TABLE`;
  const lines = [`// ${name}: part of the shop backend. In-memory for the demo; a database in production.`, `const ${table} = new Map();`, ''];
  fns.forEach((fn, i) => {
    lines.push(
      `/** ${fn.replace(/([A-Z])/g, ' $1').toLowerCase()} */`,
      `export function ${fn}(id, value = null) {`,
      `  if (id === undefined || id === null) throw new Error('${name}.${fn}: id is required');`,
      `  const row = ${table}.get(id) || { id, version: 0, history: [] };`,
      `  row.version += ${i + 1};`,
      `  row.history.push({ op: '${fn}', value, at: row.version });`,
      `  if (row.history.length > 20) row.history.shift();`,
      `  ${table}.set(id, row);`,
      `  return value === null ? row : { ...row, value };`,
      `}`,
      ''
    );
  });
  return lines.join('\n');
}

export function shopFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'bench-shop', type: 'module', private: true, scripts: { test: 'node test.js' } }, null, 2),
    'README.md': '# shop\n\nSmall shop backend. `npm test` runs the checks. Order flow lives in src/cart.js, src/checkout.js, src/tax.js, src/shipping.js and src/receipt.js.\n',
    'config/discounts.json': JSON.stringify({ SAVE10: 10, WELCOME15: 15, HALFOFF: 50 }, null, 2),
    'config/shop.json': JSON.stringify({ currency: 'USD', taxRate: 0.08, freeShippingOverCents: 5000, flatShippingCents: 599 }, null, 2),
    'src/config.js': `import fs from 'node:fs';\nconst here = new URL('../config/', import.meta.url);\nexport const shop = JSON.parse(fs.readFileSync(new URL('shop.json', here), 'utf8'));\n`,
    'src/cart.js': `export function cart(lines = []) {\n  return { lines: lines.map((l) => ({ sku: l.sku, cents: l.cents, qty: l.qty ?? 1 })) };\n}\nexport function subtotal(c) {\n  return c.lines.reduce((s, l) => s + l.cents * l.qty, 0);\n}\n`,
    'src/tax.js': `import { shop } from './config.js';\nexport function calcTax(cents) {\n  return Math.round(cents * shop.taxRate);\n}\n`,
    // Trap for step 4: the threshold also lives here as a hard-coded number, and this is the one checkout uses.
    'src/shipping.js': `import { shop } from './config.js';\nconst FREE_OVER = 5000; // cents\nexport function shippingFor(subtotalCents) {\n  // Bug for step 3: an order of exactly the threshold should ship free.\n  return subtotalCents > FREE_OVER ? 0 : shop.flatShippingCents;\n}\nexport function freeShippingNote() {\n  return 'Free shipping over $' + shop.freeShippingOverCents / 100;\n}\n`,
    'src/checkout.js': `import { subtotal } from './cart.js';\nimport { calcTax } from './tax.js';\nimport { shippingFor } from './shipping.js';\nimport { logInfo } from './logger.js';\nexport function checkout(c, customer) {\n  const sub = subtotal(c);\n  const tax = calcTax(sub);\n  const shipping = shippingFor(sub);\n  logInfo(customer?.id ?? 'guest', { sub, tax, shipping });\n  return { subtotal: sub, tax, shipping, total: sub + tax + shipping };\n}\n`,
    'src/receipt.js': `import { calcTax } from './tax.js';\nimport { formatCents } from './currency.js';\nexport function receipt(order) {\n  return ['Subtotal ' + formatCents(order.subtotal), 'Tax ' + formatCents(order.tax), 'Shipping ' + formatCents(order.shipping), 'Total ' + formatCents(order.total)].join('\\n');\n}\nexport function taxLine(cents) {\n  return 'Tax ' + formatCents(calcTax(cents));\n}\n`,
    'src/discounts.js': `// Discount codes: to be implemented.\n`,
    'test.js': `import { cart } from './src/cart.js';
import { checkout } from './src/checkout.js';
import { shippingFor } from './src/shipping.js';
import { shop } from './src/config.js';
let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log(' ✓ ' + name); } catch (e) { failed++; console.log(' × ' + name + ': ' + e.message); } }
const eq = (a, b) => { if (a !== b) throw new Error('expected ' + JSON.stringify(b) + ' but got ' + JSON.stringify(a)); };
for (let i = 1; i <= 120; i++) t('subtotal of ' + i + ' item(s)', () => eq(checkout(cart([{ sku: 'x', cents: 100, qty: i }])).subtotal, i * 100));
t('tax is 8%', () => eq(checkout(cart([{ sku: 'a', cents: 1000 }])).tax, 80));
t('small order pays shipping', () => eq(checkout(cart([{ sku: 'a', cents: 1000 }])).shipping, 599));
t('order at the threshold ships free', () => eq(shippingFor(shop.freeShippingOverCents), 0));
console.log('\\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
`
  };
  for (const [name, fns] of MODULES) files[`src/${name}.js`] = filler(name, fns);
  // currency.formatCents and logger.logInfo are used by the order flow; give them real bodies.
  files['src/currency.js'] = files['src/currency.js'].replace(/export function formatCents\(id, value = null\) \{[\s\S]*?\n\}\n/, "export function formatCents(cents) {\n  return '$' + (cents / 100).toFixed(2);\n}\n");
  files['src/logger.js'] = files['src/logger.js'].replace(/export function logInfo\(id, value = null\) \{[\s\S]*?\n\}\n/, 'export function logInfo(who, data) {\n  if (process.env.SHOP_DEBUG) console.log(who, JSON.stringify(data));\n}\n');
  return files;
}

const HIDDEN_CHECK = `import fs from 'node:fs';
const fail = (m) => { console.error(m); process.exit(1); };
const { cart } = await import('./src/cart.js');
const { checkout } = await import('./src/checkout.js');
const { shippingFor } = await import('./src/shipping.js');
const disc = await import('./src/discounts.js');
const tax = await import('./src/tax.js');
if (typeof disc.applyDiscount !== 'function') fail('no applyDiscount');
if (disc.applyDiscount(1000, 'SAVE10') !== 900) fail('SAVE10 on 1000 should be 900');
if (disc.applyDiscount(999, 'WELCOME15') !== 849) fail('WELCOME15 on 999 should be 849');
if (disc.applyDiscount(1000, 'NOPE') !== 1000 || disc.applyDiscount(1000) !== 1000) fail('unknown/missing code should not discount');
const o = checkout(cart([{ sku: 'a', cents: 10000 }]), null, 'HALFOFF');
if (o.total !== 5000 + 400 + 599 && o.total !== 5000 + 400) fail('checkout with HALFOFF on 10000: total ' + o.total + ', want 5999 (or 5400 if shipping uses the full subtotal)');
if (shippingFor(6000) === 0) fail('6000 cents should pay shipping after the threshold moved to $75');
if (shippingFor(7500) !== 0 || shippingFor(8000) !== 0) fail('7500 and 8000 cents should ship free');
const shopCfg = JSON.parse(fs.readFileSync('config/shop.json', 'utf8'));
if (shopCfg.freeShippingOverCents !== 7500) fail('config freeShippingOverCents should be 7500');
if (typeof tax.computeTax !== 'function' || 'calcTax' in tax) fail('calcTax should be renamed computeTax');
for (const f of fs.readdirSync('src')) if (/\\bcalcTax\\b/.test(fs.readFileSync('src/' + f, 'utf8'))) fail('calcTax still in src/' + f);
if (!/applyDiscount|discount/i.test(fs.readFileSync('test.js', 'utf8'))) fail('no discount tests in test.js');
console.log('ok');
`;

export function shopCheck(dir: string): { pass: boolean; why: string } {
  const t = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', timeout: 30000 }); // what `npm test` runs
  if (t.status !== 0) return { pass: false, why: 'npm test fails: ' + (t.stdout || t.stderr || '').split('\n').filter((l) => /×|Error/.test(l))[0]?.trim().slice(0, 90) };
  const f = path.join(dir, '.grug-hidden-check.mjs');
  fs.writeFileSync(f, HIDDEN_CHECK);
  const r = spawnSync(process.execPath, [f], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  fs.rmSync(f, { force: true });
  return r.status === 0 ? { pass: true, why: 'all 6 steps done' } : { pass: false, why: (r.stderr || r.stdout || '').trim().split('\n')[0].slice(0, 100) };
}
