#!/usr/bin/env node
/**
 * PKM Wiki Seeder — Reads local files and POSTs them to the PKM Wiki API.
 * Usage: node seed.mjs [--tier 1|2|3|all] [--dry-run]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, relative } from 'path';

const API_BASE = 'https://pkm-wiki.evan-ratner.workers.dev';
const HOME = '/home/eratner';
const DELAY_MS = 2000; // pause between ingests to avoid rate limits

// --- Source Tiers (highest value first) ---

// Tier 1: Claude memory + core project knowledge
const TIER_1 = [
  // Memory files (richest knowledge)
  ...glob(`${HOME}/.claude/projects/-home-eratner/memory/*.md`)
    .filter(f => !f.endsWith('MEMORY.md'))
    .map(f => ({ file: f, type: 'chat', label: `memory/${basename(f)}` })),

  // Core CLAUDE.md files
  { file: `${HOME}/.claude/CLAUDE.md`, type: 'document', label: 'claude-global-config' },
  { file: `${HOME}/CLAUDE.md`, type: 'document', label: 'claude-project-config' },

  // Business plans & strategy
  { file: `${HOME}/cafecito-ai/BUSINESS-PLAN.md`, type: 'document' },
  { file: `${HOME}/cafecito-ai/SCOPE.md`, type: 'document' },
  { file: `${HOME}/betwaggle/docs/MASTER-PLAN.md`, type: 'document' },
  { file: `${HOME}/betwaggle/ROADMAP.md`, type: 'document' },
  { file: `${HOME}/betwaggle/DESIGN.md`, type: 'document' },
  { file: `${HOME}/PE AI WorkFlows/master-prompt.md`, type: 'document' },
  { file: `${HOME}/boost-ai/BOOST_AI_PRODUCT_ROADMAP_PROMPT.md`, type: 'document' },
  { file: `${HOME}/boost-ai/BOOST_AI_GTM_OVERHAUL.md`, type: 'document' },
  { file: `${HOME}/venerable-gc/README.md`, type: 'document' },
  { file: `${HOME}/venerable-gc/VENERABLE-GC-ROADMAP.md`, type: 'document' },
  { file: `${HOME}/efincap-platform/CLAUDE.md`, type: 'document' },
];

// Tier 2: Project documentation + specs
const TIER_2 = [
  // BetWaggle/Waggle
  { file: `${HOME}/betwaggle/WORKFLOW-SPEC.md`, type: 'document' },
  { file: `${HOME}/betwaggle/docs/gtm-strategy.md`, type: 'document' },
  { file: `${HOME}/betwaggle/docs/paid-ads-strategy.md`, type: 'document' },
  { file: `${HOME}/betwaggle/docs/social-strategy.md`, type: 'document' },
  { file: `${HOME}/betwaggle/docs/viral-ux-sprint-3-game-flow-spec.md`, type: 'document' },
  { file: `${HOME}/betwaggle/emails/SEQUENCE.md`, type: 'document' },

  // Boost AI
  { file: `${HOME}/boost-ai/BOOST_AI_SPEC_ADDENDUM.md`, type: 'document' },
  { file: `${HOME}/boost-ai/IN_PERSON_SALES_PIPELINE_PLAYBOOK.md`, type: 'document' },

  // eFin Cap
  { file: `${HOME}/efin cap/EFINCAP_MONOLITH_BUILD_PLAN.md`, type: 'document' },
  { file: `${HOME}/efin cap/EFINCAP_CLAUDE_CODE_PROMPTS.md`, type: 'document' },

  // Venerable GC
  { file: `${HOME}/venerable-gc/VENERABLE-GC-SKILLS-AND-POSITIONING-PROMPT.md`, type: 'document' },
  { file: `${HOME}/venerable-gc/VENERABLE-GC-DASHBOARD-SPEC.md`, type: 'document' },
  { file: `${HOME}/venerable-gc/SECURITY.md`, type: 'document' },
  { file: `${HOME}/venerable-gc-overview.md`, type: 'document' },

  // Nightline
  { file: `${HOME}/DEMO-SCRIPT-2026-03-17.md`, type: 'document' },

  // Lexington Recovery
  { file: `${HOME}/lexington-recovery/CLAUDE.md`, type: 'document' },
  { file: `${HOME}/lexington-recovery/README.md`, type: 'document' },

  // KYU
  ...['CLAUDE_KYU_BUILD.md', 'CLAUDE_KYU_COMMAND_CENTER.md', 'JORDAN_SAYFIE_KYU_BRIEFING.md']
    .map(f => ({ file: `${HOME}/KYU/${f}`, type: 'document' })),

  // Ship It / Zero to Builder
  { file: `${HOME}/ship-it-book/GUMROAD-LISTING.md`, type: 'document' },
  { file: `${HOME}/zero-to-builder/marketing/LAUNCH_BRIEF-2026-02-24.md`, type: 'document' },

  // Alpha / LCS
  { file: `${HOME}/Marketing Materials/LCS_Claude_Code_Master_Prompt_v2.md`, type: 'document' },

  // Aileen
  { file: `${HOME}/aileen-growth-engine/CLAUDE.md`, type: 'document' },
  { file: `${HOME}/aileen-growth-engine/voice-profile.md`, type: 'document' },
  { file: `${HOME}/aileen-site/README.md`, type: 'document' },

  // Other projects
  { file: `${HOME}/profitpulse/profitpulse_claude_code_pre11am_instructions.md`, type: 'document' },
  { file: `${HOME}/tariff-engineer/README.md`, type: 'document' },
  { file: `${HOME}/lavin-eviction/CLAUDE.md`, type: 'document', label: 'lavin-eviction-config' },
  { file: `${HOME}/pretext/README.md`, type: 'document' },
  { file: `${HOME}/pretext/RESEARCH.md`, type: 'document' },

  // Cloudflare playbook
  { file: `${HOME}/claude cloudflare playbook/SHIP-IT-BOOK-CLAUDE-CODE.md`, type: 'document' },
];

// Tier 3: Meeting notes, deals, people, and additional project files
const TIER_3 = [
  // HSIC research
  ...['HSIC-Data-Sheet.md', 'HSIC-IR-Call-Prep.md', 'HSIC-Q4-2025-Earnings-Summary.md']
    .map(f => ({ file: `${HOME}/hsic/${f}`, type: 'document' })),

  // Goler Media
  { file: `${HOME}/goler-media-build/BUILD-COMPLETE.md`, type: 'document' },
  { file: `${HOME}/goler-media-build-v2/CLAUDE-CONTEXT.md`, type: 'document' },

  // StarGarden
  { file: `${HOME}/StarGarden/README.md`, type: 'document' },

  // Yolo factory
  { file: `${HOME}/yolo/BUILDS.md`, type: 'document' },

  // OpsPilot
  { file: `${HOME}/opspilot/CLAUDE.md`, type: 'document' },
  { file: `${HOME}/opspilot/README.md`, type: 'document' },

  // GiftGenius
  { file: `${HOME}/giftgenius-mvp/README.md`, type: 'document' },
  { file: `${HOME}/giftgenius-mvp/AGENTIC_COMMERCE_STRATEGY.md`, type: 'document' },

  // Tax
  { file: `${HOME}/tax/RATNER_TAX_CLAUDE_CODE_SPEC.md`, type: 'document' },

  // Cafecito designs
  { file: `${HOME}/cafecito-ai/DESIGN.md`, type: 'document' },
  { file: `${HOME}/cafecito-ai/CLAUDE-CONTEXT.md`, type: 'document' },
];

function glob(pattern) {
  // Simple glob for *.md in a directory
  const dir = pattern.replace('/*.md', '');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(dir, f));
}

async function ingest(source) {
  const { file, type, label } = source;
  const filename = label || relative(HOME, file);

  if (!existsSync(file)) {
    console.log(`  SKIP (not found): ${filename}`);
    return null;
  }

  const stat = statSync(file);
  if (stat.size > 100_000) {
    console.log(`  SKIP (too large ${(stat.size/1024).toFixed(0)}KB): ${filename}`);
    return null;
  }

  const content = readFileSync(file, 'utf-8');
  if (content.trim().length < 50) {
    console.log(`  SKIP (too short): ${filename}`);
    return null;
  }

  console.log(`  INGEST: ${filename} (${(content.length/1024).toFixed(1)}KB)...`);

  if (process.argv.includes('--dry-run')) {
    return { source_id: 'dry-run', pages_created: [], pages_updated: [], entities_extracted: 0 };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content, source_type: type }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.log(`    ERR ${res.status}: ${errText.slice(0, 200)}`);
        if (attempt < 2) {
          await sleep(5000);
          continue;
        }
        return null;
      }

      const result = await res.json();
      const created = result.pages_created?.length || 0;
      const updated = result.pages_updated?.length || 0;
      const extracted = result.entities_extracted || 0;
      console.log(`    OK: ${extracted} entities → ${created} created, ${updated} updated`);
      return result;
    } catch (err) {
      console.log(`    ERR: ${err.message}`);
      if (attempt < 2) {
        await sleep(5000);
        continue;
      }
      return null;
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const tierArg = process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] || 'all';

  let sources = [];
  if (tierArg === '1' || tierArg === 'all') sources.push(...TIER_1);
  if (tierArg === '2' || tierArg === 'all') sources.push(...TIER_2);
  if (tierArg === '3' || tierArg === 'all') sources.push(...TIER_3);

  console.log(`\n🧠 PKM Wiki Seeder`);
  console.log(`   Tier: ${tierArg}`);
  console.log(`   Sources: ${sources.length}`);
  console.log(`   Target: ${API_BASE}`);
  console.log(`   Dry run: ${process.argv.includes('--dry-run')}\n`);

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalEntities = 0;
  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < sources.length; i++) {
    console.log(`[${i+1}/${sources.length}]`);
    const result = await ingest(sources[i]);

    if (result === null) {
      skipped++;
    } else {
      ingested++;
      totalCreated += result.pages_created?.length || 0;
      totalUpdated += result.pages_updated?.length || 0;
      totalEntities += result.entities_extracted || 0;
    }

    // Delay between requests
    if (i < sources.length - 1 && result !== null) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n✅ Seeding complete!`);
  console.log(`   Ingested: ${ingested}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Entities extracted: ${totalEntities}`);
  console.log(`   Pages created: ${totalCreated}`);
  console.log(`   Pages updated: ${totalUpdated}`);
}

main().catch(console.error);
