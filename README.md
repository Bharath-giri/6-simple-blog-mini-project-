# Simple Blog — Performance & UX Upgrade

## Run it

```bash
npm install
npm start
```

This runs in development mode by default, which is what you want for
`http://localhost` — see the production note at the bottom before deploying
anywhere real.

Demo login: `admin` / `admin123`

## Editing posts (owner-only)
- Each post records its `owner` (the logged-in username) when created.
- `PUT /api/posts/:id` updates a post; the server returns `401` if you are
  not logged in and `403` if you are not the post's owner. Only `title`,
  `author` and `content` can change (`owner`, `id`, `createdAt` cannot), and
  an `updatedAt` timestamp is stored.
- The **Edit** button appears on the home page cards and on the post page
  only for the post's owner. It opens `new-post.html?edit=<id>`, which
  reuses the new-post form prefilled with the existing content.
- Posts created before `owner` existed have no owner, so nobody can edit
  them (same rule as delete).

## What changed and why

### Performance (server)
- **Non-blocking file I/O.** The original app called `fs.readFileSync` /
  `fs.writeFileSync` on `users.json` on *every* register/login request. That
  blocks Node's single thread, so under load every request — even unrelated
  ones — stalled while disk I/O completed. Users and posts are now loaded
  into memory once at startup; reads are pure memory access, and writes
  persist to disk asynchronously in the background.
- **Posts are now persisted to `posts.json`.** Previously posts lived only
  in a `let posts = [...]` array, so a server restart silently deleted
  everything anyone had published — a data-loss bug as much as a
  performance one.
- **gzip/brotli compression** (`compression`) — typically shrinks HTML/CSS/
  JS/JSON responses 60–80%, directly cutting load time on slower
  connections.
- **Pagination + server-side search** on `GET /api/posts` (`?page=`,
  `?limit=`, `?q=`) so the endpoint stays fast and the payload stays small
  as the number of posts grows, instead of always returning the entire
  dataset.
- **Static asset caching** (ETags + `Cache-Control` in production) so
  returning visitors don't re-download unchanged CSS/JS.
- **Rate limiting** on `/api/login` and `/api/register` to blunt
  brute-force attempts without affecting the rest of the app.
- **Security headers** via `helmet`, secure/`SameSite` cookies in
  production, and a centralized error handler.

### User experience (frontend)
- **Skeleton loaders** instead of a blank page while posts/post content
  load.
- **Toasts** instead of blocking `alert()`s, and a **custom confirm
  dialog** instead of the native `confirm()` for deleting a post.
- **Search box** (debounced) and a **"Load more" button** for browsing
  posts instead of one long unpaginated list.
- **Button loading states** (spinner + disabled) on every form so
  double-submits are impossible and the user gets instant feedback.
- **Responsive mobile nav** (hamburger menu) — the original nav just
  overflowed on narrow screens.
- **Dark mode** that follows the OS/browser preference (`prefers-color-
  scheme`), via CSS variables.
- **Password show/hide toggles**, post dates, and reading-time estimates.
- Small accessibility fixes: focus-visible outlines, `aria-live` regions
  for async content and form errors, proper `autocomplete` attributes.
- Fixed a pre-existing bug where the shipped `users.json` was an empty
  array, so the demo credentials shown on the login page could never
  actually work out of the box.

## Notes for production use
This still uses Express's default in-memory session store, which is fine
for local use/demos but leaks memory and won't work across multiple server
instances — swap in a store like `connect-redis` before deploying for real.

Also set a real `SESSION_SECRET` environment variable, and only set
`NODE_ENV=production` once the site is actually served over **HTTPS** —
that flag makes session cookies `secure`-only, and browsers silently
refuse to send secure cookies over plain HTTP, which would break login on
`http://localhost` or any non-HTTPS deployment. How to set it depends on
your shell:
- macOS/Linux: `NODE_ENV=production npm start`
- Windows PowerShell: `$env:NODE_ENV="production"; npm start`
- Windows cmd.exe: `set NODE_ENV=production&&npm start`
