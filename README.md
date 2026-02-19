# yt-watch-later-tools

Userscript to help manage your YouTube **Watch Later** playlist.

- Remove videos in reverse add order: **oldest added gets removed first**
- Export your Watch Later list to JSON

Userscript file: `yt-watch-later-tools.user.js`

## Preview

![Main panel placeholder](docs/images/main-panel.png)

## Features

- Bulk remove from Watch Later with control over how many videos to remove
- Forces oldest-first ordering before delete operations
- Export current Watch Later entries to JSON
- Optional run export and deleted-items export for audit/history
- Progress/log panel in-page while operations run

## Install

1. Install a userscript manager (for example: Tampermonkey, Violentmonkey, or Greasemonkey).
2. Install from raw GitHub URL:
   - `https://raw.githubusercontent.com/jadenjsj/yt-watch-later-tools/main/yt-watch-later-tools.user.js`
3. Open your Watch Later page:
   - `https://www.youtube.com/playlist?list=WL`

## Development

Requirements:

- [Bun](https://bun.sh/) `>= 1.1.0`

Optional local env file:

- `cp .env.example .env`

<details>
<summary>Commands, CI, and Release details</summary>

## Commands

- Verify script metadata + syntax:
  - `bun run verify`
- Prepare a version bump in userscript metadata:
  - `bun run release:prepare -- 0.1.0`
- Build release artifact:
  - `bun run release:build`
- Locally smoke-test webhook endpoints (optional):
  - `bun run webhooks:test`

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

Checks run on `push` to `main` and on `pull_request`:
- JS syntax check (Bun parser)
- Userscript metadata/structure validation (`scripts/verify-userscript.mjs`)

## Release automation (GitHub + Greasy Fork + OpenUserJS)

GitHub Actions workflow: `.github/workflows/release.yml`

Trigger: push tag matching `v*.*.*`.

Pipeline steps:
- Validate userscript (`bun run verify`)
- Build `dist/yt-watch-later-tools.user.js`
- Create SHA256 checksum
- Publish GitHub Release with assets
- Optionally trigger Greasy Fork and OpenUserJS sync webhooks

### Required setup for cross-publishing

0. Push this repository to GitHub first. You need the GitHub repo before adding Actions secrets/webhook values.
1. Configure your userscript on Greasy Fork and OpenUserJS to sync from this GitHub raw file:
   - `https://raw.githubusercontent.com/jadenjsj/yt-watch-later-tools/main/yt-watch-later-tools.user.js`
2. In GitHub repository secrets, add webhook URLs if you want immediate sync triggers:
   - `GREASYFORK_WEBHOOK_URL`
   - `OPENUSERJS_WEBHOOK_URL`
3. (Optional) For a local webhook smoke test, set the same values in `.env` and run:
   - `bun run webhooks:test`

If webhook secrets are omitted, release still publishes to GitHub and external services can pull on their normal sync schedule.

## Recommended release flow

1. `bun run release:prepare -- <new-version>`
2. `bun run verify`
3. `git add yt-watch-later-tools.user.js`
4. `git commit -m "release: v<new-version>"`
5. `git tag v<new-version>`
6. `git push && git push --tags`

</details>

## License

MIT
