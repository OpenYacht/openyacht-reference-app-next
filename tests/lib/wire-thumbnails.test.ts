// Previews of partner media come from the authority's thumbnails only, and only over https.
import { describe, expect, it } from "vitest";
import { collectionThumbnails, httpsUrl, profileThumbnail } from "@/lib/listings/wire-thumbnails";

describe("FP-14 inbound media URLs are untrusted", () => {
  it("accepts an absolute https URL", () => {
    expect(httpsUrl("https://media.node.example/t/1.jpg")).toBe("https://media.node.example/t/1.jpg");
  });

  it.each([
    ["plain http", "http://media.node.example/1.jpg"],
    ["a script URL", "javascript:alert(1)"],
    ["a data URL", "data:image/svg+xml,<svg/>"],
    ["a relative path", "/media/1.jpg"],
    ["embedded credentials", "https://user:secret@media.node.example/1.jpg"],
    ["not a string", 42],
  ])("refuses %s", (_label, value) => {
    expect(httpsUrl(value)).toBeNull();
  });
});

describe("LS-16 previews use the authority's thumbnails", () => {
  const payload = {
    media: {
      profile: { url: "https://media.node.example/full/hero.jpg", thumbnail_url: "https://media.node.example/t/hero.jpg", caption: "At anchor" },
      gallery: [
        { url: "https://media.node.example/full/b.jpg", thumbnail_url: "https://media.node.example/t/b.jpg", caption: null, sort: 2 },
        { url: "https://media.node.example/full/a.jpg", thumbnail_url: "https://media.node.example/t/a.jpg", caption: "Saloon", sort: 1 },
        { url: "https://media.node.example/full/c.jpg", thumbnail_url: null, sort: 3 },
        { url: "https://media.node.example/full/d.jpg", thumbnail_url: "http://media.node.example/t/d.jpg", sort: 4 },
      ],
      layouts: [],
    },
  };

  it("takes the profile thumbnail, never the full-resolution url", () => {
    expect(profileThumbnail(payload)).toEqual({ src: "https://media.node.example/t/hero.jpg", caption: "At anchor" });
  });

  it("orders the gallery by sort and counts the items it cannot preview", () => {
    expect(collectionThumbnails(payload, "gallery")).toEqual({
      thumbnails: [
        { src: "https://media.node.example/t/a.jpg", caption: "Saloon" },
        { src: "https://media.node.example/t/b.jpg", caption: null },
      ],
      withoutPreview: 2,
    });
  });

  it("copes with a missing or malformed media block", () => {
    expect(profileThumbnail(null)).toBeNull();
    expect(profileThumbnail({ media: { profile: null } })).toBeNull();
    expect(collectionThumbnails({ media: { gallery: "nope" } }, "gallery")).toEqual({ thumbnails: [], withoutPreview: 0 });
  });
});
