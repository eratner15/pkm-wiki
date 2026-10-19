# Saved answers and the wiki rulebook

Two habits from "How I use Claude as my second brain" (treasure-hunting.co), added to this wiki.

## Saved answers

Good answers should not disappear into chat history.

1. Ask a question on the wiki home page.
2. Under the answer, press **Save answer**.
3. The answer is stored word for word as a wiki page: title = the question, slug `answer-…`, tag `answer`. The page records the date and links to the pages the answer used, and those pages get a backlink.

`/answers` lists every saved answer, newest first. A link of the form `/#/page/<slug>` opens a page directly. Saved answers are ordinary pages, so search and later answers can find and build on them.

**Extract facts to wiki** (the older button) still exists in the research cockpit. It sends the answer back through the research step instead of saving it as written.

## The rulebook

`/rulebook` is one editable page of rules. Every wiki AI task reads it first: ingest, research, answers (query), quality checks and ideas. Code generation and build plans skip it.

- It is stored at `wiki/wiki-rulebook.md`, with a `pages` row (slug `wiki-rulebook`, tag `rulebook`).
- Until it is saved once, the default text in `src/rulebook.ts` applies.
- Each Worker caches it for five minutes, so an edit applies within five minutes.
- It is placed in front of each task's own instructions. When the two conflict on how to write or answer, the rulebook wins. The task's output format (for example JSON) still applies.

The default covers:
- ownership (sources are never rewritten)
- page structure and topic hubs
- source ranking and contradictions
- VERIFIED / DIRECTIONAL / UNVERIFIED tags for investing claims
- answers, report-only quality checks, and style, including never storing credentials
