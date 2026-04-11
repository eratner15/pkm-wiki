#!/bin/bash
# Resume seeding from where we left off (Tier 2 item 42+, all of Tier 3, plus Tier 1 memory files 4+)
set -e
API="https://pkm-wiki.evan-ratner.workers.dev"
RESOLVE="--resolve pkm-wiki.evan-ratner.workers.dev:443:104.21.0.0"
HOME_DIR="/home/eratner"
COUNT=0
CREATED=0
UPDATED=0

ingest_file() {
  local filepath="$1"
  local source_type="$2"
  local label="$3"

  if [ ! -f "$filepath" ]; then
    echo "  SKIP (not found): $label"
    return
  fi

  local size=$(stat -c%s "$filepath" 2>/dev/null || echo 0)
  if [ "$size" -gt 100000 ]; then
    echo "  SKIP (too large): $label ($(echo "scale=0; $size/1024" | bc)KB)"
    return
  fi

  COUNT=$((COUNT + 1))
  echo "[$COUNT] INGEST: $label ($(echo "scale=1; $size/1024" | bc)KB)..."

  local content
  content=$(python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    content = f.read()
if len(content.strip()) < 50:
    sys.exit(1)
print(json.dumps({
    'filename': sys.argv[2],
    'content': content,
    'source_type': sys.argv[3]
}))
" "$filepath" "$label" "$source_type" 2>/dev/null)

  if [ $? -ne 0 ]; then
    echo "  SKIP (too short or read error)"
    return
  fi

  local result
  result=$(curl -sk $RESOLVE -X POST "$API/api/ingest" \
    -H "Content-Type: application/json" \
    -d "$content" \
    --max-time 180 2>&1)

  if echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'  OK: {d.get(\"entities_extracted\",0)} entities → {len(d.get(\"pages_created\",[]))} created, {len(d.get(\"pages_updated\",[]))} updated')" 2>/dev/null; then
    true
  else
    echo "  ERR: $(echo "$result" | head -c 200)"
  fi

  sleep 3
}

echo ""
echo "🧠 PKM Wiki Resume Seeder"
echo ""

# === TIER 1 MEMORY FILES (4-18 that timed out) ===
echo "=== TIER 1: Remaining Memory Files ==="
for f in "$HOME_DIR"/.claude/projects/-home-eratner/memory/*.md; do
  [ "$(basename "$f")" = "MEMORY.md" ] && continue
  ingest_file "$f" "chat" "memory/$(basename "$f")"
done

# Core configs
ingest_file "$HOME_DIR/.claude/CLAUDE.md" "document" "claude-global-config.md"
ingest_file "$HOME_DIR/CLAUDE.md" "document" "claude-project-config.md"
ingest_file "$HOME_DIR/cafecito-ai/BUSINESS-PLAN.md" "document" "cafecito-business-plan.md"
ingest_file "$HOME_DIR/cafecito-ai/SCOPE.md" "document" "cafecito-scope.md"
ingest_file "$HOME_DIR/betwaggle/docs/MASTER-PLAN.md" "document" "waggle-master-plan.md"
ingest_file "$HOME_DIR/betwaggle/ROADMAP.md" "document" "waggle-roadmap.md"

# === TIER 2 REMAINING (from item 42+) ===
echo ""
echo "=== TIER 2: Remaining Docs ==="
ingest_file "$HOME_DIR/venerable-gc-overview.md" "document" "venerable-gc-overview.md"
ingest_file "$HOME_DIR/DEMO-SCRIPT-2026-03-17.md" "document" "nightline-demo-script.md"
ingest_file "$HOME_DIR/lexington-recovery/CLAUDE.md" "document" "lexington-recovery-claude.md"
ingest_file "$HOME_DIR/lexington-recovery/README.md" "document" "lexington-recovery-readme.md"
ingest_file "$HOME_DIR/KYU/CLAUDE_KYU_BUILD.md" "document" "kyu-build.md"
ingest_file "$HOME_DIR/KYU/JORDAN_SAYFIE_KYU_BRIEFING.md" "document" "kyu-briefing.md"
ingest_file "$HOME_DIR/zero-to-builder/marketing/LAUNCH_BRIEF-2026-02-24.md" "document" "zero-to-builder-launch.md"
ingest_file "$HOME_DIR/Marketing Materials/LCS_Claude_Code_Master_Prompt_v2.md" "document" "lcs-master-prompt.md"
ingest_file "$HOME_DIR/aileen-growth-engine/CLAUDE.md" "document" "aileen-growth-claude.md"
ingest_file "$HOME_DIR/aileen-growth-engine/voice-profile.md" "document" "aileen-voice-profile.md"
ingest_file "$HOME_DIR/pretext/README.md" "document" "pretext-readme.md"
ingest_file "$HOME_DIR/pretext/RESEARCH.md" "document" "pretext-research.md"

# === TIER 3 ===
echo ""
echo "=== TIER 3: Extended Knowledge ==="
ingest_file "$HOME_DIR/hsic/HSIC-Data-Sheet.md" "document" "hsic-data-sheet.md"
ingest_file "$HOME_DIR/hsic/HSIC-IR-Call-Prep.md" "document" "hsic-ir-call-prep.md"
ingest_file "$HOME_DIR/hsic/HSIC-Q4-2025-Earnings-Summary.md" "document" "hsic-q4-earnings.md"
ingest_file "$HOME_DIR/goler-media-build/BUILD-COMPLETE.md" "document" "goler-media-build.md"
ingest_file "$HOME_DIR/opspilot/CLAUDE.md" "document" "opspilot-claude.md"
ingest_file "$HOME_DIR/opspilot/README.md" "document" "opspilot-readme.md"
ingest_file "$HOME_DIR/giftgenius-mvp/README.md" "document" "giftgenius-readme.md"
ingest_file "$HOME_DIR/giftgenius-mvp/AGENTIC_COMMERCE_STRATEGY.md" "document" "giftgenius-strategy.md"
ingest_file "$HOME_DIR/tax/RATNER_TAX_CLAUDE_CODE_SPEC.md" "document" "ratner-tax-spec.md"
ingest_file "$HOME_DIR/cafecito-ai/DESIGN.md" "document" "cafecito-design.md"
ingest_file "$HOME_DIR/cafecito-ai/CLAUDE-CONTEXT.md" "document" "cafecito-claude-context.md"
ingest_file "$HOME_DIR/yolo/BUILDS.md" "document" "yolo-builds.md"
ingest_file "$HOME_DIR/tariff-engineer/README.md" "document" "tariff-engineer-readme.md"
ingest_file "$HOME_DIR/profitpulse/profitpulse_claude_code_pre11am_instructions.md" "document" "profitpulse-instructions.md"

echo ""
echo "✅ Resume seeding complete! Ingested: $COUNT"
echo ""
echo "📊 Wiki stats:"
curl -sk $RESOLVE "$API/api/stats" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'   Pages: {d[\"pages\"]}, Sources: {d[\"sources\"]}, Words: {d[\"total_words\"]}, Health: {d[\"health_score\"]}')"
