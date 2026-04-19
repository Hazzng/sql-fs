# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--tool amp|claude] [max_iterations]

set -e

export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1

# Parse arguments
TOOL="claude"
MAX_ITERATIONS=10

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      fi
      shift
      ;;
  esac
done

# Validate tool choice
if [[ "$TOOL" != "amp" && "$TOOL" != "claude" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp' or 'claude'."
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT_PRD_FILE="$REPO_ROOT/prd.json"
LOCAL_PRD_FILE="$SCRIPT_DIR/prd.json"
if [ -f "$ROOT_PRD_FILE" ]; then
  PRD_FILE="$ROOT_PRD_FILE"
else
  PRD_FILE="$LOCAL_PRD_FILE"
fi

ROOT_PROGRESS_FILE="$REPO_ROOT/progress.txt"
LOCAL_PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
if [ -f "$ROOT_PROGRESS_FILE" ]; then
  PROGRESS_FILE="$ROOT_PROGRESS_FILE"
else
  PROGRESS_FILE="$LOCAL_PROGRESS_FILE"
fi

ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"
AMP_PROMPT_FILE="$SCRIPT_DIR/prompt.md"
CLAUDE_PROMPT_FILE="$SCRIPT_DIR/CLAUDE.md"

if [[ "$TOOL" == "amp" && ! -f "$AMP_PROMPT_FILE" ]]; then
  echo "Error: $AMP_PROMPT_FILE does not exist. Use --tool claude or add the prompt file."
  exit 1
fi

if [[ "$TOOL" == "claude" && ! -f "$CLAUDE_PROMPT_FILE" ]]; then
  echo "Error: $CLAUDE_PROMPT_FILE does not exist."
  exit 1
fi

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")

  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"

    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"

    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

REVIEW_FILE="$SCRIPT_DIR/review.md"

run_post_loop() {
  echo ""
  echo "==============================================================="
  echo "  Post-loop: Simplify"
  echo "==============================================================="
  claude "/simplify" -p --model claude-opus-4-5 --effort high --dangerously-skip-permissions || true

  echo ""
  echo "==============================================================="
  echo "  Post-loop: Code Review"
  echo "==============================================================="
  agent "Review all changes in the current branch diff to main, including related untracked files in the worktree. For each file:
1. Summarize what changed
2. Identify potential bugs or logic errors
3. Check for security vulnerabilities
4. Suggest code quality improvements
5. Rate severity: critical/high/medium/low
Format as a structured review report and write the report to $REVIEW_FILE file." -p || true

  echo ""
  echo "==============================================================="
  echo "  Post-loop: Validate and Fix Review Findings"
  echo "==============================================================="
  claude "Here are the findings from code review in $REVIEW_FILE file. Please validate all the flagged issues and fix the valid issues only." -p --model claude-opus-4-5 --effort high --dangerously-skip-permissions || true
}

echo "Starting Ralph - Tool: $TOOL - Max iterations: $MAX_ITERATIONS"

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($TOOL)"
  echo "==============================================================="

  # Run the selected tool with the ralph prompt
  if [[ "$TOOL" == "amp" ]]; then
    OUTPUT=$(amp --dangerously-allow-all < "$AMP_PROMPT_FILE" 2>&1 | tee /dev/stderr) || true
  else
    # Claude Code: use --dangerously-skip-permissions for autonomous operation, --print for output
    OUTPUT=$(claude --dangerously-skip-permissions --print --model claude-sonnet-4-6 --effort high < "$CLAUDE_PROMPT_FILE" 2>&1 | tee /dev/stderr) || true
  fi

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all tasks!"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    run_post_loop
    exit 0
  fi

  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
run_post_loop
exit 1
