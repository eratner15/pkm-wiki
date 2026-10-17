import { parseJournalMarkdown as P } from '../.test-build/journal-parse.mjs';
import assert from 'node:assert';
let r;
// 1. Roam per-day file, attribute syntax, nested label, goals heading
r = P([{ name: 'export/July 20th, 2021.md', text: `- Rose:: Call with a client\n- **Thorn**\n    - Back pain all day\n- Lesson:: Slow down before deciding\n## Day in Review\n- Team call\n### Goals for tomorrow\n- [ ] Golf lesson\n- [x] done thing\n- [ ] write the memo` }]);
assert.equal(r.entries.length, 1); let e = r.entries[0];
assert.equal(e.date, '2021-07-20'); assert.equal(e.rose, 'Call with a client'); assert.equal(e.thorn, 'Back pain all day');
assert.equal(e.lesson, 'Slow down before deciding'); assert.equal(e.next_action, 'Golf lesson · write the memo');
assert.ok(e.body.includes('Team call'));
// 2. One big file, Notion-like headings, bold labels, table, mood numbers, templates, undated
r = P([{ name: 'journal.md', text: `# Living Journal export\nIntro text\n## Tue, Jul 20, 2021\n**Summary:** Good day.\n**Rose:** Golf\n**Mood (inferred):** 7\n**Energy:** High\n**Tags:** Golf, Family\n**People:** Alex (https://notion.so/x), Sam\n### Morning\n- coffee\n## Wed, Jul 21, 2021\n| Field | Value |\n|---|---|\n| Rose | Beach walk |\n| Day Score | 8 |\n## 2021-07-21\nWork notes\n## Daily Template\nRose::\nThorn::\n## Random notes\nstuff here` }]);
assert.equal(r.entries.length, 3);
e = r.entries[0]; assert.equal(e.summary, 'Good day.'); assert.equal(e.mood, 7); assert.equal(e.energy, 'High');
assert.deepEqual(e.tags, ['Golf', 'Family']); assert.deepEqual(e.people, ['Alex', 'Sam']); assert.ok(e.body.includes('coffee'));
assert.equal(r.entries[1].rose, 'Beach walk'); assert.equal(r.entries[1].day_score, 8);
assert.equal(r.entries[1].id, 'md20210721'); assert.equal(r.entries[2].id, 'md20210721-2');
assert.equal(r.templates.length, 1); assert.equal(r.templates[0].name, 'Daily');
assert.deepEqual(r.undated.map(u => u.title), ['Living Journal export', 'Random notes']);
// 3. Date formats
for (const [h, d] of [['October 16th, 2026', '2026-10-16'], ['Friday, October 16, 2026', '2026-10-16'], ['Sept 3, 2020', '2020-09-03'], ['16 Oct 2026', '2026-10-16'], ['10/16/2026', '2026-10-16'], ['[[March 1st, 2021]]', '2021-03-01']])
  assert.equal(P([{ name: 'a.md', text: `## ${h}\nRose: x` }]).entries[0]?.date, d, h);
// 4. Non-dates are not days; a file with no dated heading is one Library page
r = P([{ name: 'Strategy.md', text: `## Strategy May 2021\nx\n## Q3 Plan\ny` }]);
assert.equal(r.entries.length, 0); assert.equal(r.pages.length, 1); assert.equal(r.pages[0].title, 'Strategy'); assert.ok(r.pages[0].body.includes('Q3 Plan'));
// 5. Notion export page with property header
r = P([{ name: 'Daily Journal/Tue, Jul 20, 2021 0123456789abcdef0123456789abcdef.md', text: `# Tue, Jul 20, 2021\n\nLesson: Sleep first\nNext Action: Golf lesson\n\n## Day in Review\n- x` }]);
assert.equal(r.entries[0].date, '2021-07-20'); assert.equal(r.entries[0].lesson, 'Sleep first'); assert.equal(r.entries[0].next_action, 'Golf lesson');
console.log('all parser tests passed');

// 6. Real Roam layout: tagged labels with nested bullets, TODO/DONE, slider, block refs
r = P([{ name: 'Roam-Export/March 20th, 2021.md', text: [
  '- #[[Day in Review]]',
  '    - Up at 7am. ((ROs2yvW2Z))',
  '    - [[rose of the day]]',
  '        - Making friends through kids',
  '    - [[thorn of the day]]',
  '        - No real thorn',
  '    - [[wins for the day]]',
  '        - fast went well',
  '    - [[key learning today]]',
  '        - slow down',
  '    - #[[day score]] {{[[slider]]}}',
  '    - **Goals for Tomorrow** [[Goals]] | [[TODO]] [[March 21st, 2021]]',
  '        -  {{[[DONE]]}}  day two of the fast',
  '        - {{[[TODO]]}} Write the pitch [[March 22nd, 2021]]',
].join('\n') }]);
e = r.entries[0];
assert.equal(e.date, '2021-03-20'); assert.equal(e.rose, 'Making friends through kids'); assert.equal(e.thorn, 'No real thorn');
assert.equal(e.key_wins, 'fast went well'); assert.equal(e.lesson, 'slow down'); assert.equal(e.day_score, undefined);
assert.equal(e.next_action, 'Write the pitch March 22nd, 2021');
// 7. Roam day template page is not a day, and "[[Template]]/day.md" is a template
r = P([{ name: 'Roam-Export/[[Template]]/day.md', text: '- [[[[Day in Review]] ]]\n- [[rose of the day]]\n- 2 goals for tomorrow\n    - {{[[TODO]]}}' }]);
assert.equal(r.entries.length, 0);
assert.deepEqual(r.templates.map(t => t.name), ['Day']);
r = P([{ name: 'Investment Memo Template.md', text: '- Thesis\n- Risks' }, { name: 'Template.md', text: '- 5 Whys' }]);
assert.deepEqual(r.templates.map(t => t.name), ['Investment Memo', 'Template']);
console.log('roam layout tests passed');

// 8. Secrets never leave the browser
r = P([{ name: 'April 12th, 2022.md', text: '- Canalyst API key: abcd1234EFGH5678ijkl9012MNOP\n- token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n- Rose:: the token of my thanks\n- see https://example.com/a/0123456789abcdef0123456789abcdef0123\n- raw Xy7Kq2Lm9Pz4Rt8Wv3Bn6Cd1Fg5Hj0Ks2Lq9\n- Notion id 3fb4e1f3c4a681e995f4c01fbd4963f3' }]);
e = r.entries[0];
assert.ok(!/abcd1234EFGH/.test(e.body) && !/ghp_a/.test(e.body) && !/Xy7Kq2Lm9/.test(e.body), e.body);
assert.ok(e.body.includes('the token of my thanks'));
assert.ok(e.body.includes('https://example.com/a/0123456789abcdef0123456789abcdef0123'));
assert.ok(e.body.includes('3fb4e1f3c4a681e995f4c01fbd4963f3'));
assert.equal(r.redactions, 3);
console.log('redaction tests passed');
