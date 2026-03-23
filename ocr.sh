#!/usr/bin/env bash
#
# ocr.sh — Visual OCR via ChatGPT Bridge
#
# Sends a PDF to ChatGPT via the chatgpt-bridge CLI with a structured
# OCR prompt. The file is uploaded automatically via --attach.
#
# Usage:
#   1. Open ChatGPT in Chrome (with the extension loaded)
#   2. Run: ./ocr.sh document.pdf
#   3. The bridge uploads the file, types the OCR prompt, and sends it
#   4. ChatGPT returns structured JSON, saved as <file>.ocr.json
#
# The output JSON follows the smart-ocr schema:
#   { source_file, document_title, summary, document_date, proposed_filename,
#     language, document_type, num_pages, pages: [{page, text, confidence}] }
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="$SCRIPT_DIR/cli.js"

# ── Parse arguments ─────────────────────────────────────────────────────────

usage() {
  cat >&2 <<'EOF'
Usage: ocr.sh [options] <file.pdf>

Options:
  -n, --num-pages <N>   Number of pages in the document (default: 1)
  -o, --output <file>   Output JSON file (default: <input>.ocr.json)
  -t, --timeout <secs>  Response timeout (default: 600)
  --token <value>       Auth token for the bridge
  --no-save             Print JSON to stdout instead of saving
  -h, --help            Show this help

The file is uploaded automatically via --attach. Just have ChatGPT open
in Chrome with the extension loaded.

Workflow:
  1. Open https://chatgpt.com/ in Chrome (with the extension loaded)
  2. Run: ./ocr.sh document.pdf
  3. The bridge uploads the file, types the prompt, and sends it

Examples:
  ./ocr.sh invoice.pdf                          # OCR a 1-page invoice
  ./ocr.sh -n 3 report.pdf                      # 3-page document
  ./ocr.sh -o result.json scan.pdf              # Custom output path
  ./ocr.sh --no-save scan.pdf | jq .            # Pipe to jq for inspection
  ./ocr.sh -n 5 -t 900 long-document.pdf        # 5 pages, 15min timeout
EOF
  exit 1
}

NUM_PAGES=1
OUTPUT=""
TIMEOUT=3600
TOKEN=""
NO_SAVE=false
INPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--num-pages) NUM_PAGES="$2"; shift 2 ;;
    -o|--output)    OUTPUT="$2"; shift 2 ;;
    -t|--timeout)   TIMEOUT="$2"; shift 2 ;;
    --token)        TOKEN="$2"; shift 2 ;;
    --no-save)      NO_SAVE=true; shift ;;
    -h|--help)      usage ;;
    -*)             echo "Unknown option: $1" >&2; usage ;;
    *)              INPUT_FILE="$1"; shift ;;
  esac
done

if [[ -z "$INPUT_FILE" ]]; then
  echo "Error: No input file specified." >&2
  usage
fi

BASENAME="$(basename "$INPUT_FILE")"

# Default output: <input>.ocr.json (next to the input file)
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="${INPUT_FILE}.ocr.json"
fi

# Safety: don't overwrite existing OCR output
if [[ "$NO_SAVE" == false && -e "$OUTPUT" ]]; then
  echo "Error: Output file already exists: $OUTPUT" >&2
  echo "Use -o to specify a different output path, or delete the existing file." >&2
  exit 1
fi

# Extract date hint from filename (YYYYMMDD or YYYY-MM-DD prefix)
DATE_HINT=""
if [[ "$BASENAME" =~ ^([0-9]{4})[-_]?([0-9]{2})[-_]?([0-9]{2})[-_] ]]; then
  DATE_HINT="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
fi

DATE_LINE=""
if [[ -n "$DATE_HINT" ]]; then
  DATE_LINE="Date hint from filename: $DATE_HINT (use as document_date ONLY if no date is found in the document content — note: this may be a scan date or birth date, not the document date, so always prefer dates found in the actual content)"
fi

# ── Build prompt ────────────────────────────────────────────────────────────

read -r -d '' PROMPT <<PROMPT_EOF || true
You are a document OCR and formatting assistant. Read the uploaded document visually and produce a faithful rendering of its complete content.

Source file: ${BASENAME}
Number of pages: ${NUM_PAGES}
${DATE_LINE}
## Output format

Produce a single JSON object with the following structure. Output ONLY valid JSON, nothing else.

\`\`\`
{
  "source_file": "${BASENAME}",
  "document_title": "<guesstimate a concise document title from the content>",
  "summary": "<2-3 sentence summary: what is this document, who issued it, what is its purpose or key content>",
  "document_date": "<date from the document in YYYY-MM-DD format, or null>",
  "proposed_filename": "<descriptive filename in format YYYY-MM-DD_Sender_Type, e.g. 2023-02-03_Kaffeezentrale_Rechnung>",
  "language": "<de|en|fr|it|null — use null for photos without text>",
  "document_type": "<invoice|letter|contract|form|receipt|report|certificate|tax|insurance|bank|medical|photo|other>",
  "num_pages": ${NUM_PAGES},
  "has_images": <true or false — does the document contain photos, diagrams, charts, or graphics>,
  "has_native_text": false,
  "is_image_only": true,
  "is_scanned_with_ocr": false,
  "ocr_quality": "<high|medium|low — your confidence in the extraction accuracy>",
  "ocr_method": "chatgpt-visual",
  "pages": [
    {"page": 1, "text": "<Markdown-formatted content of page 1>", "confidence": "<high|medium|low>"},
    {"page": 2, "text": "<Markdown-formatted content of page 2>", "confidence": "<high|medium|low>"}
  ]
}
\`\`\`

Include one entry per page in the "pages" array, matching the ${NUM_PAGES} pages of the document.

## Per-page confidence

For each page, assess the "confidence" of your visual extraction:
- "high": you can read the page clearly, confident the Markdown is accurate
- "medium": minor issues (e.g. blurry areas, faint text) but mostly readable
- "low": significant portions are illegible, blurry, or cut off

## Rules for the page text (Markdown)

Each page's "text" field must contain well-formatted Markdown:
- Read ALL pages of the document thoroughly
- Reproduce the document content as closely as possible to the original layout and visual structure
- Preserve ALL numbers, amounts, dates, reference numbers, IBAN numbers, and account numbers exactly as they appear
- Preserve German characters (ü, ö, ä, ß) correctly
- Format tables as Markdown tables matching the original table structure and alignment
- Use headings (# ## ###) that reflect the document's visual hierarchy
- Use horizontal rules (---) to separate distinct visual sections within a page
- Use lists (- or 1.) where the original uses bullet points or numbered items
- Format URLs as Markdown links: [display text](https://example.com)
- Preserve addresses, letterheads, signatures, and contact blocks as formatted text
- For handwritten text, transcribe it and mark with *[handwritten]*
- For stamps or seals, note them as *[stamp: description]*
- Mark where images, figures, charts, diagrams, logos, or photos appear using: ![description]()
- If a page is blank, use "*[blank page]*" as the text

## Important — JSON validity
- Output ONLY the JSON object — no code fences, no commentary, no explanations
- Do NOT add HTML comments
- Do NOT invent or assume content that is not visible in the document
- CRITICAL: Escape all double quotes inside string values as \"
- Escape backslashes as \\, newlines as \n, tabs as \t
- Each page must be a separate entry in the "pages" array
- If this is a photo without document text, set document_type to "photo", language to null
- Start your response with {
PROMPT_EOF

# ── Run via chatgpt-bridge ─────────────────────────────────────────────────

CLI_ARGS=()
if [[ -n "$TOKEN" ]]; then
  CLI_ARGS+=(--token "$TOKEN")
fi
CLI_ARGS+=(-t "$TIMEOUT")
CLI_ARGS+=(--attach "$INPUT_FILE")

echo "[ocr] Sending OCR prompt for: $BASENAME ($NUM_PAGES page(s))" >&2
echo "[ocr] File will be uploaded to ChatGPT automatically." >&2

if [[ "$NO_SAVE" == true ]]; then
  node "$CLI" "${CLI_ARGS[@]}" "$PROMPT"
else
  TMPFILE="$(mktemp)"
  trap 'rm -f "$TMPFILE"' EXIT

  if node "$CLI" "${CLI_ARGS[@]}" "$PROMPT" > "$TMPFILE"; then
    # Strip any markdown code fences ChatGPT might wrap around the JSON
    sed -i '' '/^```\(json\)\{0,1\}$/d' "$TMPFILE"

    # Repair + validate JSON using Python
    # ChatGPT often produces: literal newlines in strings, invalid escapes (\T),
    # unescaped quotes ("GmbH"), missing keys, and key typos
    if python3 -c "
import json, sys, re

with open(sys.argv[1]) as f:
    raw = f.read().strip()

# Try parsing as-is first
try:
    d = json.loads(raw)
    json.dump(d, open(sys.argv[2], 'w'), indent=2, ensure_ascii=False)
    sys.exit(0)
except json.JSONDecodeError:
    pass

repairs = []

# Step 1: Fix structural issues before newline removal
# Fix missing 'text' keys (ChatGPT sometimes drops them)
fixed = re.sub(r'(\"page\":\s*\d+,)\s*\n\s*(?!\"text\")', r'\1\n\"text\": \"', raw)
if fixed != raw:
    repairs.append('missing text keys')
    raw = fixed

# Step 2: Replace all literal newlines with spaces
# ChatGPT uses \\n escape sequences for intended newlines in text fields,
# so literal newlines are either structural JSON whitespace or accidental.
# Both can safely be replaced with spaces since JSON doesn't require them.
if '\\n' in raw:
    raw = raw.replace('\\n', ' ')
    repairs.append('literal newlines')

# Step 3: Fix invalid escapes (backslash-aware, handles consecutive \\)
VALID = set('\"\\\\\\\\/bfnrtu')
result = []
i = 0
while i < len(raw):
    if raw[i] == '\\\\':
        num_bs = 0
        while i < len(raw) and raw[i] == '\\\\':
            num_bs += 1
            i += 1
        if i < len(raw) and num_bs % 2 == 1:
            next_char = raw[i]
            if next_char not in VALID:
                result.append('\\\\' * (num_bs + 1))
                result.append(next_char)
                i += 1
                if 'invalid escapes' not in repairs:
                    repairs.append('invalid escapes')
            else:
                result.append('\\\\' * num_bs)
                result.append(next_char)
                i += 1
        else:
            result.append('\\\\' * num_bs)
    else:
        result.append(raw[i])
        i += 1
raw = ''.join(result)

# Step 4: Fix common key typos from ChatGPT
raw = re.sub(r'\"pge\":', '\"page\":', raw)
raw = re.sub(r'\"pae\":', '\"page\":', raw)
raw = re.sub(r'\"ext\":', '\"text\":', raw)
raw = raw.replace('\"medim\"', '\"medium\"')

# Step 5: Iterative quote fixing
text = raw
for attempt in range(300):
    try:
        d = json.loads(text)
        if repairs:
            desc = ', '.join(repairs)
            print(f'[ocr] JSON repaired ({desc})', file=sys.stderr)
        json.dump(d, open(sys.argv[2], 'w'), indent=2, ensure_ascii=False)
        sys.exit(0)
    except json.JSONDecodeError as e:
        pos = e.pos
        if pos is None or pos <= 0:
            print(f'[ocr] JSON repair failed: {e}', file=sys.stderr)
            sys.exit(1)
        fix_pos = None
        for candidate in range(pos, max(pos - 5, 0), -1):
            if candidate < len(text) and text[candidate] == '\"':
                before = text[:candidate]
                q_count = 0
                j = 0
                while j < len(before):
                    if before[j] == '\\\\' and j + 1 < len(before):
                        j += 2
                        continue
                    if before[j] == '\"':
                        q_count += 1
                    j += 1
                if q_count % 2 == 1:
                    fix_pos = candidate
                    break
        if fix_pos is not None:
            text = text[:fix_pos] + '\\\\\"' + text[fix_pos+1:]
            if 'unescaped quotes' not in repairs:
                repairs.append('unescaped quotes')
            continue
        print(f'[ocr] JSON repair failed: {e}', file=sys.stderr)
        sys.exit(1)

print('[ocr] JSON repair: too many iterations', file=sys.stderr)
sys.exit(1)
" "$TMPFILE" "$OUTPUT"; then
      echo "[ocr] Saved: $OUTPUT" >&2
    else
      # Save raw output anyway (user can inspect and fix)
      cp "$TMPFILE" "$OUTPUT"
      echo "[ocr] Warning: Could not parse JSON. Saved raw output to: $OUTPUT" >&2
      exit 1
    fi
  else
    echo "[ocr] Error: chatgpt-bridge failed." >&2
    exit 1
  fi
fi
