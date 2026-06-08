#!/bin/bash
set -euo pipefail

# Reports:
#   - Oversized files (tables) with file sizes in KB
#   - Total line counts and sizes by extension
#   - Line length warnings for terminal visibility
#
# Generic tool — works in any project directory.

PROJECT_NAME=$(basename "$(pwd)")

YELLOW_THRESHOLD=500
RED_THRESHOLD=800
LONG_LINE_THRESHOLD=120
VERY_LONG_LINE_THRESHOLD=300

# Extensions to scan (space-separated, without dots)
EXTENSIONS="${FILE_EXTENSIONS:-js mjs sys2 md html css json sh}"

# Color definitions
if [[ -t 1 ]]; then
  COLOR_RED=$(tput setaf 1 2>/dev/null || true)
  COLOR_YELLOW=$(tput setaf 3 2>/dev/null || true)
  COLOR_GREEN=$(tput setaf 2 2>/dev/null || true)
  COLOR_CYAN=$(tput setaf 6 2>/dev/null || true)
  COLOR_RESET=$(tput sgr0 2>/dev/null || true)
else
  COLOR_RED=""
  COLOR_YELLOW=""
  COLOR_GREEN=""
  COLOR_CYAN=""
  COLOR_RESET=""
fi

TERM_COLS=$(tput cols 2>/dev/null || echo "${COLUMNS:-80}")

shorten_path() {
  local p="$1" max="$2" len=${#1}
  if (( len <= max || max <= 4 )); then printf "%s" "$p"; return; fi
  local keep=$((max - 1))
  if (( keep < 1 )); then keep=1; fi
  printf "…%s" "${p: -keep}"
}

colorize_count() {
  local count="$1" padded="$2"
  if [[ -z "$COLOR_RESET" ]]; then printf "%s" "$padded"; return; fi
  if (( count > RED_THRESHOLD )); then printf "%s%s%s" "$COLOR_RED" "$padded" "$COLOR_RESET"; return; fi
  if (( count > YELLOW_THRESHOLD )); then printf "%s%s%s" "$COLOR_YELLOW" "$padded" "$COLOR_RESET"; return; fi
  printf "%s" "$padded"
}

get_file_size_kb() {
  local size_bytes
  size_bytes=$(stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null)
  local size_kb=$((size_bytes / 1024))
  echo $(( size_kb > 0 ? size_kb : 1 ))
}

compute_total_lines() {
  local -n ref="$1"
  if (( ${#ref[@]} == 0 )); then echo 0; return; fi
  printf '%s\0' "${ref[@]}" | xargs -0 wc -l | tail -n 1 | awk '{print $1}'
}

compute_total_size_kb() {
  local -n ref="$1"
  local total=0
  for f in "${ref[@]}"; do total=$((total + $(get_file_size_kb "$f"))); done
  echo $total
}

check_long_lines() {
  local file="$1"
  local count avg first
  count=$(awk -v t="$VERY_LONG_LINE_THRESHOLD" 'length($0)>t{c++} END{print c+0}' "$file")
  avg=$(awk -v t="$VERY_LONG_LINE_THRESHOLD" 'length($0)>t{s+=length($0);c++} END{if(c>0)print int(s/c);else print 0}' "$file")
  first=$(awk -v t="$VERY_LONG_LINE_THRESHOLD" 'length($0)>t{print NR;exit}' "$file")
  echo "$count ${avg} ${first:-0}"
}

oversized_rows() {
  local min="$1"
  local -n ref="$2"
  if (( ${#ref[@]} == 0 )); then return 0; fi
  printf '%s\0' "${ref[@]}" | xargs -0 wc -l | sed '$d' | awk -v min="$min" '$1>min{print}'
}

render_oversized_table() {
  local title="$1" min_lines="$2" array_name="$3"
  local -n ref="$array_name"
  local -a rows=()
  mapfile -t rows < <(oversized_rows "$min_lines" "$array_name" | sort -nr)

  echo "--- ${title} oversized files (>${min_lines} lines) ---"
  if (( ${#rows[@]} == 0 )); then echo "(none)"; echo ""; return; fi

  local col_lines=7 col_size=8 col_level=6 col_warn=8
  local col_path=$((TERM_COLS - col_lines - col_size - col_level - col_warn - 12))
  if (( col_path < 25 )); then col_path=25; fi

  printf "%-${col_lines}s | %-${col_size}s | %-${col_level}s | %-${col_warn}s | %s\n" "Lines" "Size(KB)" "Level" ">${VERY_LONG_LINE_THRESHOLD}chr" "Path"
  printf "%-${col_lines}s-+-%-${col_size}s-+-%-${col_level}s-+-%-${col_warn}s-+-%s\n" \
    "$(printf '%*s' "$col_lines" | tr ' ' '-')" \
    "$(printf '%*s' "$col_size" | tr ' ' '-')" \
    "$(printf '%*s' "$col_level" | tr ' ' '-')" \
    "$(printf '%*s' "$col_warn" | tr ' ' '-')" \
    "$(printf '%*s' "$col_path" | tr ' ' '-')"

  for entry in "${rows[@]}"; do
    local lc fp
    lc=$(awk '{print $1}' <<<"$entry")
    fp=$(awk '{$1="";sub(/^ +/,"");print}' <<<"$entry")

    local level="WARN"
    if (( lc > RED_THRESHOLD )); then level="RED"; fi

    local sk
    sk=$(get_file_size_kb "$fp")

    local wc_col="N/A"
    if [[ "$fp" == *.md || "$fp" == *.html || "$fp" == *.css ]]; then
      local info
      info=$(check_long_lines "$fp")
      local vl
      vl=$(echo "$info" | cut -d' ' -f1)
      if (( vl > 0 )); then wc_col="${COLOR_RED}${vl}${COLOR_RESET}"
      else wc_col="${COLOR_GREEN}0${COLOR_RESET}"; fi
    fi

    local dp
    dp=$(shorten_path "$fp" "$col_path")
    local np
    printf -v np "%6s" "$lc"
    np=$(colorize_count "$lc" "$np")
    printf "%-${col_lines}s | %7s | %-${col_level}s | %7s | %s\n" "$np" "$sk" "$level" "$wc_col" "$dp"
  done
  echo ""
}

# --- Main ---

echo "=== ${PROJECT_NAME} — File Size Analysis ==="
echo

echo "📊 PROJECT SIZE"
echo "==============="
total_project_size=$(du -sk . 2>/dev/null | cut -f1)
echo "Total: ${total_project_size} KB ($(echo "scale=1; $total_project_size/1024" | bc -l 2>/dev/null || echo "$(($total_project_size/1024))") MB)"
for dir in docs docs/specs src config; do
  if [ -d "$dir" ]; then
    ds=$(du -sk "$dir" 2>/dev/null | cut -f1)
    echo "${dir}/: ${ds} KB ($(echo "scale=1; $ds/1024" | bc -l 2>/dev/null || echo "$(($ds/1024))") MB)"
  fi
done
echo

# Collect files — use git ls-files if inside a repo (respects .gitignore), else fall back to find
files_to_process=()
if git rev-parse --is-inside-work-tree &>/dev/null; then
  while IFS= read -r file; do
    [[ -f "$file" ]] && files_to_process+=("$file")
  done < <(for ext in $EXTENSIONS; do git ls-files "*.${ext}"; done | sort -u)
else
  find_expr=()
  first=true
  for ext in $EXTENSIONS; do
    if $first; then first=false; else find_expr+=("-o"); fi
    find_expr+=("-name" "*.${ext}")
  done
  while IFS= read -r -d '' file; do
    files_to_process+=("$file")
  done < <(find . -path "*/node_modules" -prune -o -type f \( "${find_expr[@]}" \) -print0)
fi

if (( ${#files_to_process[@]} == 0 )); then
  echo "No files found for extensions: ${EXTENSIONS}"
  exit 0
fi

# Group files by extension
declare -A ext_files ext_lines ext_sizes
for ext in $EXTENSIONS; do
  declare -a "files_${ext}=()"
done

for file in "${files_to_process[@]}"; do
  base="${file##*.}"
  eval "files_${base}+=(\"\$file\")"
done

echo "--- Oversized Files ---"
for ext in $EXTENSIONS; do
  arr="files_${ext}"
  local_ref="${arr}[@]"
  count=$(eval "echo \${#${arr}[@]}")
  if (( count > 0 )); then
    render_oversized_table ".${ext}" "$YELLOW_THRESHOLD" "files_${ext}"
  fi
done

total_all_lines=0
total_all_size=0

echo "--- Line Totals and File Sizes ---"
printf "%-8s | %-6s | %-8s | %-8s | %s\n" "Type" "Files" "Lines" "Size(KB)" "Avg KB/File"
printf "%-8s-+-%-6s-+-%-8s-+-%-8s-+-%s\n" "--------" "------" "--------" "--------" "----------"

for ext in $EXTENSIONS; do
  arr="files_${ext}"
  count=$(eval "echo \${#${arr}[@]}")
  if (( count > 0 )); then
    lines=$(compute_total_lines "files_${ext}")
    size=$(compute_total_size_kb "files_${ext}")
    avg=$((size / count))
  else
    lines=0; size=0; avg=0
  fi
  total_all_lines=$((total_all_lines + lines))
  total_all_size=$((total_all_size + size))
  printf "%-8s | %6d | %8s | %8s | %s\n" ".${ext}" "$count" "$lines" "$size" "$avg"
done
printf "%-8s | %6s | %8s | %8s | %s\n" "TOTAL" "-" "$total_all_lines" "$total_all_size" "-"
echo ""

# Line length analysis for text files
text_exts="md html css"
total_long=0
declare -A file_long_info

for ext in $text_exts; do
  arr="files_${ext}"
  count=$(eval "echo \${#${arr}[@]}")
  if (( count == 0 )); then continue; fi
  eval "for f in \"\${${arr}[@]}\"; do
    info=\$(check_long_lines \"\$f\")
    vl=\$(echo \"\$info\" | cut -d' ' -f1)
    total_long=\$((total_long + vl))
    if (( vl > 0 )); then file_long_info[\"\$f\"]=\"\$info\"; fi
  done"
done

echo "📋 LINE LENGTH ANALYSIS (>${VERY_LONG_LINE_THRESHOLD} chars)"
echo "================================="
echo "${COLOR_RED}Lines exceeding ${VERY_LONG_LINE_THRESHOLD} chars: ${total_long}${COLOR_RESET}"
echo ""

if (( ${#file_long_info[@]} > 0 )); then
  echo "📄 FILES WITH LINES >${VERY_LONG_LINE_THRESHOLD} CHARACTERS:"
  printf "%-40s | %5s | %10s | %s\n" "File" "Count" "Avg Length" "First Line"
  printf "%-40s-+-%5s-+-%10s-+-%s\n" "$(printf '%40s' | tr ' ' '-')" "-----" "----------" "----------"
  for f in "${!file_long_info[@]}"; do
    info="${file_long_info[$f]}"
    vl=$(echo "$info" | cut -d' ' -f1)
    al=$(echo "$info" | cut -d' ' -f2)
    fl=$(echo "$info" | cut -d' ' -f3)
    printf "%-40s | %s%5d%s | %s%7d%s chars | line %s%5d%s\n" \
      "$(basename "$f")" "$COLOR_RED" "$vl" "$COLOR_RESET" "$COLOR_YELLOW" "$al" "$COLOR_RESET" "$COLOR_CYAN" "$fl" "$COLOR_RESET"
  done
  echo ""
fi

if (( total_long == 0 )); then echo "✅ All lines under ${VERY_LONG_LINE_THRESHOLD} characters"
elif (( total_long < 50 )); then echo "⚠️  Few long lines — minor readability issues"
elif (( total_long < 200 )); then echo "🚨 Many long lines — significant readability issues"
else echo "🔥 CRITICAL: Too many long lines — major readability problems"
fi
echo ""
