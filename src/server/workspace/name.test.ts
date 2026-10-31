// T-9 (REQ-2): workspace name rules and the default name. No database.
import { describe, expect, it } from "vitest";
import {
  FALLBACK_WORKSPACE_NAME,
  WORKSPACE_NAME_MAX,
  defaultWorkspaceName,
  nameLength,
  workspaceNameSchema,
} from "./name";

const EMOJI = "\u{1F600}"; // two UTF-16 units, one code point
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 5 code points, one grapheme
const ACCENTED = "é"; // "e" + combining acute: 2 code points, one grapheme
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL_MESSAGE = "Remove line breaks and other control characters.";

function parse(value: unknown) {
  return workspaceNameSchema.safeParse(value);
}

describe("REQ-2: workspace name validation", () => {
  it("REQ-2: a name is trimmed before it is checked and saved", () => {
    expect(parse("  Platform team \n")).toMatchObject({ success: true, data: "Platform team" });
  });

  it("REQ-2: a blank or whitespace-only name is rejected", () => {
    for (const value of ["", " ", "\t\n ", "  "]) {
      expect(parse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("REQ-2: 50 characters are allowed and 51 are not", () => {
    expect(WORKSPACE_NAME_MAX).toBe(50);
    expect(parse("a".repeat(50)).success).toBe(true);
    expect(parse("a".repeat(51)).success).toBe(false);
    // Surrounding spaces don't count.
    expect(parse(`  ${"a".repeat(50)}  `).success).toBe(true);
  });

  it("REQ-2: characters are counted as code points, so emoji count once", () => {
    expect(nameLength(EMOJI.repeat(50))).toBe(50);
    expect(EMOJI.repeat(50).length).toBe(100);
    expect(parse(EMOJI.repeat(50)).success).toBe(true);
    expect(parse(EMOJI.repeat(51)).success).toBe(false);
    expect(parse(`${"a".repeat(49)}${EMOJI}`).success).toBe(true);
  });

  it("REQ-2: control characters (NUL, line breaks) and bidi controls are rejected", () => {
    for (const value of [
      "Ops\u0000team",
      "Ops\nteam",
      "Ops\rteam",
      "Ops\tteam",
      "Ops\u007f",
      "‮evil",
      "a‪b",
      "a⁦b⁩",
    ]) {
      const result = parse(value);
      expect(result.success, JSON.stringify(value)).toBe(false);
      expect(result.error?.issues[0]?.message, JSON.stringify(value)).toBe(CONTROL_MESSAGE);
    }
    // Right-to-left text and joiners inside emoji are still fine.
    expect(parse("שלום team").success).toBe(true);
    expect(parse(`Team ${FAMILY}`).success).toBe(true);
  });

  it("REQ-2: any text is allowed, including markup-like text (it is rendered as text)", () => {
    expect(parse("<script>alert(1)</script>")).toMatchObject({ success: true });
    expect(parse("Équipe d'Ops")).toMatchObject({ success: true });
  });

  it("REQ-2: anything but a string is rejected", () => {
    for (const value of [undefined, null, 42, ["a"], { name: "a" }]) {
      expect(parse(value).success).toBe(false);
    }
  });
});

describe("REQ-2: the default workspace name", () => {
  it("REQ-2: is \"<name>'s workspace\" from the user's name", () => {
    expect(defaultWorkspaceName("Ada Lovelace")).toBe("Ada Lovelace's workspace");
    expect(defaultWorkspaceName("  Ada  ")).toBe("Ada's workspace");
  });

  it('REQ-2: is "My workspace" when the name is blank', () => {
    for (const value of ["", "   ", "\n\t", null, undefined]) {
      expect(defaultWorkspaceName(value)).toBe(FALLBACK_WORKSPACE_NAME);
    }
    expect(FALLBACK_WORKSPACE_NAME).toBe("My workspace");
  });

  it("REQ-2: a long name is cut so the whole default fits 50 characters", () => {
    const name = defaultWorkspaceName("x".repeat(80));
    expect(nameLength(name)).toBe(50);
    expect(name).toBe(`${"x".repeat(38)}'s workspace`);
    // A name that fits exactly is not cut.
    expect(defaultWorkspaceName("y".repeat(38))).toBe(`${"y".repeat(38)}'s workspace`);
  });

  it("REQ-2: the cut never splits a surrogate pair", () => {
    const name = defaultWorkspaceName(`${"a".repeat(37)}${EMOJI}${EMOJI}${EMOJI}`);
    expect(name).toBe(`${"a".repeat(37)}${EMOJI}'s workspace`);
    expect(LONE_SURROGATE.test(name)).toBe(false);
    const allEmoji = defaultWorkspaceName(EMOJI.repeat(60));
    expect(nameLength(allEmoji)).toBe(50);
    expect(LONE_SURROGATE.test(allEmoji)).toBe(false);
  });

  it("REQ-2: the cut never splits a grapheme cluster (ZWJ emoji, combining marks)", () => {
    // 36 + 5 code points would pass the 38 that fit, so the whole family is left out.
    expect(defaultWorkspaceName(`${"a".repeat(36)}${FAMILY}`)).toBe(
      `${"a".repeat(36)}'s workspace`,
    );
    // 33 + 5 = 38 fits exactly; the "x" after it doesn't.
    expect(defaultWorkspaceName(`${"a".repeat(33)}${FAMILY}x`)).toBe(
      `${"a".repeat(33)}${FAMILY}'s workspace`,
    );
    expect(defaultWorkspaceName(`${"a".repeat(37)}${ACCENTED}`)).toBe(
      `${"a".repeat(37)}'s workspace`,
    );
    expect(defaultWorkspaceName(`${"a".repeat(36)}${ACCENTED}`)).toBe(
      `${"a".repeat(36)}${ACCENTED}'s workspace`,
    );
  });

  it("REQ-2: control and bidi characters in the GitHub name are cleaned out", () => {
    expect(defaultWorkspaceName("Ada\nLovelace")).toBe("Ada Lovelace's workspace");
    expect(defaultWorkspaceName("‮Ada\u0000")).toBe("Ada's workspace");
    // Nothing usable left: the fallback.
    expect(defaultWorkspaceName("\u0000\n‮⁦")).toBe(FALLBACK_WORKSPACE_NAME);
  });

  it("REQ-2: a cut that ends on a space doesn't leave the space in", () => {
    expect(defaultWorkspaceName(`${"a".repeat(37)} bcdef`)).toBe(`${"a".repeat(37)}'s workspace`);
  });

  it("REQ-2: every default name passes the name rules", () => {
    for (const value of [
      "Ada",
      "",
      "z".repeat(200),
      EMOJI.repeat(99),
      `${"a".repeat(37)}  x`,
      "A\u0000‮b\nc",
      FAMILY.repeat(20),
    ]) {
      expect(parse(defaultWorkspaceName(value)).success, value).toBe(true);
    }
  });
});
