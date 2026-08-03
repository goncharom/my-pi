#!/usr/bin/env bats

setup() {
  TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/learn skill test.XXXXXX")"
  export LEARN_CAPSULES_DIR="$TEST_ROOT/data/capsules"
  export LEARN_TODAY="2026-07-21"
  unset LEARN_RANDOM_PICK || true
  mkdir -p "$LEARN_CAPSULES_DIR"
  LEARN_SCRIPT="$BATS_TEST_DIRNAME/../scripts/learn"
  TODAY="$LEARN_TODAY"
  YESTERDAY="2026-07-20"
  PAST_5="2026-07-16"
  FUTURE="2026-07-22"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

write_capsule() {
  id=$1
  due=$2
  interval=${3:-2}
  review_count=${4:-0}
  last_reviewed=${5:-}
  last_score=${6:-}
  created=${7:-2026-07-01}

  cat > "$LEARN_CAPSULES_DIR/$id.md" <<EOF
---
id: $id
created: $created
due: $due
interval_days: $interval
review_count: $review_count
last_reviewed: $last_reviewed
last_score: $last_score
---

# $id

This lesson explains a multi-step technical workflow, the important causal ordering, and the failure modes to reason about during review.
EOF
}

frontmatter_value() {
  key=$1
  file=$2
  awk -v key="$key" '
    index($0, key ":") == 1 {
      value = substr($0, length(key) + 2)
      sub(/^[[:space:]]+/, "", value)
      print value
      exit
    }
  ' "$file"
}

extract_body() {
  awk '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { in_frontmatter = 0; in_body = 1; next }
    in_body { print }
  ' "$1"
}

assert_json_field_equals() {
  json=$1
  jq_filter=$2
  expected=$3
  actual="$(printf '%s\n' "$json" | jq -r "$jq_filter")"
  [ "$actual" = "$expected" ]
}

@test "empty database: next returns empty" {
  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.status' 'empty'
  [ "$stderr" = "" ]
}

@test "future capsules are not selected" {
  write_capsule future-capsule "$FUTURE"

  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.status' 'empty'
}

@test "due today can be selected" {
  write_capsule due-today "$TODAY"

  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.status' 'ok'
  assert_json_field_equals "$output" '.id' 'due-today'
}

@test "overdue capsules use weight equal to one plus days overdue" {
  write_capsule aaa-today "$TODAY"
  write_capsule zzz-overdue "$PAST_5"
  export LEARN_RANDOM_PICK=7

  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.status' 'ok'
  assert_json_field_equals "$output" '.id' 'zzz-overdue'
}

@test "only one due capsule is always returned" {
  write_capsule only-due "$TODAY"
  write_capsule future-capsule "$FUTURE"

  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.id' 'only-due'

  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.id' 'only-due'
}

@test "invalid capsules are skipped by next and status and warn on stderr" {
  cat > "$LEARN_CAPSULES_DIR/bad.md" <<EOF
---
id: bad
created: not-a-date
due: $TODAY
interval_days: 1
review_count: 0
last_reviewed:
last_score:
---

# Bad

Invalid date.
EOF

  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.status' 'empty'
  [[ "$stderr" == *"Warning: invalid capsule"* ]]

  run --separate-stderr "$LEARN_SCRIPT" status
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.total' '0'
  [[ "$stderr" == *"Warning: invalid capsule"* ]]
}

@test "score 0 resets interval to the 2 day minimum" {
  write_capsule score-zero "$TODAY" 10 2

  run --separate-stderr "$LEARN_SCRIPT" record score-zero 0
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.interval_days' '2'
  assert_json_field_equals "$output" '.due' '2026-07-23'
}

@test "score 1 multiplies interval by 1.25 and rounds" {
  write_capsule score-one "$TODAY" 4 2

  run --separate-stderr "$LEARN_SCRIPT" record score-one 1
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.interval_days' '5'
  assert_json_field_equals "$output" '.due' '2026-07-26'
}

@test "score 1 respects the 2 day minimum" {
  write_capsule score-one-minimum "$TODAY" 1 2

  run --separate-stderr "$LEARN_SCRIPT" record score-one-minimum 1
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.interval_days' '2'
  assert_json_field_equals "$output" '.due' '2026-07-23'
}

@test "score 2 doubles interval with minimum of 2" {
  write_capsule score-two "$TODAY" 1 2

  run --separate-stderr "$LEARN_SCRIPT" record score-two 2
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.interval_days' '2'
  assert_json_field_equals "$output" '.due' '2026-07-23'
}

@test "score 3 triples interval with minimum of 4" {
  write_capsule score-three "$TODAY" 1 2

  run --separate-stderr "$LEARN_SCRIPT" record score-three 3
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.interval_days' '4'
  assert_json_field_equals "$output" '.due' '2026-07-25'
}

@test "record increments review_count" {
  write_capsule review-count "$TODAY" 2 7

  run --separate-stderr "$LEARN_SCRIPT" record review-count 2
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.review_count' '8'
  [ "$(frontmatter_value review_count "$LEARN_CAPSULES_DIR/review-count.md")" = "8" ]
}

@test "record updates review metadata" {
  write_capsule review-metadata "$TODAY" 3 1

  run --separate-stderr "$LEARN_SCRIPT" record review-metadata 3
  [ "$status" -eq 0 ]
  file="$LEARN_CAPSULES_DIR/review-metadata.md"
  [ "$(frontmatter_value due "$file")" = "2026-07-30" ]
  [ "$(frontmatter_value interval_days "$file")" = "9" ]
  [ "$(frontmatter_value last_reviewed "$file")" = "2026-07-21" ]
  [ "$(frontmatter_value last_score "$file")" = "3" ]
}

@test "record does not change creation date" {
  write_capsule creation-date "$TODAY" 2 0 '' '' 2026-01-15

  run --separate-stderr "$LEARN_SCRIPT" record creation-date 2
  [ "$status" -eq 0 ]
  [ "$(frontmatter_value created "$LEARN_CAPSULES_DIR/creation-date.md")" = "2026-01-15" ]
}

@test "record preserves Markdown body byte-for-byte for complex content" {
  id=body-preservation
  body_file="$TEST_ROOT/body.expected"
  body_after="$TEST_ROOT/body.after"

  cat > "$body_file" <<'EOF'

# Body preservation

This body has colons: alpha: beta: gamma.

## Code fence

```yaml
---
example: value
nested:
  key: value
---
```

```bash
echo "unicode: café λ 🚀"
```

## Additional separator

---

The separator above is part of the body, not frontmatter.
EOF

  {
    cat <<EOF
---
id: $id
created: 2026-07-01
due: $TODAY
interval_days: 2
review_count: 0
last_reviewed:
last_score:
---
EOF
    cat "$body_file"
  } > "$LEARN_CAPSULES_DIR/$id.md"

  run --separate-stderr "$LEARN_SCRIPT" record "$id" 2
  [ "$status" -eq 0 ]
  extract_body "$LEARN_CAPSULES_DIR/$id.md" > "$body_after"
  cmp "$body_file" "$body_after"
}

@test "invalid score fails" {
  write_capsule invalid-score "$TODAY"

  run --separate-stderr "$LEARN_SCRIPT" record invalid-score 4
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"Invalid score"* ]]
}

@test "invalid ID with path separator or uppercase fails" {
  run --separate-stderr "$LEARN_SCRIPT" record ../bad 1
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"Invalid capsule id"* ]]

  run --separate-stderr "$LEARN_SCRIPT" record Bad 1
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"Invalid capsule id"* ]]
}

@test "invalid date fails validation" {
  cat > "$LEARN_CAPSULES_DIR/invalid-date.md" <<EOF
---
id: invalid-date
created: 2026-02-30
due: $TODAY
interval_days: 1
review_count: 0
last_reviewed:
last_score:
---

# Invalid date

Body.
EOF

  run --separate-stderr "$LEARN_SCRIPT" validate "$LEARN_CAPSULES_DIR/invalid-date.md"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"created is not a valid"* ]]
}

@test "filename mismatch fails validation" {
  cat > "$LEARN_CAPSULES_DIR/wrong-name.md" <<EOF
---
id: right-name
created: 2026-07-01
due: $TODAY
interval_days: 1
review_count: 0
last_reviewed:
last_score:
---

# Right name

Body.
EOF

  run --separate-stderr "$LEARN_SCRIPT" validate "$LEARN_CAPSULES_DIR/wrong-name.md"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"filename does not match id"* ]]
}

@test "empty body fails validation" {
  cat > "$LEARN_CAPSULES_DIR/empty-body.md" <<EOF
---
id: empty-body
created: 2026-07-01
due: $TODAY
interval_days: 1
review_count: 0
last_reviewed:
last_score:
---
EOF

  run --separate-stderr "$LEARN_SCRIPT" validate "$LEARN_CAPSULES_DIR/empty-body.md"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"Markdown body is empty"* ]]
}

@test "status counts total due future and never reviewed" {
  write_capsule due-never "$TODAY" 1 0
  write_capsule overdue-reviewed "$YESTERDAY" 2 3 2026-07-20 2
  write_capsule future-never "$FUTURE" 1 0

  run --separate-stderr "$LEARN_SCRIPT" status
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.total' '3'
  assert_json_field_equals "$output" '.due' '2'
  assert_json_field_equals "$output" '.future' '1'
  assert_json_field_equals "$output" '.never_reviewed' '2'
}

@test "capsule remains valid after atomic record update" {
  write_capsule atomic-update "$TODAY" 2 0

  run --separate-stderr "$LEARN_SCRIPT" record atomic-update 2
  [ "$status" -eq 0 ]

  run --separate-stderr "$LEARN_SCRIPT" validate "$LEARN_CAPSULES_DIR/atomic-update.md"
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.status' 'ok'
}

@test "commands work when skill or capsule paths contain spaces" {
  skill_copy="$TEST_ROOT/copied skill/learn"
  mkdir -p "$skill_copy/scripts" "$skill_copy/data/capsules"
  cp "$LEARN_SCRIPT" "$skill_copy/scripts/learn"
  chmod +x "$skill_copy/scripts/learn"

  unset LEARN_CAPSULES_DIR
  cat > "$skill_copy/data/capsules/path-with-spaces.md" <<EOF
---
id: path-with-spaces
created: 2026-07-01
due: $TODAY
interval_days: 1
review_count: 0
last_reviewed:
last_score:
---

# Path with spaces

Body.
EOF

  run --separate-stderr "$skill_copy/scripts/learn" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.id' 'path-with-spaces'

  export LEARN_CAPSULES_DIR="$TEST_ROOT/capsules with spaces"
  mkdir -p "$LEARN_CAPSULES_DIR"
  write_capsule capsule-path-spaces "$TODAY"
  run --separate-stderr "$LEARN_SCRIPT" next
  [ "$status" -eq 0 ]
  assert_json_field_equals "$output" '.id' 'capsule-path-spaces'
}
