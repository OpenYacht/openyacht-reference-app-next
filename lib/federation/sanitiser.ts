import "server-only";
import sanitizeHtml from "sanitize-html";
import type { HtmlSanitiser } from "@/federation";

/**
 * The restricted HTML subset for `descriptions[].content` — the only field
 * that may carry markup (LS-4, LS-5; listing-schema.md Conventions §7):
 * p, br, ul, ol, li, strong, em, h3, h4 and a[href] with https links only. No
 * other attributes, no styles, classes, scripts, images or tables.
 *
 * Disallowed elements are dropped but their text is kept; script and style
 * are dropped with their contents; comments are always removed, so nothing
 * here depends on how a particular parser treats a malformed comment.
 */
export const descriptionSanitiser: HtmlSanitiser = {
  sanitise: (html) =>
    sanitizeHtml(html, {
      allowedTags: ["p", "br", "ul", "ol", "li", "strong", "em", "h3", "h4", "a"],
      allowedAttributes: { a: ["href"] },
      allowedSchemes: ["https"],
      allowedSchemesAppliedToAttributes: ["href"],
      allowProtocolRelative: false,
      disallowedTagsMode: "discard",
      enforceHtmlBoundary: false,
    }),
};
