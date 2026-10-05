const express = require("express");
const session = require("express-session");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const USERS_FILE = path.join(__dirname, "users.json");
const POSTS_FILE = path.join(__dirname, "posts.json");

// ---------------------------------------------------------------------------
// In-memory state, backed by the JSON files on disk.
//
// The original app read and wrote users.json synchronously on *every*
// request (fs.readFileSync / fs.writeFileSync). That blocks Node's single
// thread, so under any real load every other request — including ones that
// have nothing to do with auth — stalls while disk I/O completes.
//
// Instead we load both files into memory once at startup and keep them
// there. Reads are then pure memory access (fast, non-blocking). Writes
// update memory immediately (so the response is always consistent) and
// persist to disk asynchronously in the background.
// ---------------------------------------------------------------------------

let users = [];
let posts = [];
let nextPostId = 1;

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    const [salt, storedHash] = storedPassword.split(":");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    const storedBuf = Buffer.from(storedHash, "hex");
    const hashBuf = Buffer.from(hash, "hex");
    return storedBuf.length === hashBuf.length && crypto.timingSafeEqual(hashBuf, storedBuf);
}

// Fire-and-forget persistence. Errors are logged rather than thrown so a
// slow or failing disk never breaks the request/response cycle.
function persistUsers() {
    fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2)).catch(err =>
        console.error("Failed to persist users.json:", err)
    );
}

function persistPosts() {
    fs.writeFile(POSTS_FILE, JSON.stringify(posts, null, 2)).catch(err =>
        console.error("Failed to persist posts.json:", err)
    );
}

async function loadInitialData() {
    // Users. Note: we seed the demo admin account whenever the file is
    // missing *or* empty — the original only checked for a missing file,
    // so a shipped-but-empty users.json meant the "demo credentials" shown
    // on the login page could never actually work out of the box.
    try {
        users = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
    } catch {
        users = [];
    }
    if (users.length === 0) {
        users = [{ username: "admin", password: hashPassword("admin123") }];
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
    }

    // Posts — previously these lived only in a `let posts = [...]` array,
    // so every server restart silently wiped out anything users had
    // published. That's a real data-loss bug as much as a UX problem, so
    // posts are now persisted the same way users are.
    try {
        posts = JSON.parse(await fs.readFile(POSTS_FILE, "utf8"));
    } catch {
        const now = Date.now();
        posts = [
            {
                id: 1,
                title: "My First Blog",
                author: "Bharath",
                content: "Welcome to my first blog application!",
                createdAt: now - 1000 * 60 * 60 * 24
            },
            {
                id: 2,
                title: "Learning Node.js",
                author: "Bharath",
                content: "Node.js allows us to run JavaScript on the server.",
                createdAt: now
            }
        ];
        await fs.writeFile(POSTS_FILE, JSON.stringify(posts, null, 2));
    }

    nextPostId = posts.reduce((max, p) => Math.max(max, p.id), 0) + 1;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Security headers (CSP, X-Content-Type-Options, etc.). Disable the
// upgrade-insecure-requests / HSTS-only defaults that don't make sense for
// local HTTP development.
app.use(
    helmet({
        contentSecurityPolicy: false
    })
);

// Gzip/brotli-negotiated compression for every response. This is one of
// the highest-leverage, lowest-risk performance wins available: HTML/CSS/JS
// and JSON payloads typically shrink 60-80%, directly cutting time-to-first-
// render on slower connections.
app.use(compression());

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

app.set("trust proxy", 1);

app.use(
    session({
        secret: process.env.SESSION_SECRET || "simple-blog-secret-change-this",
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: NODE_ENV === "production",
            maxAge: 1000 * 60 * 60
        }
    })
);

// Slow down brute-force guessing on auth endpoints without affecting the
// rest of the app.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many attempts. Please try again later." }
});

function requireLogin(req, res, next) {
    if (req.session.loggedIn) next();
    else res.status(401).json({ message: "Please login first" });
}

// Static assets: fingerprint-free files still benefit from a short cache
// window plus ETag-based revalidation, so a returning visitor's browser can
// skip re-downloading CSS/JS on the very next request.
app.use(
    express.static(path.join(__dirname, "public"), {
        etag: true,
        lastModified: true,
        maxAge: NODE_ENV === "production" ? "1h" : 0
    })
);

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post("/api/register", authLimiter, (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ message: "Username must be 3-30 characters." });
    }
    if (password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters." });
    }
    if (password !== confirmPassword) {
        return res.status(400).json({ message: "Passwords do not match." });
    }

    if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ message: "Username already exists." });
    }

    users.push({ username, password: hashPassword(password) });
    persistUsers();

    res.status(201).json({ message: "Registration successful. You can now login." });
});

app.post("/api/login", authLimiter, (req, res) => {
    const { username, password } = req.body;
    const user = users.find(
        u => u.username.toLowerCase() === String(username || "").trim().toLowerCase()
    );

    if (user && verifyPassword(String(password || ""), user.password)) {
        req.session.loggedIn = true;
        req.session.username = user.username;
        return res.json({ message: "Login successful", username: user.username });
    }

    res.status(401).json({ message: "Invalid username or password" });
});

app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out successfully" }));
});

app.get("/api/auth/status", (req, res) => {
    res.json({ loggedIn: !!req.session.loggedIn, username: req.session.username || null });
});

// ---------------------------------------------------------------------------
// Post routes
// ---------------------------------------------------------------------------

// Supports optional search (?q=) and pagination (?page=&limit=) so the
// endpoint stays fast and the payload stays small even as the number of
// posts grows — the original returned the entire dataset on every request
// with no way to page through it.
app.get("/api/posts", (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    let filtered = posts;
    if (q) {
        filtered = posts.filter(
            p =>
                p.title.toLowerCase().includes(q) ||
                p.author.toLowerCase().includes(q) ||
                p.content.toLowerCase().includes(q)
        );
    }

    const sorted = filtered.slice().sort((a, b) => b.createdAt - a.createdAt);
    const start = (page - 1) * limit;
    const pageItems = sorted.slice(start, start + limit);

    res.json({
        posts: pageItems,
        total: sorted.length,
        page,
        totalPages: Math.max(1, Math.ceil(sorted.length / limit)),
        hasMore: start + pageItems.length < sorted.length
    });
});

app.get("/api/posts/:id", (req, res) => {
    const post = posts.find(post => post.id === parseInt(req.params.id, 10));
    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json(post);
});

app.post("/api/posts", requireLogin, (req, res) => {
    const title = String(req.body.title || "").trim();
    const author = String(req.body.author || "").trim();
    const content = String(req.body.content || "").trim();

    if (!title || !author || !content) {
        return res.status(400).json({ message: "Title, author and content are required" });
    }
    if (title.length > 150) {
        return res.status(400).json({ message: "Title must be 150 characters or fewer" });
    }

    // `author` is just a free-text display name and was never tied to the
    // logged-in account, so anyone who was merely logged in could delete
    // *any* post. `owner` records the actual session username at creation
    // time and is what delete-permission checks are based on below.
    const newPost = {
        id: nextPostId++,
        title,
        author,
        owner: req.session.username,
        content,
        createdAt: Date.now()
    };
    posts.push(newPost);
    persistPosts();

    res.status(201).json({ message: "Post created successfully", post: newPost });
});

app.put("/api/posts/:id", requireLogin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const post = posts.find(post => post.id === id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Same ownership rule as delete: enforced on the server, so hiding the
    // Edit button in the UI is a convenience, not the security boundary.
    if (!post.owner || post.owner !== req.session.username) {
        return res.status(403).json({ message: "You can only edit your own posts." });
    }

    const title = String(req.body.title || "").trim();
    const author = String(req.body.author || "").trim();
    const content = String(req.body.content || "").trim();

    if (!title || !author || !content) {
        return res.status(400).json({ message: "Title, author and content are required" });
    }
    if (title.length > 150) {
        return res.status(400).json({ message: "Title must be 150 characters or fewer" });
    }

    // Only whitelisted fields are updated, so a client can't change
    // `owner`, `id` or `createdAt` by adding them to the request body.
    post.title = title;
    post.author = author;
    post.content = content;
    post.updatedAt = Date.now();
    persistPosts();

    res.json({ message: "Post updated successfully", post });
});

app.delete("/api/posts/:id", requireLogin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const post = posts.find(post => post.id === id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Only the account that created the post may delete it. Posts created
    // before `owner` existed have no owner on record, so they can't be
    // attributed to anyone and are treated the same as "not yours".
    if (!post.owner || post.owner !== req.session.username) {
        return res.status(403).json({ message: "You can only delete your own posts." });
    }

    posts = posts.filter(post => post.id !== id);
    persistPosts();
    res.json({ message: "Post deleted successfully" });
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

app.use("/api", (req, res) => res.status(404).json({ message: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ message: "Something went wrong. Please try again." });
});

loadInitialData()
    .then(() => {
        app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
    })
    .catch(err => {
        console.error("Failed to start server:", err);
        process.exit(1);
    });
