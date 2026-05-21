# Deploy LPF-Claude to Heroku (5–10 min total)

You already committed locally. This recipe pushes to GitHub + Heroku in one go.

## Prereqs (one-time install — skip if you have them)

```bash
# Check what you have
gh --version           # GitHub CLI
heroku --version       # Heroku CLI

# Install if missing (Windows — pick one):
winget install GitHub.cli
winget install --id=Heroku.HerokuCLI
```

Then log in once each:

```bash
gh auth login           # browser flow — pick "github.com", "HTTPS", "Login with a web browser"
heroku login            # browser flow
```

## Step 1 — Create GitHub repo + push

```bash
cd "D:\Freelance\CTR\claude-based-lpf\LPF-Claude"

# Create private repo + push in one command
gh repo create lpf-claude-pipeline \
    --private \
    --source=. \
    --remote=origin \
    --push \
    --description "LPF (Local Perfect Fit) — Express + Postgres pipeline that ingests SAP jobs from JPE, runs 8-stage enrichment, writes to RecruiterFlow + SAP Jobs sheet + Instantly + HeyReach"
```

## Step 2 — Create Heroku app + set env vars + deploy

```bash
# 2a. Create the app (auto-names if you don't provide one, but let's be explicit)
heroku create lpf-claude-pipeline

# 2b. Set every env var from your local .env in one shot
# Heroku CLI reads each `KEY=value` line from .env via xargs:
cat .env | grep -v '^#' | grep -v '^$' | xargs -L1 heroku config:set --app lpf-claude-pipeline

# (If xargs isn't available on Windows, run each line manually — heroku config:set KEY=value)

# 2c. Push code → Heroku auto-builds + runs migrations
git push heroku main

# 2d. Watch the boot logs
heroku logs --tail --app lpf-claude-pipeline
```

## Step 3 — One-time DB migration on the deployed app

The DB is Stackhero (already cloud-resident), so no Heroku-Postgres addon needed.
Run the migration script remotely to make sure the latest schema (`email_skip_reason` column, etc.) is applied:

```bash
heroku run npm run migrate --app lpf-claude-pipeline
```

## Step 4 — Test the deployed webhook

```bash
# Replace with your real Heroku URL (heroku open will show it)
HEROKU_URL=https://lpf-claude-pipeline-xxx.herokuapp.com

curl -X POST $HEROKU_URL/webhook/deploy-test \
    -H "Content-Type: application/json" \
    -d '{
        "job_url": "https://www.linkedin.com/jobs/view/deploy-smoke-test-1",
        "job_title": "SAP FI/CO Consultant",
        "country": "Germany",
        "city": "Munich",
        "company_url": "siemens.de",
        "company_name": "Siemens",
        "company_linkedin_url": "https://www.linkedin.com/company/siemens"
    }'

# Should respond { "ok": true, "saved": 1, ... }
# Then visit  https://<your-app>.herokuapp.com  to see the dashboard
```

## Notes

- The deployed app reads connection rows from `lpf_connections` (Stackhero) on every
  boot, so HeyReach + Instantly + Google OAuth + SAP-sheet Apps-Script URL all
  hydrate automatically — you don't need to re-configure them in the Heroku dashboard.
- Heroku free tier was discontinued; Hobby is $7/mo. Render is a 1:1 alternative at
  the same price tier if you'd rather use that — same `Procfile`, same env vars,
  pick "Web Service" + "Auto-deploy from main".
- Once deployed, point JPE's webhook config to `https://<your-app>.herokuapp.com/webhook/lpf`
  (or `/webhook/<any-slug>` — the slug is just a tracing tag).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `heroku create` fails with "name taken" | append a suffix: `heroku create lpf-claude-pipeline-prod` |
| `git push heroku main` fails with "src refspec main does not match" | your branch is `master` not `main` — run `git push heroku master:main` |
| Build fails — Node version mismatch | check `package.json` engines = `"node": "20.x"` (already set) |
| Boot crash — DB connection | confirm `POSTGRES_*` vars were pushed: `heroku config --app lpf-claude-pipeline` |
| Webhook returns 503 | DB unreachable — check Stackhero is up + `POSTGRES_SSL=true` is set |
| Deploy times out | `heroku ps:scale web=1 --app lpf-claude-pipeline` to make sure a dyno is allocated |
