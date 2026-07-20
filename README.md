# notion-press

Use Notion as a CMS for any static site.

Write and publish in Notion. A single script (plus an optional GitHub Action) syncs your published posts into your repo as pre-rendered HTML, with images downloaded locally. Your site rebuilds statically — no runtime Notion dependency, no third-party service, no expiring image URLs.

## How it works

1. You keep a Notion database of posts with a `Status` property.
2. `fetch-notion.js` queries the database for posts where `Status = Published`.
3. Each page's blocks are converted to clean HTML. Images are downloaded into your repo (Notion's file URLs expire after an hour — hotlinking them breaks).
4. One JSON file per post is written to `content/posts/`:

```json
{
  "title": "My Post",
  "date": "2026-07-17",
  "tags": ["personal"],
  "html": "<p>...</p>"
}
```

5. The included GitHub Action runs this nightly and commits any changes, which triggers your host's normal deploy (Netlify, Vercel, Cloudflare Pages, GitHub Pages...).

Your static site generator just reads the JSON files. Works with Astro, Eleventy, Next.js, Hugo (with a small adapter), or plain HTML templates — anything that can read a JSON file at build time.

## Setup

> **Fastest start:** click **Use this template** on GitHub to create your own repo with everything in place, then follow the steps below. Or copy `fetch-notion.js` and `.github/workflows/sync.yml` into an existing site repo.

### 1. Create a Notion integration

- Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and create an **internal** integration.
- Copy the secret (starts with `ntn_`).

### 2. Create your posts database

A Notion database with these properties (names are configurable via env vars):

| Property         | Type         | Notes                                          |
| ---------------- | ------------ | ---------------------------------------------- |
| `Title`          | Title        | Used for the post title and URL slug           |
| `Status`         | Select       | Posts sync when set to `Published`             |
| `Published Date` | Date         | Used for sorting and the post date             |
| `Tags`           | Multi-select | Optional                                       |

### 3. Share the database with your integration

Open the database in Notion → **⋯** menu → **Connections** → add your integration.

> **Tip:** if you later move the database to a different parent page, the connection can be silently lost and syncs will start failing with `object_not_found`. Re-add the connection (or connect a stable parent page instead).

### 4. Configure environment

```bash
cp .env.example .env
# fill in NOTION_API_KEY and NOTION_DATABASE_ID
```

The database ID is the 32-character hex string in your database URL: `notion.so/workspace/<DATABASE_ID>?v=...`

### 5. Run it

```bash
npm install
npm run fetch          # sync posts into content/posts/
npm run deploy         # sync + commit + push in one step
```

### 6. Automate with GitHub Actions

The included workflow (`.github/workflows/sync.yml`) runs nightly and can be triggered manually from the Actions tab. Add two repository secrets under **Settings → Secrets and variables → Actions**:

- `NOTION_API_KEY`
- `NOTION_DATABASE_ID`

If your repo restricts workflow permissions, the workflow already requests `contents: write` so it can commit synced posts.

## Configuration

All optional, via environment variables (see `.env.example`):

| Variable             | Default              | Purpose                                    |
| -------------------- | -------------------- | ------------------------------------------ |
| `CONTENT_DIR`        | `content/posts`      | Where post JSON files are written          |
| `IMAGES_DIR`         | `public/images/posts`| Where images are downloaded                |
| `IMAGES_PUBLIC_PATH` | `/images/posts`      | URL prefix your site serves images under   |
| `TITLE_PROPERTY`     | `Title`              | Notion property names, if yours differ     |
| `STATUS_PROPERTY`    | `Status`             |                                            |
| `STATUS_PUBLISHED`   | `Published`          |                                            |
| `DATE_PROPERTY`      | `Published Date`     |                                            |
| `TAGS_PROPERTY`      | `Tags`               |                                            |

If you change `CONTENT_DIR`/`IMAGES_DIR`, update the paths in the workflow's commit step too.

## Supported blocks

Paragraphs, headings (incl. toggleable), bulleted/numbered lists (nested), quotes, code blocks with language + caption, dividers, images (downloaded locally), callouts, to-dos, toggles, tables, columns, synced blocks, bookmarks, link previews, YouTube/Vimeo/file video, audio, file attachments, PDFs, embeds, equations (KaTeX/MathJax-ready markup), and rich text with bold/italic/strikethrough/underline/code/color/links/mentions.

Unsupported block types are skipped with a console warning.

## Notes & limitations

- GitHub **disables scheduled workflows after 60 days without repo activity**. An active blog keeps it alive via sync commits; if yours goes quiet, GitHub emails you before disabling and you can re-enable from the Actions tab.
- Commits made with the workflow's default `GITHUB_TOKEN` **do not trigger other workflows**. Hosts with their own GitHub integration (Netlify, Vercel, Cloudflare Pages) deploy fine, but if you deploy via GitHub Actions (e.g. GitHub Pages), have the sync workflow push with a personal access token or deploy key instead.
- Unpublishing or renaming a post in Notion deletes its orphaned JSON file on the next sync. Renaming changes the slug (and therefore the URL).
- Two posts with the same title will collide on the same slug — last one wins.
- Video/audio/file/PDF blocks that use Notion-hosted files keep Notion's expiring URLs; only images are downloaded locally. Host those files externally or extend `downloadImage` to cover them.
- Uses `@notionhq/client` v2. Migrating to the v5 SDK (data sources API) is on the roadmap.

## License

[MIT](LICENSE)
