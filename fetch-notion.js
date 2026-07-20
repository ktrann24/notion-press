#!/usr/bin/env node
/**
 * notion-press — use Notion as a CMS for any static site.
 *
 * Queries a Notion database for published posts, converts each page's
 * blocks to HTML, downloads images locally, and writes one JSON file
 * per post. Pair it with the included GitHub Action to publish on a
 * schedule, or run it locally with --push to sync and deploy in one go.
 */

require('dotenv').config();
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration (see .env.example)
// ---------------------------------------------------------------------------

for (const required of ['NOTION_API_KEY', 'NOTION_DATABASE_ID']) {
  if (!process.env[required]) {
    console.error(`❌ Error: ${required} not found in environment variables`);
    console.error('   Create a .env file — see .env.example');
    process.exit(1);
  }
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const CONTENT_DIR = path.resolve(process.env.CONTENT_DIR || 'content/posts');
const IMAGES_DIR = path.resolve(process.env.IMAGES_DIR || 'public/images/posts');
// URL prefix the site serves IMAGES_DIR under
const IMAGES_PUBLIC_PATH = process.env.IMAGES_PUBLIC_PATH || '/images/posts';

// Notion database property names — override if your schema differs
const TITLE_PROPERTY = process.env.TITLE_PROPERTY || 'Title';
const STATUS_PROPERTY = process.env.STATUS_PROPERTY || 'Status';
const STATUS_PUBLISHED = process.env.STATUS_PUBLISHED || 'Published';
const DATE_PROPERTY = process.env.DATE_PROPERTY || 'Published Date';
const TAGS_PROPERTY = process.env.TAGS_PROPERTY || 'Tags';

const MAX_REDIRECTS = 5;

fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(CONTENT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// For interpolation into HTML attribute values (always double-quoted here)
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// Only allow http(s), relative, and anchor URLs into href/src attributes
function safeUrl(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (/^(https?:\/\/|\/|#|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  return '';
}

function plainText(richTextArray) {
  return (richTextArray || []).map((t) => t.plain_text).join('');
}

// ---------------------------------------------------------------------------
// Image handling
// ---------------------------------------------------------------------------

// Download an image and save it locally so posts don't depend on Notion's
// expiring S3 URLs. Filenames hash the URL path (stable across syncs, since
// only the signed query params change).
async function downloadImage(imageUrl, slug, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error('Too many redirects'));
      return;
    }

    const urlPath = imageUrl.split('?')[0];
    const urlHash = crypto.createHash('md5').update(urlPath).digest('hex').slice(0, 12);

    let ext = path.extname(urlPath).toLowerCase() || '.png';
    if (ext.length > 5) ext = '.png';

    const filename = `${slug}-${urlHash}${ext}`;
    const filepath = path.join(IMAGES_DIR, filename);
    const relativePath = `${IMAGES_PUBLIC_PATH}/${filename}`;

    if (fs.existsSync(filepath)) {
      resolve({ path: relativePath, skipped: true });
      return;
    }

    https
      .get(imageUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          response.resume(); // discard body
          downloadImage(response.headers.location, slug, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download image: ${response.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(filepath);
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve({ path: relativePath, skipped: false });
        });

        file.on('error', (err) => {
          fs.unlink(filepath, () => {});
          reject(err);
        });
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Notion fetching
// ---------------------------------------------------------------------------

// Fetch all published posts (paginated)
async function fetchPosts() {
  const pages = [];
  let cursor = undefined;

  while (true) {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      filter: {
        property: STATUS_PROPERTY,
        select: { equals: STATUS_PUBLISHED }
      },
      sorts: [{ property: DATE_PROPERTY, direction: 'descending' }]
    });

    pages.push(...response.results);

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  return pages;
}

// Fetch all child blocks of a page or block (paginated)
async function fetchBlockChildren(blockId) {
  const blocks = [];
  let cursor = undefined;

  while (true) {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor
    });

    blocks.push(...response.results);

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Block → HTML conversion
// ---------------------------------------------------------------------------

async function blocksToHtml(blocks, slug) {
  const htmlParts = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    let html = '';

    switch (block.type) {
      case 'paragraph': {
        const text = richTextToHtml(block.paragraph.rich_text)
          .replace(/^(<br>)+|(<br>)+$/g, ''); // Trim leading/trailing <br> tags
        const paragraphHtml = text ? `<p>${text}</p>` : '';

        // Notion "Turn into toggle" can apply to paragraphs, which then
        // carry children that must be rendered too.
        if (block.has_children) {
          const children = await fetchBlockChildren(block.id);
          const childrenHtml = await blocksToHtml(children, slug);
          html = paragraphHtml ? `${paragraphHtml}\n${childrenHtml}` : childrenHtml;
        } else {
          html = paragraphHtml;
        }
        break;
      }

      case 'heading_1':
      case 'heading_2':
      case 'heading_3': {
        const level = block.type.slice(-1);
        html = `<h${level}>${richTextToHtml(block[block.type].rich_text)}</h${level}>`;

        // Toggleable headings come through as heading_* with children.
        if (block.has_children) {
          const children = await fetchBlockChildren(block.id);
          const childrenHtml = await blocksToHtml(children, slug);
          html = `${html}\n${childrenHtml}`;
        }
        break;
      }

      case 'bulleted_list_item':
      case 'numbered_list_item': {
        // Collect consecutive list items and wrap them in <ul>/<ol>
        const listType = block.type;
        const tag = listType === 'bulleted_list_item' ? 'ul' : 'ol';
        const listItems = [];
        while (i < blocks.length && blocks[i].type === listType) {
          const itemText = richTextToHtml(blocks[i][listType].rich_text);
          let itemHtml = `<li>${itemText}`;
          if (blocks[i].has_children) {
            const children = await fetchBlockChildren(blocks[i].id);
            const childrenHtml = await blocksToHtml(children, slug);
            itemHtml += `\n${childrenHtml}`;
          }
          itemHtml += '</li>';
          listItems.push(itemHtml);
          i++;
        }
        i--; // Adjust since the outer loop will increment
        html = `<${tag}>\n${listItems.join('\n')}\n</${tag}>`;
        break;
      }

      case 'quote': {
        let quoteHtml = richTextToHtml(block.quote.rich_text);
        if (block.has_children) {
          const children = await fetchBlockChildren(block.id);
          const childrenHtml = await blocksToHtml(children, slug);
          quoteHtml += `\n${childrenHtml}`;
        }
        html = `<blockquote>${quoteHtml}</blockquote>`;
        break;
      }

      case 'code': {
        const language = escapeAttr(block.code.language || 'plaintext');
        const escapedCode = escapeHtml(plainText(block.code.rich_text));
        const codeCaption = block.code.caption?.length
          ? `<figcaption class="code-caption">${richTextToHtml(block.code.caption)}</figcaption>`
          : '';
        html = `<figure class="code-block"><pre><code class="language-${language}">${escapedCode}</code></pre>${codeCaption}</figure>`;
        break;
      }

      case 'divider':
        html = '<hr>';
        break;

      case 'image': {
        const imageUrl = block.image.type === 'external'
          ? block.image.external.url
          : block.image.file.url;
        const captionHtml = block.image.caption?.length
          ? richTextToHtml(block.image.caption)
          : '';
        const altText = escapeAttr(plainText(block.image.caption));

        try {
          const result = await downloadImage(imageUrl, slug);
          const localPath = escapeAttr(result.path);
          html = `<figure><img src="${localPath}" alt="${altText}" loading="lazy"><figcaption>${captionHtml}</figcaption></figure>`;
          console.log(`    📷 ${result.skipped ? 'Image exists' : 'Downloaded'}: ${result.path}`);
        } catch (err) {
          console.warn(`    ⚠️  Failed to download image: ${err.message}`);
          // Fall back to the original (expiring) URL
          html = `<figure><img src="${escapeAttr(safeUrl(imageUrl))}" alt="${altText}" loading="lazy"><figcaption>${captionHtml}</figcaption></figure>`;
        }
        break;
      }

      case 'callout': {
        let calloutIconHtml = '';
        if (block.callout.icon?.emoji) {
          calloutIconHtml = `<span class="callout-icon">${escapeHtml(block.callout.icon.emoji)}</span>`;
        } else if (block.callout.icon?.external?.url) {
          calloutIconHtml = `<img class="callout-icon" src="${escapeAttr(safeUrl(block.callout.icon.external.url))}" alt="" loading="lazy">`;
        }

        let calloutContent = richTextToHtml(block.callout.rich_text);
        const calloutColor = escapeAttr(block.callout.color || 'default');
        if (block.has_children) {
          const children = await fetchBlockChildren(block.id);
          const childrenHtml = await blocksToHtml(children, slug);
          calloutContent += `\n${childrenHtml}`;
        }
        html = `<div class="callout callout-${calloutColor}">${calloutIconHtml}<div class="callout-content">${calloutContent}</div></div>`;
        break;
      }

      case 'to_do': {
        const todoChecked = block.to_do.checked;
        let todoContent = richTextToHtml(block.to_do.rich_text);
        if (block.has_children) {
          const children = await fetchBlockChildren(block.id);
          const childrenHtml = await blocksToHtml(children, slug);
          todoContent += `\n<div class="todo-children">${childrenHtml}</div>`;
        }
        html = `<div class="todo-item"><input type="checkbox" ${todoChecked ? 'checked' : ''} disabled><span class="${todoChecked ? 'todo-checked' : ''}">${todoContent}</span></div>`;
        break;
      }

      case 'bookmark': {
        const bookmarkUrl = safeUrl(block.bookmark.url);
        const bookmarkCaption = block.bookmark.caption?.length
          ? richTextToHtml(block.bookmark.caption)
          : escapeHtml(bookmarkUrl);
        html = `<a href="${escapeAttr(bookmarkUrl)}" class="bookmark-link" target="_blank" rel="noopener noreferrer">${bookmarkCaption}</a>`;
        break;
      }

      case 'link_preview': {
        const previewUrl = safeUrl(block.link_preview.url);
        html = `<a href="${escapeAttr(previewUrl)}" class="link-preview" target="_blank" rel="noopener noreferrer">${escapeHtml(previewUrl)}</a>`;
        break;
      }

      case 'video': {
        const videoUrl = block.video.type === 'external'
          ? block.video.external.url
          : block.video.file.url;
        if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
          const videoId = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/)?.[1];
          if (videoId) {
            html = `<div class="video-embed"><iframe src="https://www.youtube.com/embed/${escapeAttr(videoId)}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
          }
        } else if (videoUrl.includes('vimeo.com')) {
          const vimeoId = videoUrl.match(/vimeo\.com\/(\d+)/)?.[1];
          if (vimeoId) {
            html = `<div class="video-embed"><iframe src="https://player.vimeo.com/video/${vimeoId}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
          }
        } else {
          html = `<video controls><source src="${escapeAttr(safeUrl(videoUrl))}"></video>`;
        }
        break;
      }

      case 'audio': {
        const audioUrl = block.audio.type === 'external'
          ? block.audio.external.url
          : block.audio.file.url;
        html = `<audio controls class="audio-player"><source src="${escapeAttr(safeUrl(audioUrl))}">Your browser does not support audio.</audio>`;
        break;
      }

      case 'file': {
        const fileUrl = block.file.type === 'external'
          ? block.file.external.url
          : block.file.file.url;
        const fileName = block.file.name || fileUrl.split('/').pop()?.split('?')[0] || 'Download';
        const fileCaption = block.file.caption?.length
          ? richTextToHtml(block.file.caption)
          : escapeHtml(fileName);
        html = `<a href="${escapeAttr(safeUrl(fileUrl))}" class="file-download" target="_blank" rel="noopener noreferrer" download>📎 ${fileCaption}</a>`;
        break;
      }

      case 'pdf': {
        const pdfUrl = block.pdf.type === 'external'
          ? block.pdf.external.url
          : block.pdf.file.url;
        const pdfCaption = block.pdf.caption?.length
          ? richTextToHtml(block.pdf.caption)
          : 'PDF Document';
        html = `<figure class="pdf-embed"><iframe src="${escapeAttr(safeUrl(pdfUrl))}" loading="lazy"></iframe><figcaption>${pdfCaption}</figcaption></figure>`;
        break;
      }

      case 'embed': {
        const embedUrl = safeUrl(block.embed.url);
        html = `<div class="embed-container"><iframe src="${escapeAttr(embedUrl)}" frameborder="0" loading="lazy"></iframe></div>`;
        break;
      }

      case 'toggle': {
        const toggleText = richTextToHtml(block.toggle.rich_text);
        let toggleContent = '';
        if (block.has_children) {
          const children = await fetchBlockChildren(block.id);
          toggleContent = await blocksToHtml(children, slug);
        }
        html = `<details class="toggle"><summary>${toggleText}</summary><div class="toggle-content">${toggleContent}</div></details>`;
        break;
      }

      case 'table': {
        if (block.has_children) {
          const rows = await fetchBlockChildren(block.id);
          const hasColumnHeader = block.table.has_column_header;
          const hasRowHeader = block.table.has_row_header;

          let tableHtml = '<table class="notion-table">';
          rows.forEach((row, rowIndex) => {
            if (row.type === 'table_row') {
              const isHeaderRow = hasColumnHeader && rowIndex === 0;
              tableHtml += '<tr>';
              row.table_row.cells.forEach((cell, cellIndex) => {
                const isHeaderCell = hasRowHeader && cellIndex === 0;
                const tag = isHeaderRow || isHeaderCell ? 'th' : 'td';
                const cellContent = cell.map((rt) => richTextToHtml([rt])).join('');
                tableHtml += `<${tag}>${cellContent}</${tag}>`;
              });
              tableHtml += '</tr>';
            }
          });
          tableHtml += '</table>';
          html = tableHtml;
        }
        break;
      }

      case 'column_list': {
        if (block.has_children) {
          const columns = await fetchBlockChildren(block.id);
          let columnsHtml = '<div class="columns">';
          for (const column of columns) {
            if (column.type === 'column' && column.has_children) {
              const columnBlocks = await fetchBlockChildren(column.id);
              const columnContent = await blocksToHtml(columnBlocks, slug);
              columnsHtml += `<div class="column">${columnContent}</div>`;
            }
          }
          columnsHtml += '</div>';
          html = columnsHtml;
        }
        break;
      }

      case 'synced_block': {
        // Synced blocks either hold original content or reference another block
        if (block.synced_block.synced_from) {
          const originalBlockId = block.synced_block.synced_from.block_id;
          try {
            const children = await fetchBlockChildren(originalBlockId);
            html = await blocksToHtml(children, slug);
          } catch (err) {
            console.warn(`    ⚠️  Failed to fetch synced block: ${err.message}`);
          }
        } else if (block.has_children) {
          const children = await fetchBlockChildren(block.id);
          html = await blocksToHtml(children, slug);
        }
        break;
      }

      case 'equation': {
        const expression = block.equation.expression;
        html = `<div class="equation" data-equation="${escapeAttr(expression)}">\\[${escapeHtml(expression)}\\]</div>`;
        break;
      }

      // UI/navigation elements with no meaning outside Notion
      case 'table_of_contents':
      case 'breadcrumb':
      case 'child_page':
      case 'child_database':
        html = '';
        break;

      default:
        console.log(`    ⚠️  Unsupported block type: ${block.type}`);
        html = '';
    }

    if (html) {
      htmlParts.push(html);
    }
    i++;
  }

  return htmlParts.join('\n\n');
}

// Convert Notion rich text to HTML
function richTextToHtml(richTextArray) {
  if (!richTextArray || richTextArray.length === 0) return '';

  return richTextArray
    .map((text) => {
      let content;

      if (text.type === 'equation') {
        const expr = text.equation.expression;
        return `<span class="inline-equation" data-equation="${escapeAttr(expr)}">\\(${escapeHtml(expr)}\\)</span>`;
      } else if (text.type === 'mention') {
        if (text.mention.type === 'date') {
          const date = text.mention.date;
          const format = { year: 'numeric', month: 'long', day: 'numeric' };
          const startDate = new Date(date.start).toLocaleDateString('en-US', format);
          content = date.end
            ? `${startDate} → ${new Date(date.end).toLocaleDateString('en-US', format)}`
            : startDate;
          return `<span class="mention mention-date">${escapeHtml(content)}</span>`;
        } else if (text.mention.type === 'user') {
          return `<span class="mention mention-user">@${escapeHtml(text.plain_text)}</span>`;
        } else if (text.mention.type === 'page' || text.mention.type === 'database') {
          return `<span class="mention mention-page">${escapeHtml(text.plain_text)}</span>`;
        }
        return escapeHtml(text.plain_text);
      }

      // Regular text — escape HTML and convert newlines to <br>
      content = escapeHtml(text.plain_text).replace(/\n/g, '<br>');

      if (text.annotations) {
        if (text.annotations.bold) content = `<strong>${content}</strong>`;
        if (text.annotations.italic) content = `<em>${content}</em>`;
        if (text.annotations.strikethrough) content = `<del>${content}</del>`;
        if (text.annotations.underline) content = `<u>${content}</u>`;
        if (text.annotations.code) content = `<code>${content}</code>`;

        const color = text.annotations.color;
        if (color && color !== 'default') {
          content = `<span class="text-${escapeAttr(color)}">${content}</span>`;
        }
      }

      if (text.href) {
        const href = safeUrl(text.href);
        if (href) {
          const isExternal = /^https?:\/\//i.test(href);
          const linkAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
          content = `<a href="${escapeAttr(href)}"${linkAttrs}>${content}</a>`;
        }
      }

      return content;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Post metadata
// ---------------------------------------------------------------------------

function getPageProperties(page) {
  const title = page.properties[TITLE_PROPERTY]?.title?.[0]?.plain_text || 'Untitled';
  const date = page.properties[DATE_PROPERTY]?.date?.start || new Date().toISOString().split('T')[0];
  const slug = slugify(title);
  const tags = page.properties[TAGS_PROPERTY]?.multi_select?.map((t) => t.name.toLowerCase()) || [];

  return { title, date, slug, tags };
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'untitled'
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🔄 Fetching posts from Notion...');

  try {
    const pages = await fetchPosts();
    console.log(`📝 Found ${pages.length} published posts`);

    const posts = [];
    const generatedFiles = new Set();

    for (const page of pages) {
      const { title, date, slug, tags } = getPageProperties(page);
      console.log(`  → Processing: ${title}`);

      const blocks = await fetchBlockChildren(page.id);
      const htmlContent = await blocksToHtml(blocks, slug);

      const filename = `${slug}.json`;
      fs.writeFileSync(
        path.join(CONTENT_DIR, filename),
        JSON.stringify({ title, date, tags, html: htmlContent }, null, 2)
      );

      generatedFiles.add(filename);
      posts.push({ title, date, slug });
    }

    // Remove files for posts that were unpublished or renamed
    const existingFiles = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json'));
    let deletedCount = 0;
    for (const file of existingFiles) {
      if (!generatedFiles.has(file)) {
        fs.unlinkSync(path.join(CONTENT_DIR, file));
        console.log(`  🗑️  Deleted orphaned file: ${file}`);
        deletedCount++;
      }
    }

    console.log('✅ Successfully synced all posts!');
    console.log(`   ${posts.length} posts written to ${path.relative(process.cwd(), CONTENT_DIR)}/`);
    if (deletedCount > 0) {
      console.log(`   ${deletedCount} orphaned file(s) removed`);
    }

    if (process.argv.includes('--push')) {
      pushToProduction();
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Commit and push synced content (used by `npm run deploy` locally)
function pushToProduction() {
  console.log('\n🚀 Pushing to production...');

  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });

    if (!status.trim()) {
      console.log('   No changes to push.');
      return;
    }

    const contentDir = path.relative(process.cwd(), CONTENT_DIR);
    const imagesDir = path.relative(process.cwd(), IMAGES_DIR);
    execSync(`git add ${JSON.stringify(contentDir)} ${JSON.stringify(imagesDir)}`, { stdio: 'inherit' });

    const date = new Date().toISOString().split('T')[0];
    execSync(`git commit -m "Sync content from Notion - ${date}"`, { stdio: 'inherit' });

    // Rebase onto the remote first to avoid conflicts with scheduled syncs
    console.log('   Pulling latest changes...');
    execSync('git pull --rebase', { stdio: 'inherit' });

    execSync('git push', { stdio: 'inherit' });

    console.log('✅ Successfully pushed to production!');
  } catch (error) {
    console.error('❌ Failed to push:', error.message);
    process.exit(1);
  }
}

main();
