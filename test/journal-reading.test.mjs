import { parseReadwisePage, bookIdFor } from '../.test-build/journal-reading.mjs';
import assert from 'node:assert';

const md = `- Author:: [[Jane Writer]]
- Recommended By::
- Tags:: #Books #Inbox #Readwise
- ### Highlights first synced by #Readwise [[September 27th, 2020]]
    - Seeing through spin is one of the most important aspects of the job. ([Location 270](https://readwise.io/to_kindle?action=open&asin=B00&location=270))
        - **Tags**: #[[blue]] #focus
    - Invest where you have an edge. ([Location 358](https://readwise.io/to_kindle?action=open&asin=B00&location=358))
        - **Note**: My own rule too
    - Non-breaking space form. ([Location\u00a0512](https://readwise.io/x))
    - A highlight without a location
- ### New highlights added [[March 3rd, 2021]]
    - Later highlight. ([Location 400](https://readwise.io/x))`;
const p = parseReadwisePage('A Great Book: Subtitle (highlights)', md);
assert.equal(p.title, 'A Great Book: Subtitle');
assert.equal(p.author, 'Jane Writer');
assert.equal(p.firstSynced, '2020-09-27');
assert.equal(p.highlights.length, 5);
assert.deepEqual(p.highlights[0], { text: 'Seeing through spin is one of the most important aspects of the job.', note: null, location: 270, tags: ['blue', 'focus'] });
assert.equal(p.highlights[1].note, 'My own rule too');
assert.deepEqual([p.highlights[2].text, p.highlights[2].location], ['Non-breaking space form.', 512]);
assert.equal(p.highlights[3].location, null);
assert.equal(p.highlights[4].text, 'Later highlight.');
assert.equal(bookIdFor('A Great Book: Subtitle (highlights)'), bookIdFor('A Great Book: Subtitle'));
console.log('reading tests passed');
