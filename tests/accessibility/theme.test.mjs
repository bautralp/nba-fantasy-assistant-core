import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const css = readFileSync(new URL('../../src/shared/styles.css', import.meta.url), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(m => [m[1], m[2]]));
const luminance = hex => { const c = hex.slice(1).match(/../g).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4); return c[0]*.2126+c[1]*.7152+c[2]*.0722; };
const contrast = (a,b) => { const x=luminance(tokens[a]), y=luminance(tokens[b]); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
for (const bg of ['background','surface','surface-alt','accent-soft']) for (const fg of ['text','muted','link','danger','success']) test(`${fg} / ${bg} meets AA text contrast`, () => { assert.ok(contrast(fg,bg) >= 4.5, `${contrast(fg,bg).toFixed(2)}:1`); });
for (const bg of ['accent','accent-hover']) test(`navy text / ${bg} >= 4.5:1`, () => assert.ok(contrast('text',bg)>=4.5));
for (const bg of ['surface','surface-alt','accent','background','accent-soft']) test(`focus / ${bg} >= 3:1`, () => assert.ok(contrast('focus-ring',bg)>=3));
for (const bg of ['surface','surface-alt']) test(`control boundary / ${bg} >= 3:1`, () => assert.ok(contrast('control-border',bg)>=3));
test('single light scheme and centralized React color values', () => {
  assert.match(css,/color-scheme: light/); assert.doesNotMatch(css,/color-scheme: dark/);
  assert.doesNotMatch(readFileSync(new URL('../../src/app/App.css',import.meta.url),'utf8'), /#[0-9a-f]{3,8}\b/gi);
});

test('mobile top scrollbar thumb has AA non-text contrast against its track', () => {
  const metallic = readFileSync(new URL('../../src/app/metallic.css',import.meta.url),'utf8');
  const colors = metallic.match(/\.player-table-frame \.top-scrollbar \{ background: (#[a-f0-9]{6}); scrollbar-color: (#[a-f0-9]{6}) (#[a-f0-9]{6}); \}/);
  assert.ok(colors, 'explicit mobile top scrollbar colors');
  assert.equal(colors[1],colors[3]);
  const thumb=luminance(colors[2]),track=luminance(colors[3]);
  assert.ok((Math.max(thumb,track)+.05)/(Math.min(thumb,track)+.05)>=3);
});
