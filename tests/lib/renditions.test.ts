// The image pipeline, run for real: sharp makes the inputs and reads the outputs back.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DERIVED_EDGE, MediaError, renderImage, sha256Hex, THUMBNAIL_EDGE } from "@/lib/media/renditions";

const photo = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#1d4e89" } });

describe("LS-8 / LS-16 renditions made at upload", () => {
  it("makes an original, a derived rendition and a thumbnail of the same image", async () => {
    const { original, derived, thumbnail } = await renderImage(await photo(3000, 2000).jpeg().toBuffer());
    expect([original.width, original.height]).toEqual([3000, 2000]);
    expect([derived.width, derived.height]).toEqual([DERIVED_EDGE, 1280]);
    expect([thumbnail.width, thumbnail.height]).toEqual([THUMBNAIL_EDGE, 320]);
  });

  it("sizes by the long edge, whichever it is", async () => {
    const { derived, thumbnail } = await renderImage(await photo(2000, 3000).jpeg().toBuffer());
    expect([derived.width, derived.height]).toEqual([1280, DERIVED_EDGE]);
    expect([thumbnail.width, thumbnail.height]).toEqual([320, THUMBNAIL_EDGE]);
  });

  it("never enlarges a small image", async () => {
    const { original, derived, thumbnail } = await renderImage(await photo(300, 200).png().toBuffer());
    for (const rendition of [original, derived, thumbnail]) expect([rendition.width, rendition.height]).toEqual([300, 200]);
  });

  it("the hash and the dimensions describe the served bytes, not the upload", async () => {
    const upload = await photo(2400, 1600).webp().toBuffer();
    const { original, derived } = await renderImage(upload);
    for (const rendition of [original, derived]) {
      expect(rendition.sha256).toBe(sha256Hex(rendition.bytes));
      expect(rendition.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rendition.sha256).not.toBe(sha256Hex(upload));
      const read = await sharp(rendition.bytes).metadata();
      expect([read.format, read.width, read.height]).toEqual(["jpeg", rendition.width, rendition.height]);
    }
  });
});

describe("what an upload must not carry onto the wire", () => {
  it("strips metadata from every rendition — a photograph's GPS position would defeat location_exact", async () => {
    const upload = await photo(1000, 800)
      .withExif({ IFD0: { Copyright: "Example Yacht Brokerage" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 44/1 0/1" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(upload).metadata()).exif).toBeDefined();

    const renditions = await renderImage(upload);
    for (const rendition of Object.values(renditions)) expect((await sharp(rendition.bytes).metadata()).exif).toBeUndefined();
  });

  it("applies the camera's orientation before dropping the tag that carried it", async () => {
    // Orientation 6: stored landscape, to be shown rotated a quarter turn.
    const upload = await photo(400, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const { original, thumbnail } = await renderImage(upload);
    expect([original.width, original.height]).toEqual([200, 400]);
    expect([thumbnail.width, thumbnail.height]).toEqual([200, 400]);
  });

  it("puts a transparent drawing onto white", async () => {
    const plan = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const { derived } = await renderImage(plan);
    const { data } = await sharp(derived.bytes).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });
});

describe("what is refused", () => {
  it.each([
    ["a file that is not an image", Buffer.from("%PDF-1.7 not an image at all")],
    ["an empty file", Buffer.alloc(0)],
    ["an SVG, whatever it is called", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')],
  ])("%s", async (_label, bytes) => {
    await expect(renderImage(bytes)).rejects.toThrow(MediaError);
  });

  it("a GIF — accepted formats are decided from the bytes", async () => {
    await expect(renderImage(await photo(10, 10).gif().toBuffer())).rejects.toThrow(MediaError);
  });

  it("a truncated image", async () => {
    const whole = await photo(800, 600).jpeg().toBuffer();
    await expect(renderImage(whole.subarray(0, Math.floor(whole.length / 2)))).rejects.toThrow(MediaError);
  });
});
