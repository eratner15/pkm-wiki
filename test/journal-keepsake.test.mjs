import { quoteMatches, makeChecker, entrySource, buildCorpus } from '../.test-build/journal-keepsake.mjs';
import { bookHTML } from '../.test-build/journal-keepsake-book.mjs';
import assert from 'node:assert';

// Quotes must match the notes word for word; markup, case, curly quotes and spacing are ignored.
const src = 'Rose: **Long walk** by the lake\n- Talked with [[Sam]] about the move\n    - It’s time to   go';
assert.ok(quoteMatches('Long walk by the lake', src));
assert.ok(quoteMatches('talked with Sam about the move', src));
assert.ok(quoteMatches("It's time to go", src));
assert.ok(quoteMatches('Long walk ... about the move', src));
assert.ok(!quoteMatches('about the move ... Long walk', src), 'pieces must be in order');
assert.ok(!quoteMatches('Long walk by the sea', src), 'changed words fail');
assert.ok(!quoteMatches('walk', src), 'too short to prove anything');

const entries = [
  { id: 'md20200102', entry_date: '2020-01-02', rose: 'First day back', body: '- Wrote the plan for the year\n- {{[[TODO]]}} call the bank', mood: null },
  { id: 'md20210314', entry_date: '2021-03-14', thorn: 'Back pain', body: '- Kept going anyway\n- ((abcdef12)) ref', mood: null },
];
assert.ok(entrySource(entries[0]).startsWith('Rose: First day back'));
const corpus = buildCorpus(entries);
assert.ok(corpus.includes('### md20200102 · 2020-01-02 (Thursday)'));
assert.ok(!corpus.includes('((abcdef12))') && corpus.includes('[ ] call the bank'));

const check = makeChecker(entries);
const kept = check.keep([
  { entry_id: 'md20200102', text: 'Wrote the plan for the year' },
  { entry_id: 'md20210314', text: 'Wrote the plan for the year' },
  { entry_id: 'md99999999', text: 'Kept going anyway' },
]);
assert.equal(kept.length, 1); assert.equal(check.dropped(), 2);

// Book: a removed day stays visible on screen but is marked out; quotes cite their dates.
const html = bookHTML({
  years: { data: { years: [{ year: '2020–2021', title: 'Starting over', essay: 'You began.\n\nYou kept going.', months: [{ month: '2020-01', line: 'A plan.' }],
    days: [{ entry_id: 'md20200102', why: 'The first page.' }, { entry_id: 'md20210314', why: 'Pain and persistence.' }, { entry_id: 'gone', why: 'x' }],
    quotes: [{ entry_id: 'md20210314', text: 'Kept going anyway' }] }] }, at: '', model: 'm', cost_usd: 0, dropped_quotes: 1 },
  connections: { data: { title_options: ['Kept Going'], letter: 'Dear you.', threads: [{ title: 'Persistence', essay: 'It returns.', quotes: [] }], people: [], echoes: [], questions: ['What next?'] }, at: '', model: 'm', cost_usd: 0, dropped_quotes: 0 },
  edits: { excluded: ['md20210314'], dedication: 'For me' },
}, entries, [{ name: 'Sam', dates: '2020-01-02', n: 1 }]);
assert.ok(html.includes('<h1 class="title">Kept Going</h1>'), 'first title idea is the default');
assert.ok(html.includes('class="day out" data-id="md20210314"'));
assert.ok(html.includes('<cite>14 March 2021</cite>'));
assert.ok(html.includes('1 printed in full') && html.includes('1 quote removed'));
assert.ok(!html.includes('data-id="gone"'));
assert.ok(html.includes('For me') && html.includes('What next?') && html.includes('Every rose'));
assert.ok(html.includes('size: 210mm 280mm'));
console.log('keepsake tests passed');
