import { guessMimeFromUrl, mediaFromContentHtml } from "./media.js";

function escapeXml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");
}

function toRfc822(iso) {
	const d = iso ? new Date(iso) : new Date();
	if (Number.isNaN(d.getTime())) return new Date().toUTCString();
	return d.toUTCString();
}

/** Title shown in RSS readers — always includes the poster name. */
function previewTitle(p) {
	const name = String(p.profileName || "").trim();
	let title = String(p.title || "").trim();
	if (!title) title = name ? `${name}` : "Facebook post";
	if (name && !title.toLowerCase().startsWith(name.toLowerCase())) {
		return `${name}: ${title}`;
	}
	return title;
}

function plainSummary(htmlBody) {
	let s = String(htmlBody || "");
	for (const tag of ["<p>", "</p>", "<br>", "<br/>", "<br />"]) {
		s = s.split(tag).join("\n");
	}
	for (;;) {
		const start = s.indexOf("<");
		if (start < 0) break;
		const end = s.indexOf(">", start);
		if (end < 0) break;
		s = s.slice(0, start) + s.slice(end + 1);
	}
	s = s.replace(/\s+/g, " ").trim();
	const chars = [...s];
	if (chars.length > 280) return `${chars.slice(0, 277).join("")}...`;
	return s;
}

function mediaXml(contentHtml) {
	const { images, videos } = mediaFromContentHtml(contentHtml);
	const chunks = [];

	// RSS 2.0 allows one enclosure; prefer the first video, else first image.
	const enclosure = videos[0] || (images[0] ? { url: images[0] } : null);
	if (enclosure?.url) {
		const type = videos[0]
			? videos[0].type || "video/mp4"
			: guessMimeFromUrl(enclosure.url);
		chunks.push(
			`	  <enclosure url="${escapeXml(enclosure.url)}" type="${escapeXml(type)}" length="0" />`,
		);
	}

	for (const v of videos) {
		chunks.push(
			`	  <media:content url="${escapeXml(v.url)}" type="${escapeXml(v.type || "video/mp4")}" medium="video" />`,
		);
		if (v.poster) {
			chunks.push(
				`	  <media:thumbnail url="${escapeXml(v.poster)}" />`,
			);
		}
	}
	for (const img of images) {
		chunks.push(
			`	  <media:content url="${escapeXml(img)}" type="${escapeXml(guessMimeFromUrl(img))}" medium="image" />`,
		);
	}
	return chunks.length ? `\n${chunks.join("\n")}` : "";
}

/**
 * @param {{ title: string, link: string, description: string }} feedCfg
 * @param {Array<object>} posts
 */
export function buildFeed(feedCfg, posts) {
	const now = new Date().toUTCString();
	// Channel pubDate = newest item's post time (not fetch/build time).
	let newestMs = NaN;
	for (const p of posts || []) {
		const ms = Date.parse(p.publishedAt || "");
		if (!Number.isNaN(ms) && (Number.isNaN(newestMs) || ms > newestMs)) newestMs = ms;
	}
	const channelPub = Number.isNaN(newestMs) ? now : new Date(newestMs).toUTCString();

	const items = posts
		.map((p) => {
			const title = previewTitle(p);
			const description = plainSummary(p.content);
			return `    <item>
	  <title>${escapeXml(title)}</title>
	  <link>${escapeXml(p.url)}</link>
	  <guid isPermaLink="false">${escapeXml(p.id)}</guid>
	  <pubDate>${toRfc822(p.publishedAt)}</pubDate>
	  <author>${escapeXml(p.profileName)}</author>
	  <description>${escapeXml(description)}</description>
	  <content:encoded><![CDATA[${p.content}]]></content:encoded>${mediaXml(p.content)}
	</item>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
	<title>${escapeXml(feedCfg.title)}</title>
	<link>${escapeXml(feedCfg.link)}</link>
	<description>${escapeXml(feedCfg.description)}</description>
	<pubDate>${channelPub}</pubDate>
	<lastBuildDate>${now}</lastBuildDate>
		${items}
  </channel>
</rss>
`;
}
