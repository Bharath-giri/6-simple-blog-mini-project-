// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function formatDate(timestamp) {
    if (!timestamp) return "";
    return new Date(timestamp).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric"
    });
}

function readingTime(content) {
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 200));
}

// Toasts replace blocking alert()s so a delete/save action gives feedback
// without freezing the page or requiring a click to dismiss.
function ensureToastContainer() {
    let container = document.querySelector(".toast-container");
    if (!container) {
        container = document.createElement("div");
        container.className = "toast-container";
        container.setAttribute("aria-live", "polite");
        document.body.appendChild(container);
    }
    return container;
}

function showToast(message, type = "info", duration = 3200) {
    const container = ensureToastContainer();
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

// A lightweight confirm modal replaces the native confirm() dialog, which
// is jarring, unstyled, and blocks the whole tab while open.
function confirmDialog({ title, message, confirmLabel = "Confirm", danger = true }) {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
                <h3 id="modal-title">${escapeHtml(title)}</h3>
                <p>${escapeHtml(message)}</p>
                <div class="modal-actions">
                    <button type="button" class="cancel-btn" data-action="cancel">Cancel</button>
                    <button type="button" class="${danger ? "delete-btn" : "publish-btn"}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
                </div>
            </div>
        `;

        function close(result) {
            overlay.remove();
            document.removeEventListener("keydown", onKeydown);
            resolve(result);
        }

        function onKeydown(e) {
            if (e.key === "Escape") close(false);
        }

        overlay.addEventListener("click", e => {
            if (e.target === overlay) close(false);
            const action = e.target.dataset && e.target.dataset.action;
            if (action === "cancel") close(false);
            if (action === "confirm") close(true);
        });

        document.addEventListener("keydown", onKeydown);
        document.body.appendChild(overlay);
        overlay.querySelector('[data-action="confirm"]').focus();
    });
}

// Toggle a submit button between idle and in-flight states so double
// submissions are impossible and the user gets immediate feedback that
// something is happening.
function setButtonLoading(button, loading, loadingText = "Please wait…") {
    if (!button) return;
    if (loading) {
        button.dataset.originalText = button.innerHTML;
        button.innerHTML = `<span class="spinner"></span> ${loadingText}`;
        button.disabled = true;
    } else {
        if (button.dataset.originalText) button.innerHTML = button.dataset.originalText;
        button.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Navigation (auth-aware + mobile menu)
// ---------------------------------------------------------------------------

async function getAuthStatus() {
    try {
        const response = await fetch("/api/auth/status");
        return await response.json();
    } catch {
        return { loggedIn: false, username: null };
    }
}

async function updateNavigation() {
    const status = await getAuthStatus();
    const loginLink = document.getElementById("login-link");
    const registerLink = document.getElementById("register-link");
    const logoutBtn = document.getElementById("logout-btn");

    if (loginLink && logoutBtn) {
        loginLink.classList.toggle("hidden", status.loggedIn);
        if (registerLink) registerLink.classList.toggle("hidden", status.loggedIn);
        logoutBtn.classList.toggle("hidden", !status.loggedIn);
    }

    return status;
}

const menuToggle = document.getElementById("menu-toggle");
const siteNav = document.getElementById("site-nav");

if (menuToggle && siteNav) {
    menuToggle.addEventListener("click", () => {
        const isOpen = siteNav.classList.toggle("open");
        menuToggle.setAttribute("aria-expanded", String(isOpen));
    });
}

const logoutBtn = document.getElementById("logout-btn");

if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST" });
        window.location.href = "index.html";
    });
}

// ---------------------------------------------------------------------------
// Post list (home page): search, pagination, skeleton loading
// ---------------------------------------------------------------------------

const postsState = { query: "", page: 1, limit: 6, loggedIn: false };

function renderSkeletons(container, count = 3) {
    container.innerHTML = Array.from({ length: count })
        .map(
            () => `
        <div class="skeleton-card">
            <div class="skeleton-line title"></div>
            <div class="skeleton-line short"></div>
            <div class="skeleton-line"></div>
            <div class="skeleton-line" style="width: 80%"></div>
        </div>`
        )
        .join("");
}

function renderPostCard(post, currentUsername) {
    const preview = post.content.length > 180 ? post.content.substring(0, 180) + "…" : post.content;
    // Only the post's own creator (matched by session username, not the
    // free-text "author" display name) gets a delete button — other logged
    // in users shouldn't be able to delete someone else's post.
    const canDelete = !!currentUsername && post.owner === currentUsername;
    const canEdit = canDelete;
    return `
        <article class="post-card">
            <h2>${escapeHtml(post.title)}</h2>
            <p class="author">
                By ${escapeHtml(post.author)}
                <span class="meta-dot">·</span>${formatDate(post.createdAt)}
                <span class="meta-dot">·</span>${readingTime(post.content)} min read${post.updatedAt ? `<span class="meta-dot">·</span>edited` : ""}
            </p>
            <p>${escapeHtml(preview)}</p>
            <div class="post-actions">
                <a href="post.html?id=${post.id}" class="read-btn">Read More</a>
                ${canEdit ? `<a href="new-post.html?edit=${post.id}" class="edit-btn">Edit</a>` : ""}
                ${canDelete ? `<button class="delete-btn" data-delete-id="${post.id}">Delete</button>` : ""}
            </div>
        </article>
    `;
}

async function loadPosts({ append = false } = {}) {
    const container = document.getElementById("posts-container");
    if (!container) return;

    const loadMoreWrap = document.getElementById("load-more-wrap");
    if (!append) {
        renderSkeletons(container);
        if (loadMoreWrap) loadMoreWrap.innerHTML = "";
    }

    try {
        const auth = await updateNavigation();
        postsState.loggedIn = auth.loggedIn;

        const params = new URLSearchParams({
            page: postsState.page,
            limit: postsState.limit
        });
        if (postsState.query) params.set("q", postsState.query);

        const response = await fetch(`/api/posts?${params.toString()}`);
        const data = await response.json();

        if (!append) container.innerHTML = "";

        if (data.posts.length === 0 && postsState.page === 1) {
            container.innerHTML = `<div class="empty">${
                postsState.query ? "No posts match your search." : "No blog posts yet. Create your first post!"
            }</div>`;
        } else {
            container.insertAdjacentHTML("beforeend", data.posts.map(p => renderPostCard(p, auth.username)).join(""));
        }

        if (loadMoreWrap) {
            loadMoreWrap.innerHTML = data.hasMore
                ? `<button class="load-more-btn" id="load-more-btn">Load more posts</button>`
                : "";
            const loadMoreBtn = document.getElementById("load-more-btn");
            if (loadMoreBtn) {
                loadMoreBtn.addEventListener("click", () => {
                    postsState.page += 1;
                    loadPosts({ append: true });
                });
            }
        }
    } catch (error) {
        container.innerHTML = '<div class="error">Unable to load posts. Please check your connection and try again.</div>';
    }
}

// Event delegation for delete buttons avoids inline onclick handlers
// (cleaner CSP posture) and works for posts added after the initial render.
document.addEventListener("click", async event => {
    const btn = event.target.closest("[data-delete-id]");
    if (!btn) return;

    const id = btn.dataset.deleteId;
    const confirmed = await confirmDialog({
        title: "Delete this post?",
        message: "This action can't be undone.",
        confirmLabel: "Delete"
    });
    if (!confirmed) return;

    btn.disabled = true;
    try {
        const response = await fetch(`/api/posts/${id}`, { method: "DELETE" });
        const data = await response.json();

        if (response.status === 401) {
            window.location.href = "login.html";
            return;
        }

        showToast(data.message, response.ok ? "success" : "error");
        if (response.ok) {
            postsState.page = 1;
            loadPosts();
        } else {
            btn.disabled = false;
        }
    } catch {
        showToast("Unable to delete the post.", "error");
        btn.disabled = false;
    }
});

const searchInput = document.getElementById("search-input");
if (searchInput) {
    searchInput.addEventListener(
        "input",
        debounce(() => {
            postsState.query = searchInput.value.trim();
            postsState.page = 1;
            loadPosts();
        }, 300)
    );
}

// ---------------------------------------------------------------------------
// New post form
// ---------------------------------------------------------------------------

const form = document.getElementById("post-form");

if (form) {
    const submitBtn = form.querySelector('button[type="submit"]');
    const messageEl = document.getElementById("post-message");

    // new-post.html doubles as the edit page: ?edit=<id> switches it to
    // edit mode, prefills the fields, and submits with PUT instead of POST.
    const editId = new URLSearchParams(window.location.search).get("edit");
    const isEdit = !!editId;

    async function initEditMode() {
        const auth = await getAuthStatus();
        if (!auth.loggedIn) {
            window.location.href = "login.html";
            return;
        }

        const heading = document.getElementById("form-heading");
        if (heading) heading.textContent = "Edit Post";
        document.title = "Edit Post - Simple Blog";
        submitBtn.textContent = "Save Changes";
        form.querySelectorAll("input, textarea, button[type=submit]").forEach(el => (el.disabled = true));

        try {
            const response = await fetch(`/api/posts/${encodeURIComponent(editId)}`);
            if (!response.ok) {
                messageEl.textContent = "Post not found.";
                messageEl.className = "error-text";
                return;
            }
            const post = await response.json();

            // UX guard only — the server independently rejects edits from
            // anyone but the owner.
            if (post.owner !== auth.username) {
                messageEl.textContent = "You can only edit your own posts.";
                messageEl.className = "error-text";
                return;
            }

            document.getElementById("title").value = post.title;
            document.getElementById("author").value = post.author;
            document.getElementById("content").value = post.content;
            form.querySelectorAll("input, textarea, button[type=submit]").forEach(el => (el.disabled = false));
        } catch {
            messageEl.textContent = "Unable to load the post. Please try again.";
            messageEl.className = "error-text";
        }
    }

    if (isEdit) initEditMode();

    form.addEventListener("submit", async event => {
        event.preventDefault();

        const auth = await getAuthStatus();
        if (!auth.loggedIn) {
            window.location.href = "login.html";
            return;
        }

        const title = document.getElementById("title").value.trim();
        const author = document.getElementById("author").value.trim();
        const content = document.getElementById("content").value.trim();

        setButtonLoading(submitBtn, true, isEdit ? "Saving…" : "Publishing…");
        messageEl.textContent = "";

        try {
            const response = await fetch(isEdit ? `/api/posts/${encodeURIComponent(editId)}` : "/api/posts", {
                method: isEdit ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, author, content })
            });

            const data = await response.json();

            if (!response.ok) {
                if (response.status === 401) {
                    window.location.href = "login.html";
                    return;
                }
                messageEl.textContent = data.message;
                messageEl.className = "error-text";
                return;
            }

            showToast(isEdit ? "Post updated!" : "Post published!", "success");
            window.location.href = isEdit ? `post.html?id=${encodeURIComponent(editId)}` : "index.html";
        } catch (error) {
            messageEl.textContent = isEdit
                ? "Unable to update the post. Please try again."
                : "Unable to create the post. Please try again.";
            messageEl.className = "error-text";
        } finally {
            setButtonLoading(submitBtn, false);
        }
    });
}

// ---------------------------------------------------------------------------
// Login form
// ---------------------------------------------------------------------------

const loginForm = document.getElementById("login-form");

if (loginForm) {
    const submitBtn = loginForm.querySelector('button[type="submit"]');

    loginForm.addEventListener("submit", async event => {
        event.preventDefault();

        const username = document.getElementById("username").value.trim();
        const password = document.getElementById("password").value;
        const message = document.getElementById("login-message");

        setButtonLoading(submitBtn, true, "Logging in…");
        message.textContent = "";

        try {
            const response = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (!response.ok) {
                message.textContent = data.message;
                message.className = "error-text";
                return;
            }

            window.location.href = "index.html";
        } catch (error) {
            message.textContent = "Unable to login. Please try again.";
            message.className = "error-text";
        } finally {
            setButtonLoading(submitBtn, false);
        }
    });
}

// ---------------------------------------------------------------------------
// Register form
// ---------------------------------------------------------------------------

const registerForm = document.getElementById("register-form");

if (registerForm) {
    const submitBtn = registerForm.querySelector('button[type="submit"]');

    registerForm.addEventListener("submit", async event => {
        event.preventDefault();

        const username = document.getElementById("register-username").value.trim();
        const password = document.getElementById("register-password").value;
        const confirmPassword = document.getElementById("confirm-password").value;
        const message = document.getElementById("register-message");

        setButtonLoading(submitBtn, true, "Creating account…");
        message.textContent = "";

        try {
            const response = await fetch("/api/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password, confirmPassword })
            });
            const data = await response.json();
            message.textContent = data.message;
            message.className = response.ok ? "success-text" : "error-text";
            if (response.ok) {
                setTimeout(() => (window.location.href = "login.html"), 1200);
            }
        } catch (error) {
            message.textContent = "Unable to register. Please try again.";
            message.className = "error-text";
        } finally {
            setButtonLoading(submitBtn, false);
        }
    });
}

// Show/hide password toggles, wired generically to any
// [data-toggle-password] button that targets an input by id.
document.querySelectorAll("[data-toggle-password]").forEach(btn => {
    btn.addEventListener("click", () => {
        const input = document.getElementById(btn.dataset.togglePassword);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "Hide" : "Show";
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
});

// ---------------------------------------------------------------------------
// Single post page
// ---------------------------------------------------------------------------

async function loadSinglePost() {
    const container = document.getElementById("single-post");
    if (!container) return;

    container.innerHTML = `
        <div class="skeleton-line title"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line" style="width: 90%"></div>
    `;

    const id = new URLSearchParams(window.location.search).get("id");

    if (!id) {
        container.innerHTML = '<div class="error">Post not found.</div>';
        return;
    }

    try {
        const response = await fetch(`/api/posts/${id}`);

        if (!response.ok) {
            container.innerHTML = '<div class="error">Post not found.</div>';
            return;
        }

        const post = await response.json();
        document.title = `${post.title} - Simple Blog`;

        const auth = await getAuthStatus();
        const canEdit = auth.loggedIn && post.owner === auth.username;

        container.innerHTML = `
            <article class="single-post">
                <h1>${escapeHtml(post.title)}</h1>
                <p class="author">
                    Written by ${escapeHtml(post.author)}
                    <span class="meta-dot">·</span>${formatDate(post.createdAt)}
                    <span class="meta-dot">·</span>${readingTime(post.content)} min read${post.updatedAt ? `<span class="meta-dot">·</span>edited ${formatDate(post.updatedAt)}` : ""}
                </p>
                <hr>
                <p class="article-content">${escapeHtml(post.content)}</p>
                <div class="post-actions">
                    <a href="index.html" class="back-btn">← Back to Home</a>
                    ${canEdit ? `<a href="new-post.html?edit=${post.id}" class="edit-btn">Edit</a>` : ""}
                </div>
            </article>
        `;
    } catch (error) {
        container.innerHTML = '<div class="error">Unable to load the post. Please check your connection.</div>';
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

updateNavigation();
loadPosts();
loadSinglePost();
