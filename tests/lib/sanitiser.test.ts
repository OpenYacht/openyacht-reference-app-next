// The restricted-HTML sanitiser, against the real library. Where no person
// reviews a listing before it appears, this is the only thing standing between
// a partner's description and a rendered page.
import { describe, expect, it } from "vitest";
import { descriptionSanitiser } from "@/lib/federation/sanitiser";

const clean = (html: string) => descriptionSanitiser.sanitise(html);

describe("LS-4 / LS-5 restricted HTML", () => {
  it("keeps the allowed subset untouched", () => {
    const html =
      "<h3>Highlights</h3><p>A <strong>well</strong> <em>kept</em> yacht.<br />Second line.</p><ul><li>One</li></ul><ol><li>Two</li></ol><h4>More</h4>";
    expect(clean(html)).toBe(html);
  });

  it("keeps https links and nothing else about them", () => {
    expect(clean('<a href="https://builder.example/model" class="x" style="color:red" onclick="steal()" target="_blank">spec</a>')).toBe(
      '<a href="https://builder.example/model">spec</a>',
    );
  });

  it.each([
    ["javascript:", '<a href="javascript:alert(1)">x</a>'],
    ["plain http", '<a href="http://insecure.example/">x</a>'],
    ["protocol-relative", '<a href="//evil.example/">x</a>'],
    ["data:", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ["obfuscated javascript", '<a href="jav&#x09;ascript:alert(1)">x</a>'],
  ])("drops a %s link target", (_label, html) => {
    expect(clean(html)).toBe("<a>x</a>");
  });

  it.each([
    ["script", "<p>ok</p><script>alert(1)</script>", "<p>ok</p>"],
    ["style", "<style>p{display:none}</style><p>ok</p>", "<p>ok</p>"],
    ["an image with a handler", '<p>ok<img src="x" onerror="alert(1)"></p>', "<p>ok</p>"],
    ["an iframe", '<iframe src="https://evil.example"></iframe><p>ok</p>', "<p>ok</p>"],
    ["an event handler on an allowed tag", '<p onmouseover="alert(1)">ok</p>', "<p>ok</p>"],
    ["svg script", "<svg><script>alert(1)</script></svg><p>ok</p>", "<p>ok</p>"],
    ["a form", '<form action="https://evil.example"><input name="q"></form><p>ok</p>', "<p>ok</p>"],
  ])("removes %s", (_label, html, expected) => {
    expect(clean(html)).toBe(expected);
  });

  it("drops disallowed elements but keeps their text: a table becomes its words, not nothing", () => {
    expect(clean("<table><tr><td>Length</td><td>24 m</td></tr></table>")).toBe("Length24 m");
    expect(clean("<h1>Title</h1><div><span>body</span></div>")).toBe("Titlebody");
  });

  it("removes comments — including the abrupt-close form that parsers disagree about", () => {
    expect(clean("<p>ok</p><!-- note -->")).toBe("<p>ok</p>");
    const result = clean("<!--><img src=x onerror=alert(1)>--><p>ok</p>");
    expect(result).not.toMatch(/<img|onerror|<!--/i);
    expect(result).toContain("<p>ok</p>");
  });

  it("is idempotent, so sanitising again at render changes nothing", () => {
    const once = clean('<p>A <b>bold</b> claim<script>x</script> &amp; an <a href="https://a.example/?q=1&r=2">ampersand</a></p>');
    expect(clean(once)).toBe(once);
  });
});
