import assert from "node:assert/strict";
import {
  WEB_RESEARCH_SOURCES,
  buildResearchSearchLinks,
  classifyResearchUrl
} from "../src/research/sources.js";

assert.deepEqual(WEB_RESEARCH_SOURCES.map(source => source.id), ["habr", "stackoverflow"]);
assert.equal(classifyResearchUrl("https://habr.ru/post/123"), "habr");
assert.equal(classifyResearchUrl("https://habr.com/ru/articles/123/"), "habr");
assert.equal(classifyResearchUrl("https://stackoverflow.com/questions/123"), "stackoverflow");
for (const url of [
  "http://habr.ru/",
  "https://habr.com.evil.invalid/",
  "https://stackoverflow.com.evil.invalid/",
  "https://stackoverflow.com@evil.invalid/",
  "https://evil.invalid/?url=https://habr.ru/",
  "file:///etc/passwd",
  "https://user:password@habr.com/",
  "https://habr.com:8443/",
  "/relative/path",
  ""
]) {
  assert.equal(classifyResearchUrl(url), null, url);
}
const links = buildResearchSearchLinks("websockets 429/503 Retry-After");
assert.equal(links.length, 2);
for (const link of links) {
  assert.equal(classifyResearchUrl(link.url), link.source_id);
  assert.equal(new URL(link.url).searchParams.get("q"), "websockets 429/503 Retry-After");
}
assert.throws(() => buildResearchSearchLinks(""), /invalid_research_query/);
assert.throws(() => buildResearchSearchLinks("a".repeat(201)), /invalid_research_query/);
console.log("Research source catalogue: PASS");
