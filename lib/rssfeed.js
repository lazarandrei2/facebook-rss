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

/**
 * @param {{ title: string, link: string, description: string }} feedCfg
 * @param {Array<object>} posts
 */
export function buildFeed(feedCfg, posts) {
	const now = new Date().toUTCString();
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
	  <content:encoded><![CDATA[${p.content}]]></content:encoded>
	</item>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
	<title>${escapeXml(feedCfg.title)}</title>
	<link>${escapeXml(feedCfg.link)}</link>
	<description>${escapeXml(feedCfg.description)}</description>
	<pubDate>${now}</pubDate>
		${items}
  </channel>
</rss>
`;
}
