/**
 * Bookmark → blogroll import
 * Called when a micropub bookmark post is created.
 * Discovers feeds for the bookmarked site's origin and adds them to the blogroll.
 * @module lib/bookmark-import
 */

import { discoverFeeds } from "./utils/feed-discovery.js";
import { upsertBlog } from "./storage/blogs.js";

/**
 * Import a bookmarked URL's site into the blogroll.
 * Extracts the origin URL, discovers feeds, and upserts the first feed as a blog entry.
 *
 * @param {object} application - Indiekit application object
 * @param {string} bookmarkUrl - The URL that was bookmarked (bookmark-of value)
 * @param {string} [category="bookmarks"] - Category to assign in the blogroll
 * @returns {Promise<object>} Result { added, alreadyExists, noFeeds, error }
 */
export async function importBookmarkUrl(application, bookmarkUrl, category = "bookmarks") {
  // Normalise: bookmark-of may be an array in some micropub clients
  const url = Array.isArray(bookmarkUrl) ? bookmarkUrl[0] : bookmarkUrl;

  let siteUrl;
  try {
    siteUrl = new URL(url).origin;
  } catch {
    return { error: `Invalid bookmark URL: ${url}` };
  }

  // Guard: blogroll DB must be available
  if (typeof application.getBlogrollDb !== "function") {
    console.warn("[Blogroll] bookmark-import: getBlogrollDb not available");
    return { error: "blogroll not initialised" };
  }

  const db = application.getBlogrollDb();

  // Check if any active blog with this siteUrl is already in the blogroll
  const existing = await db.collection("blogrollBlogs").findOne({
    siteUrl,
    status: { $ne: "deleted" },
  });

  if (existing) {
    // If the category differs, update it (tag changed on the bookmark post)
    if (existing.category !== category) {
      await db.collection("blogrollBlogs").updateOne(
        { _id: existing._id },
        { $set: { category, updatedAt: new Date().toISOString() } },
      );
      console.log(
        `[Blogroll] bookmark-import: updated category for "${existing.title}" → "${category}"`,
      );
      return { updated: true, siteUrl };
    }
    console.log(
      `[Blogroll] bookmark-import: ${siteUrl} already in blogroll ("${existing.title}")`,
    );
    return { alreadyExists: true, siteUrl };
  }

  // Discover feeds from the origin
  const discovery = await discoverFeeds(siteUrl);

  if (!discovery.success || discovery.feeds.length === 0) {
    console.log(`[Blogroll] bookmark-import: no feeds found for ${siteUrl}`);
    return { noFeeds: true, siteUrl };
  }

  // Add the first discovered feed
  const feed = discovery.feeds[0];
  const result = await upsertBlog(application, {
    title: discovery.pageTitle || siteUrl,
    feedUrl: feed.url,
    siteUrl,
    feedType: feed.type || "rss",
    category,
    source: "bookmark",
    sourceId: null,
    status: "active",
  });

  if (result.upserted) {
    console.log(
      `[Blogroll] bookmark-import: added ${feed.url} ("${discovery.pageTitle || siteUrl}") → category "${category}"`
    );
  }

  return { added: result.upserted ? 1 : 0, siteUrl };
}