import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { dashboardController } from "./lib/controllers/dashboard.js";
import { blogsController } from "./lib/controllers/blogs.js";
import { sourcesController } from "./lib/controllers/sources.js";
import { apiController } from "./lib/controllers/api.js";
import { startSync, stopSync } from "./lib/sync/scheduler.js";
import { importBookmarkUrl } from "./lib/bookmark-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const protectedRouter = express.Router();
const publicRouter = express.Router();

// Global hook router: intercepts POST requests site-wide to detect micropub
// bookmark creations and auto-import the bookmarked site into the blogroll.
// Mounted at "/" via contentNegotiationRoutes (runs before auth middleware).
const bookmarkHookRouter = express.Router();
bookmarkHookRouter.use((request, response, next) => {
  response.on("finish", () => {
    // Only act on successful POST creates (201 Created / 202 Accepted)
    if (
      request.method !== "POST" ||
      (response.statusCode !== 201 && response.statusCode !== 202)
    ) {
      return;
    }

    // Ignore non-create actions (update, delete, undelete)
    const action =
      request.query?.action || request.body?.action || "create";
    if (action !== "create") return;

    // bookmark-of may be a top-level field (form-encoded / JF2 JSON)
    // or nested inside properties (MF2 JSON format)
    const bookmarkOf =
      request.body?.["bookmark-of"] ||
      request.body?.properties?.["bookmark-of"]?.[0];
    if (!bookmarkOf) return;

    const { application } = request.app.locals;
    importBookmarkUrl(application, bookmarkOf).catch((err) =>
      console.warn("[Blogroll] bookmark-import failed:", err.message)
    );
  });

  next();
});

const defaults = {
  mountPath: "/blogrollapi",
  syncInterval: 3600000, // 1 hour
  maxItemsPerBlog: 50,
  maxItemAge: 30, // days
  fetchTimeout: 15000,
};

export default class BlogrollEndpoint {
  name = "Blogroll endpoint";

  constructor(options = {}) {
    this.options = { ...defaults, ...options };
    this.mountPath = this.options.mountPath;
  }

  get localesDirectory() {
    return path.join(__dirname, "locales");
  }

  get viewsDirectory() {
    return path.join(__dirname, "views");
  }

  get navigationItems() {
    return {
      href: this.options.mountPath,
      text: "blogroll.title",
      requiresDatabase: true,
    };
  }

  get shortcutItems() {
    return {
      url: this.options.mountPath,
      name: "blogroll.title",
      iconName: "bookmark",
      requiresDatabase: true,
    };
  }

  /**
   * Global middleware (mounted at "/") — intercepts micropub bookmark creations.
   * Uses res.on("finish") so it never interferes with the request lifecycle.
   */
  get contentNegotiationRoutes() {
    return bookmarkHookRouter;
  }

  /**
   * Protected routes (require authentication)
   * Admin dashboard and management
   */
  get routes() {
    // Dashboard
    protectedRouter.get("/", dashboardController.get);

    // Manual sync trigger
    protectedRouter.post("/sync", dashboardController.sync);

    // Clear and re-sync
    protectedRouter.post("/clear-resync", dashboardController.clearResync);

    // Sources management
    protectedRouter.get("/sources", sourcesController.list);
    protectedRouter.get("/sources/new", sourcesController.newForm);
    protectedRouter.post("/sources", sourcesController.create);
    protectedRouter.get("/sources/:id", sourcesController.edit);
    protectedRouter.post("/sources/:id", sourcesController.update);
    protectedRouter.post("/sources/:id/delete", sourcesController.remove);
    protectedRouter.post("/sources/:id/sync", sourcesController.sync);

    // Blogs management
    protectedRouter.get("/blogs", blogsController.list);
    protectedRouter.get("/blogs/new", blogsController.newForm);
    protectedRouter.post("/blogs", blogsController.create);
    protectedRouter.get("/blogs/:id", blogsController.edit);
    protectedRouter.post("/blogs/:id", blogsController.update);
    protectedRouter.post("/blogs/:id/delete", blogsController.remove);
    protectedRouter.post("/blogs/:id/refresh", blogsController.refresh);

    // Feed discovery (protected to prevent abuse)
    protectedRouter.get("/api/discover", apiController.discover);

    // Microsub integration (protected - internal use)
    protectedRouter.post("/api/microsub-webhook", apiController.microsubWebhook);
    protectedRouter.get("/api/microsub-status", apiController.microsubStatus);

    // FeedLand integration (protected - category discovery)
    protectedRouter.get("/api/feedland-categories", sourcesController.feedlandCategories);

    return protectedRouter;
  }

  /**
   * Public routes (no authentication required)
   * Read-only JSON API endpoints for frontend
   */
  get routesPublic() {
    // Blogs API (read-only)
    publicRouter.get("/api/blogs", apiController.listBlogs);
    publicRouter.get("/api/blogs/:id", apiController.getBlog);

    // Items API (read-only)
    publicRouter.get("/api/items", apiController.listItems);

    // Categories API
    publicRouter.get("/api/categories", apiController.listCategories);

    // Status API
    publicRouter.get("/api/status", apiController.status);

    // OPML export
    publicRouter.get("/api/opml", apiController.exportOpml);
    publicRouter.get("/api/opml/:category", apiController.exportOpmlCategory);

    return publicRouter;
  }

  init(Indiekit) {
    Indiekit.addEndpoint(this);

    // Add MongoDB collections
    Indiekit.addCollection("blogrollSources");
    Indiekit.addCollection("blogrollBlogs");
    Indiekit.addCollection("blogrollItems");
    Indiekit.addCollection("blogrollMeta");

    // Store config in application for controller access
    Indiekit.config.application.blogrollConfig = this.options;
    Indiekit.config.application.blogrollEndpoint = this.mountPath;

    // Store database getter for controller access
    Indiekit.config.application.getBlogrollDb = () => Indiekit.database;

    // Start background sync if database is available
    if (Indiekit.config.application.mongodbUrl) {
      startSync(Indiekit, this.options);
    }
  }

  destroy() {
    stopSync();
  }
}