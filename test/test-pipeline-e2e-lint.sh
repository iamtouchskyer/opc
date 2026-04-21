#!/bin/bash
# Pipeline E2E trigger lint tests — validates criteria-lint check #12 (pipeline-e2e-trigger)
set -e

source "$(dirname "$0")/test-helpers.sh"
setup_tmpdir

echo "=== Pipeline E2E Trigger Lint Tests ==="
echo ""

# Helper: write acceptance criteria and run lint
run_lint() {
  local file="$1"
  $HARNESS criteria-lint "$file" 2>/dev/null || true
}

# ─── 1. pipeline keyword but no e2e trigger OUT → fails ───
echo "--- Test 1: pipeline keyword without e2e trigger OUT ---"
cat > criteria1.md <<'EOF'
## Outcomes
- OUT-1: CI/CD pipeline deploys to staging on every push
- OUT-2: All unit tests pass with 100% coverage
- OUT-3: API returns correct response shapes

## Verification
- OUT-1: Check deployment logs
- OUT-2: Run npm test, check coverage report
- OUT-3: curl /api/health returns 200

## Quality Constraints
- Deploy under 5 minutes

## Out of Scope
- Production deployment
EOF
OUT=$(run_lint criteria1.md)
if echo "$OUT" | grep -q "pipeline-e2e-trigger"; then
  echo "  ✅ lint catches missing e2e trigger in pipeline task"
  PASS=$((PASS + 1))
else
  echo "  ❌ lint should have caught pipeline-e2e-trigger"
  FAIL=$((FAIL + 1))
fi

# ─── 2. webhook keyword with e2e trigger OUT → passes ───
echo "--- Test 2: webhook keyword with e2e trigger OUT ---"
cat > criteria2.md <<'EOF'
## Outcomes
- OUT-1: Webhook fires on GitHub push events
- OUT-2: Downstream service processes webhook payload within 30 seconds
- OUT-3: End-to-end live trigger verification from push to deployment artifact

## Verification
- OUT-1: GitHub webhook delivery logs show 200
- OUT-2: Service logs show payload processing
- OUT-3: Push to repo, observe deployment artifact created within 30s

## Quality Constraints
- Webhook processing under 5 seconds

## Out of Scope
- Manual deployments
EOF
OUT=$(run_lint criteria2.md)
if echo "$OUT" | grep -q '"pass": true'; then
  echo "  ✅ lint passes with e2e trigger OUT"
  PASS=$((PASS + 1))
else
  echo "  ❌ lint should pass — e2e trigger OUT is present"
  echo "  Output: $OUT"
  FAIL=$((FAIL + 1))
fi

# ─── 3. no pipeline keywords → check skipped ───
echo "--- Test 3: no pipeline keywords → check not triggered ---"
cat > criteria3.md <<'EOF'
## Outcomes
- OUT-1: Login form validates email format
- OUT-2: Password must be at least 8 characters
- OUT-3: Error message shows on invalid input

## Verification
- OUT-1: Submit invalid email, check error returns status code 400
- OUT-2: Submit short password, check error returns status code 400
- OUT-3: Screenshot shows error banner

## Quality Constraints
- Form renders under 200ms

## Out of Scope
- OAuth integration
EOF
OUT=$(run_lint criteria3.md)
if echo "$OUT" | grep -q '"pass": true'; then
  echo "  ✅ lint passes when no pipeline keywords"
  PASS=$((PASS + 1))
else
  echo "  ❌ lint should pass — no pipeline keywords"
  echo "  Output: $OUT"
  FAIL=$((FAIL + 1))
fi

# ─── 4. cron keyword with live verification → passes ───
echo "--- Test 4: cron keyword with live verification OUT ---"
cat > criteria4.md <<'EOF'
## Outcomes
- OUT-1: Cron job runs at midnight UTC daily
- OUT-2: Report email sent to admin within 5 minutes of cron trigger
- OUT-3: Live verification by triggering cron manually and observing email artifact

## Verification
- OUT-1: Check crontab entry matches schedule
- OUT-2: Email received timestamp within 5 min of cron fire
- OUT-3: Manual cron trigger, email arrives

## Quality Constraints
- Report generation under 2 minutes

## Out of Scope
- Custom scheduling UI
EOF
OUT=$(run_lint criteria4.md)
if echo "$OUT" | grep -q '"pass": true'; then
  echo "  ✅ lint passes with cron + live verification"
  PASS=$((PASS + 1))
else
  echo "  ❌ lint should pass"
  echo "  Output: $OUT"
  FAIL=$((FAIL + 1))
fi

# ─── 5. deploy keyword with manual-only verification → fails ───
echo "--- Test 5: deploy keyword without e2e trigger → fails ---"
cat > criteria5.md <<'EOF'
## Outcomes
- OUT-1: Deploy script pushes to production server
- OUT-2: Health check endpoint returns 200 after deploy
- OUT-3: Rollback script restores previous version

## Verification
- OUT-1: Check deploy logs for success message
- OUT-2: curl /health returns 200
- OUT-3: Run rollback, verify previous version

## Quality Constraints
- Deploy under 3 minutes

## Out of Scope
- Blue-green deployment
EOF
OUT=$(run_lint criteria5.md)
if echo "$OUT" | grep -q "pipeline-e2e-trigger"; then
  echo "  ✅ lint catches deploy without e2e trigger"
  PASS=$((PASS + 1))
else
  echo "  ❌ lint should catch missing e2e trigger for deploy task"
  FAIL=$((FAIL + 1))
fi

# ─── 6. integration keyword with e2e trigger → passes ───
echo "--- Test 6: integration keyword with e2e trigger phrase ---"
cat > criteria6.md <<'EOF'
## Outcomes
- OUT-1: API integration with payment gateway processes test charges
- OUT-2: Webhook callback updates order status in database
- OUT-3: E2e trigger from checkout button to payment confirmation within 10 seconds

## Verification
- OUT-1: Test charge appears in gateway dashboard
- OUT-2: Database query shows updated order status
- OUT-3: Click checkout, observe payment confirmation page

## Quality Constraints
- Payment processing under 5 seconds

## Out of Scope
- Real money transactions
EOF
OUT=$(run_lint criteria6.md)
if echo "$OUT" | grep -q '"pass": true'; then
  echo "  ✅ lint passes with integration + e2e trigger"
  PASS=$((PASS + 1))
else
  echo "  ❌ lint should pass"
  echo "  Output: $OUT"
  FAIL=$((FAIL + 1))
fi

print_results
