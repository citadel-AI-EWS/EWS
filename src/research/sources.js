// Curated public engineering-reference sites for future read-only web research.
// This is a source catalogue, NOT a network permission or a web fetcher.
export const WEB_RESEARCH_SOURCES = Object.freeze([
  Object.freeze({
    id: "habr",
    label: "Habr",
    homepage: "https://habr.com/ru/",
    search_template: "https://habr.com/ru/search/?q={query}",
    allowed_hosts: Object.freeze(["habr.com", "habr.ru"]),
    kind: "community_articles",
    language: "ru",
    trust: "unverified_external"
  }),
  Object.freeze({
    id: "stackoverflow",
    label: "Stack Overflow",
    homepage: "https://stackoverflow.com/",
    search_template: "https://stackoverflow.com/search?q={query}",
    allowed_hosts: Object.freeze(["stackoverflow.com"]),
    kind: "community_qa",
    language: "en",
    trust: "unverified_external",
    official_api: "https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow"
  })
]);

// Only known HTTPS hosts may be classified as an approved research reference.
// Classification MUST NOT grant network access, run code or send project data.
export function classifyResearchUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443")) return null;
  return WEB_RESEARCH_SOURCES.find(source =>
    source.allowed_hosts.includes(url.hostname.toLowerCase())
  )?.id ?? null;
}

export function buildResearchSearchLinks(query) {
  if (typeof query !== "string" || !query.trim() || query.length > 200) {
    throw new TypeError("invalid_research_query");
  }
  const encoded = encodeURIComponent(query.trim());
  return WEB_RESEARCH_SOURCES.map(source => ({
    source_id: source.id,
    url: source.search_template.replace("{query}", encoded)
  }));
}
