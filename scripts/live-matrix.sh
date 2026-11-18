#!/usr/bin/env bash
# Live check of the plugin against a real OpenCode server, one case per model/variant.
#
# Each case runs two turns:
#   1. opencode run --archived --format json --model <provider/model#start> "<prompt>"
#      The prompt asks for an optional rejected level (bad), then the target level with persist.
#   2. opencode run --session <sid> "<prompt>"
# Pass/fail comes from the plugin trace only (set and revert outcomes, and the variant on the first
# context line of turn 2), never from model text.
#
# The plugin must write the trace: set "debug": true and, if you use -t, "debugFile" to the same path.
# Default trace: ${OPENCODE_LOG_DIR:-${XDG_DATA_HOME:-~/.local/share}/opencode/log}/opencode-adaptive-thinking.log
# Request mode (applyMode "request") is a plugin option, not a script option: set it in opencode.json.
#
# Usage: scripts/live-matrix.sh [-f cases-file] [-t trace-file] [case ...]
#   case: provider/model#start|bad|target|persist|expected-next
#     start          variant the session starts on ("" = model default)
#     bad            level that must be rejected by the tool ("-" = none)
#     target         level the agent is asked to set
#     persist        true | false
#     expected-next  variant on the first context line of turn 2 ("default" = model default)
# Exit status: 0 when every case passes, 1 when any case fails, 2 on usage errors.
usage() {
  cat <<'EOF'
Usage: scripts/live-matrix.sh [-f cases-file] [-t trace-file] [case ...]
  case: provider/model#start|bad|target|persist|expected-next  (see scripts/cases.example.txt)
EOF
}

log_dir="${OPENCODE_LOG_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log}"
trace="${OAT_TRACE_FILE:-$log_dir/opencode-adaptive-thinking.log}"
cases_file=""
while getopts ":f:t:h" opt; do
  case $opt in
    f) cases_file=$OPTARG ;;
    t) trace=$OPTARG ;;
    h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

cases=()
if [ -n "$cases_file" ]; then
  if [ ! -r "$cases_file" ]; then
    echo "cases file not readable: $cases_file" >&2
    exit 2
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      ""|\#*) continue ;;
    esac
    cases+=("$line")
  done < "$cases_file"
fi
for arg in "$@"; do cases+=("$arg"); done

if [ "${#cases[@]}" -eq 0 ]; then
  usage >&2
  exit 2
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode not found in PATH" >&2
  exit 2
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/oat-live.XXXXXX") || exit 2

# Writes "<PASS|FAIL>\t<case>\t<detail>" to $work/<index>.res.
run_case() {
  local idx=$1 spec=$2 dir="$work/$1"
  local ref bad target persist next model start sid rc i
  local set_lines reverted variant fails=() detail
  mkdir -p "$dir"
  IFS='|' read -r ref bad target persist next <<<"$spec"
  model=${ref%%#*}
  start=""
  case "$ref" in *'#'*) start=${ref#*#} ;; esac

  finish() {
    local status=PASS
    [ "${#fails[@]}" -gt 0 ] && status=FAIL
    detail=${detail:-ok}
    [ "${#fails[@]}" -gt 0 ] && detail=$(IFS='; '; echo "${fails[*]}")
    printf '%s\t%s\t%s\n' "$status" "$spec" "$detail" > "$work/$idx.res"
  }

  if [ -z "$model" ] || [ -z "$target" ] || [ -z "$next" ] || { [ "$persist" != true ] && [ "$persist" != false ]; }; then
    fails+=("malformed case (need provider/model#start|bad|target|true|false|expected-next)")
    finish
    return
  fi

  local prompt=""
  if [ -n "$bad" ] && [ "$bad" != "-" ]; then
    prompt="First call the set_reasoning_effort tool with level \"$bad\". It should be rejected; do not retry it. "
  fi
  prompt+="Then call set_reasoning_effort with level \"$target\" and persist $persist. Then reply with the word DONE."

  local model_arg=$model
  [ -n "$start" ] && model_arg="$model#$start"

  opencode run --archived --format json --model "$model_arg" "$prompt" >"$dir/turn1.out" 2>"$dir/turn1.err"
  rc=$?
  sid=$(grep -oE 'ses_[A-Za-z0-9]+' "$dir/turn1.out" | head -n1)
  if [ "$rc" -ne 0 ]; then fails+=("turn 1 exited $rc"); fi
  if [ -z "$sid" ]; then
    fails+=("no session id in turn 1 output")
    finish
    return
  fi
  if [ ! -r "$trace" ]; then
    fails+=("trace file not found: $trace (enable plugin debug and debugFile)")
    finish
    return
  fi

  # Set lines for this session. A set line is written only after a successful switch.
  set_lines=$(grep -E "^[^ ]+ set \{.*\"sessionID\":\"$sid\"" "$trace")
  if [ -n "$bad" ] && [ "$bad" != "-" ] && printf '%s\n' "$set_lines" | grep -q "\"level\":\"$bad\""; then
    fails+=("rejected level $bad was applied")
  fi
  if ! printf '%s\n' "$set_lines" | grep -q "\"level\":\"$target\""; then
    fails+=("no set to $target in trace")
  elif ! printf '%s\n' "$set_lines" | grep "\"level\":\"$target\"" | grep -q "\"persist\":$persist"; then
    fails+=("set to $target without persist=$persist")
  fi

  # A temporary change is reverted by the end-of-turn event, which can land after opencode run exits.
  if [ "$persist" = false ] && [ "$target" != "$start" ] && printf '%s\n' "$set_lines" | grep -q "\"level\":\"$target\""; then
    i=0
    while [ $i -lt 30 ] && ! grep -qE "^[^ ]+ revert \{.*\"sessionID\":\"$sid\"" "$trace"; do
      sleep 0.5
      i=$((i + 1))
    done
    reverted=$(grep -E "^[^ ]+ revert \{.*\"sessionID\":\"$sid\"" "$trace" | tail -n1)
    if ! printf '%s\n' "$reverted" | grep -q '"outcome":"reverted"'; then
      fails+=("no successful revert after turn 1 (last: ${reverted:-none})")
    fi
  fi

  local before
  before=$(wc -l < "$trace" | tr -d ' ')
  opencode run --session "$sid" "Reply with the word OK." >"$dir/turn2.out" 2>"$dir/turn2.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then fails+=("turn 2 exited $rc"); fi

  # First context line for this session written during turn 2 shows the variant the model starts with.
  variant=$(tail -n +$((before + 1)) "$trace" | grep -E "^[^ ]+ context \{.*\"sessionID\":\"$sid\"" | head -n1 |
    sed -n 's/.*"variant":\(null\|"[^"]*"\).*/\1/p')
  case "$variant" in
    '"'*) variant=${variant//\"/} ;;
    *) variant=default ;;
  esac
  if [ "$variant" != "$next" ]; then
    fails+=("turn 2 variant is $variant, expected $next")
  fi

  detail="set $target (persist=$persist), next=$variant"
  finish
}

echo "Running ${#cases[@]} case(s); trace: $trace"
idx=0
for spec in "${cases[@]}"; do
  run_case "$idx" "$spec" &
  idx=$((idx + 1))
done
wait

pass=0
fail=0
printf '%-6s %-48s %s\n' "RESULT" "CASE" "DETAIL"
for ((n = 0; n < idx; n++)); do
  res="$work/$n.res"
  if [ ! -s "$res" ]; then
    printf 'FAIL\t%s\t%s\n' "${cases[$n]}" "no result recorded" > "$res"
  fi
  IFS=$'\t' read -r status spec detail < "$res"
  if [ "$status" = PASS ]; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
  printf '%-6s %-48s %s\n' "$status" "$spec" "$detail"
done
echo "passed: $pass  failed: $fail  (logs: $work)"
[ "$fail" -eq 0 ]
