# Verification

- Read `CONTEXT.md` and the startup verification section in `README.md` before changing the app.
- For startup/player bugs, run `pnpm test:startup` before editing to capture the failure, then again after the fix.
- Before handing off app changes, run `pnpm test:startup` and inspect the generated `page.png`. A build alone is not runtime verification.
- Report failing checks and missing platform coverage explicitly. Never mark a consent screen, hidden window, unfinished preload, or unavailable network as a successful startup.
- Use the runner's fresh profile; never reuse a user's installed profile, credentials, or settings. Do not start a development server for this check.
- See `README.md` for prerequisites, artifacts and coverage limits. Local verification never authorizes publication or deployment.
