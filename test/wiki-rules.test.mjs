import { answerMarkdown } from '../.test-build/answers.mjs';
import { setRulebook, withRulebook } from '../.test-build/ai.mjs';
import { DEFAULT_RULEBOOK, rulebookPageHTML } from '../.test-build/rulebook.mjs';
import assert from 'node:assert';

// Saved answers keep the answer word for word, with links to the pages used.
const md = answerMarkdown('What did I learn about pricing?', 'Charge for value.\n\nRaise prices yearly.',
  [{ slug: 'pricing', title: 'Pricing', excerpt: 'value  based\npricing' }, { slug: 'naval' }], '2026-10-19');
assert.ok(md.startsWith('# What did I learn about pricing?\n'));
assert.ok(md.includes('*Saved answer · 2026-10-19 · from [[Pricing]], [[naval]]*'));
assert.ok(md.includes('Charge for value.\n\nRaise prices yearly.'));
assert.ok(md.includes('- [[Pricing]] — value based pricing'));
assert.ok(!answerMarkdown('Q?', 'An answer long enough.', [], '2026-10-19').includes('## Sources'));

// The rulebook goes in front of wiki tasks only, and only once set.
assert.equal(withRulebook('query', 'SYS'), 'SYS');
setRulebook('RULE ONE');
assert.ok(withRulebook('query', 'SYS').includes('<rulebook>\nRULE ONE\n</rulebook>') && withRulebook('query', 'SYS').endsWith('SYS'));
assert.ok(withRulebook('ingest', 'SYS').includes('RULE ONE'));
assert.equal(withRulebook('code', 'SYS'), 'SYS');
assert.equal(withRulebook('spark', 'SYS'), 'SYS');
setRulebook('');

// The default rulebook covers the article's rules, and the edit page escapes the text.
for (const k of ['## Ownership', '## Sources and truth', 'VERIFIED', '## Answers', 'lint', 'recovery phrases']) assert.ok(DEFAULT_RULEBOOK.includes(k), k);
const page = rulebookPageHTML('<script>alert(1)</script> rules', true);
assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt; rules') && !page.includes('<script>alert(1)'));
console.log('wiki rules tests passed');
