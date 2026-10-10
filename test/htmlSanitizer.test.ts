import { describe, expect, it } from "vitest";
import { cleanRichText, plainText } from "../src/helpers/htmlSanitizer";

describe("question HTML sanitization", () => {
  it("preserves supported formatting and text alignment only", () => {
    expect(cleanRichText(
      '<p style="text-align:center;color:red" onclick="alert(1)"><strong>Safe</strong><img src=x></p>',
    )).toBe('<p style="text-align:center;"><strong>Safe</strong></p>');
  });

  it("removes executable tags and their contents", () => {
    expect(cleanRichText("<p>Safe</p><script>alert(1)</script><style>body{display:none}</style>"))
      .toBe("<p>Safe</p>");
  });

  it("returns plain text without markup or executable content", () => {
    expect(plainText("<p>Hello&nbsp;<b>there</b></p><script>alert(1)</script>"))
      .toBe("Hello there");
  });
});
