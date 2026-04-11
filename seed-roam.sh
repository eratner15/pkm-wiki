#!/usr/bin/env bash
# Don't use set -e so the loop continues on errors

ROAM_DIR="/home/eratner/pkm/roam-extracted"
API_BASE="https://pkm-wiki.evan-ratner.workers.dev"
RESOLVE="--resolve pkm-wiki.evan-ratner.workers.dev:443:104.21.0.0"
MAX_SIZE=51200  # 50KB truncation limit
MIN_SIZE=50     # skip files < 50 bytes
DELAY=10        # seconds between requests (avoid Workers AI rate limit 3050)

# Counters
ingested=0
skipped=0
failed=0
total_entities=0
total_pages=0
processed=0

echo "=== PKM Wiki Roam Ingest ==="
echo "Source: $ROAM_DIR"
echo "API: $API_BASE"
echo "Started: $(date)"
echo ""

# Build sorted file list (largest first)
mapfile -t files < <(find "$ROAM_DIR" -name "*.md" -printf '%s\t%p\n' | sort -rn -t$'\t' -k1 | cut -f2)

total_files=${#files[@]}
echo "Total .md files found: $total_files"
echo ""

for filepath in "${files[@]}"; do
    processed=$((processed + 1))
    filename=$(basename "$filepath")
    filesize=$(stat -c%s -- "$filepath" 2>/dev/null || echo "0")

    # Skip empty/tiny files
    if [ "$filesize" -lt "$MIN_SIZE" ]; then
        skipped=$((skipped + 1))
        continue
    fi

    # Progress every 10 files
    if [ $((processed % 10)) -eq 0 ]; then
        echo "[Progress] $processed/$total_files processed | ingested=$ingested skipped=$skipped failed=$failed entities=$total_entities pages=$total_pages"
    fi

    # Build JSON payload using python3 for safe encoding (write to temp file to avoid shell limits)
    tmpjson=$(mktemp /tmp/roam-ingest-XXXXXX.json)
    python3 -c "
import json, sys
filename = sys.argv[1]
filepath = sys.argv[2]
max_size = int(sys.argv[3])
outfile = sys.argv[4]
with open(filepath, 'r', errors='replace') as f:
    content = f.read(max_size)
payload = {'filename': filename, 'content': content, 'source_type': 'roam'}
with open(outfile, 'w') as f:
    json.dump(payload, f)
" "$filename" "$filepath" "$MAX_SIZE" "$tmpjson"

    # POST to ingest API
    response=$(curl -s -w "\n%{http_code}" \
        $RESOLVE \
        --max-time 180 \
        -X POST \
        -H "Content-Type: application/json" \
        -d @"$tmpjson" \
        "$API_BASE/api/ingest" 2>&1) || true
    rm -f "$tmpjson"

    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        # Extract entity and page counts - handle both numeric and list responses
        counts=$(echo "$body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    # entities might be a list or a number
    e = d.get('entities_extracted', d.get('entity_count', d.get('entities', 0)))
    if isinstance(e, list):
        ec = len(e)
    else:
        ec = int(e) if e else 0
    p = d.get('pages_created', d.get('page_count', 0))
    if isinstance(p, list):
        pc = len(p)
    else:
        pc = int(p) if p else 0
    print(f'{ec} {pc}')
except:
    print('0 0')
" 2>/dev/null || echo "0 0")
        entities=$(echo "$counts" | awk '{print $1}')
        pages=$(echo "$counts" | awk '{print $2}')
        ingested=$((ingested + 1))
        total_entities=$((total_entities + entities))
        total_pages=$((total_pages + pages))
        echo "[OK $http_code] $filename (${filesize}B) -> entities=$entities pages=$pages"
    elif [ "$http_code" = "409" ]; then
        # Duplicate - count as skipped
        skipped=$((skipped + 1))
        echo "[DUP] $filename (already ingested)"
    else
        failed=$((failed + 1))
        echo "[FAIL $http_code] $filename -> $(echo "$body" | head -c 200)"
    fi

    sleep "$DELAY"
done

echo ""
echo "=== Ingest Complete ==="
echo "Finished: $(date)"
echo "Ingested: $ingested"
echo "Skipped:  $skipped"
echo "Failed:   $failed"
echo "Total entities extracted: $total_entities"
echo "Total pages created:      $total_pages"
echo ""

echo "=== Wiki Stats ==="
curl -s $RESOLVE --max-time 30 "$API_BASE/api/stats" | python3 -m json.tool 2>/dev/null || echo "(stats endpoint unavailable)"
