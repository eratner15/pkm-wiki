# Design System — PKM Wiki

## Product Context
- **What this is:** Personal knowledge management system with 1,100+ wiki pages, AI-powered search, idea generation, and project builder
- **Who it's for:** Evan Ratner — finance professional who builds tech products, consumes heavily (tweets, books, meetings), thinks in frameworks
- **Space/industry:** Personal productivity / knowledge management / second brain
- **Project type:** Three-mode web app (Intake, Ideas Lab, PKM Wiki)

## Three Modes
1. **Intake + Build** — Fast capture, flywheel (ingest → spark → build). Phone-first, minimal.
2. **Ideas Lab** — Remix engine, surfaces sparks from existing knowledge. Pre-cached, cheap.
3. **PKM Wiki** — Second brain with Gemma as local LLM. Personal search engine. Desktop-rich.

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian meets Editorial
- **Decoration level:** Minimal — typography does the work, the knowledge graph IS the decoration
- **Mood:** Bloomberg terminal crossed with Substack editor. Dense where data lives, spacious where you read. Authority without pretension.
- **Anti-patterns:** No purple gradients, no glowing orbs, no generic SaaS blue, no decorative blobs

## Typography
- **Display/Hero:** Instrument Serif — authority, newspaper masthead feel. Your PKM is your personal publication.
- **Body:** Instrument Sans — pairs with Instrument Serif, clean and legible for wiki content
- **UI/Labels:** Instrument Sans (medium weight)
- **Data/Tables/Stats:** Geist Mono — tabular numbers, terminal feel for the intake bar and stats
- **Code:** Geist Mono
- **Loading:** Google Fonts `Instrument+Serif:wght@400;700` + `Instrument+Sans:wght@400;500;600;700`; Geist Mono via CDN
- **Scale:** 13px body, 15px reading, 20px section headers, 28px page titles, 48px hero stats

## Color
- **Approach:** Restrained — one accent + neutrals, color is rare and meaningful
- **Primary accent:** #D4A853 (warm amber/gold) — ties to finance/investment world, premium, distinct from every SaaS blue
- **Accent hover:** #C4983F
- **Neutrals (dark mode):**
  - Background: #0C0C0E
  - Surface: #161619
  - Surface raised: #1E1E22
  - Border: #2A2A2F
  - Text primary: #E8E6E1 (warm white)
  - Text secondary: #8A8880
  - Text faint: #5A5850
- **Neutrals (light mode):**
  - Background: #F5F4F0 (warm paper)
  - Surface: #FFFFFF
  - Surface raised: #FAFAF8
  - Border: #E0DED8
  - Text primary: #1A1918
  - Text secondary: #6B6860
  - Text faint: #9A9890
- **Semantic:** success #4A9 (muted green), warning #D4A853 (same as accent), error #C45, info #68A
- **Type badges:** concept #5B8DEF, entity #4AAF7C, project #9B7DCF, daily #D4A853, index #7A7870

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable for wiki reading, compact for data/stats
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Intake:** Single column, centered, max-width 560px. Just the input.
- **Ideas Lab:** Card grid, 2-3 columns desktop, 1 column mobile. Pre-cached cards.
- **Wiki:** 280px sidebar + fluid content. Sidebar is the power tool, content for reading.
- **Max content width:** 720px for reading, 900px for dashboard
- **Border radius:** sm:4px, md:6px, lg:10px (subtle, not bubbly)

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50ms) short(150ms) medium(250ms)

## Knowledge Graph
- Must have a legend explaining what colors and sizes mean
- One-line sentence: "Your 1,100 pages. Size = connections. Color = type. Click to explore."
- Cluster labels visible by default
- Default filter: nodes with 2+ connections only

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-05 | Initial design system | Industrial/editorial aesthetic matching finance professional's mental model. Warm amber accent to differentiate from generic SaaS blue. Three-mode architecture. |
| 2026-04-05 | Instrument Serif + Sans | Authority typography that makes the PKM feel like a personal publication, not a todo app. |
| 2026-04-05 | Ideas Lab caching | Don't burn tokens on page load. Cache ideas in D1, generate on demand. |
