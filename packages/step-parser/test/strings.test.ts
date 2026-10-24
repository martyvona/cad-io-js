import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeString, stringEnd } from '../src/index.ts';

const enc = new TextEncoder();
const bytesOf = (s: string) => enc.encode(s);
function decode(literal: string): string | undefined {
  // Strings occur inside a parameter list, so follow the literal with a delimiter.
  return decodeString(bytesOf(literal + ')'), 0)?.value;
}

// The 15 cases of OCCT's test bugs/step/bug28454_2 (file bug28454_directives.stp), copied verbatim: the STEP
// literal and the name OCCT must produce. Several are deliberately malformed.
const OCCT_CASES: [string, string][] = [
  ["'AaBbCc\\X2\\00C4\\X0\\\\X2\\00E4\\X0\\\\X2\\00D6\\X0\\\\X2\\00F6\\X0\\"
    + "\\X2\\00DC\\X0\\\\X2\\00FC\\X0\\\\X2\\00DF\\X0\\*,.-;:_'",
    "AaBbCc\u00C4\u00E4\u00D6\u00F6\u00DC\u00FC\u00DF*,.-;:_"],
  ["'\\X2\\03C0\\X0\\'", "\u03C0"],
  ["'Expression: \\X2\\03B103B2\\X0\\\\\\X2\\03B3\\X0\\*\\X2\\03C0\\X0\\'",
    "Expression: \u03B1\u03B2\\X2\\03B3*\u03C0"],
  ["'\\X4\\0001F7CA\\X0\\'", "\u{1F7CA}"],
  ["'Star, arrow, faces: \\X4\\0001F7CA0001f80A0001f6370001f926\\X0\\ end'",
    "Star, arrow, faces: \u{1F7CA}\u{1F80A}\u{1F637}\u{1F926} end"],
  ["'\\S\\Drger'", "\u00C4rger"],
  ["'h\\S\\ttel'", "h\u00F4tel"],
  ["'\\PE\\\\S\\*\\S\\U\\S\\b'", "\u040A\u0435\u0442"],
  ["'see \\X\\A7 4.1'", "see \u00A7 4.1"],
  ["'line one\\X\\0Aline two'", "line one\nline two"],
  ["'Expression: \\X\\B13\\X2\\03C0\\X0\\*\\X2\\03C0\\X0\\+12'", "Expression: \u00B13\u03C0*\u03C0+12"],
  ["'Expression: \\X2\\03B1\\X0\\\\PC\\*\\X2\\03B2\\X0\\\\S\\w\\X2\\03B3'", "Expression: \u03B1*\u03B2\u00F7\u03B3"],
  // OCCT's test prints \S\D for this one, but the data file has \S\B (ISO 8859-5 0xC2 = \u0422); \S\D would be \u0424.
  ["'T\\PE\\\\S\\5C\\S\\B'", "T\u0415C\u0422"],
  ["'A\\S\\DaBbCc\\X2\\0C4\\X0\\'h\\S\\t\\X2\\0E4\\X0\\\\X4\\0001F7CA\\X0\\\\X\\0A\\X4\\0001F7CA\\X0\\*,.-;"
    + ":_\\X2\\0D6\\X0\\\\PE\\\\S\\5'", "A\u00C4aBbCc\u00C4'h\u00F4\u00E4\u{1F7CA}\n\u{1F7CA}*,.-;:_\u00D6\u0415"],
  ["'\\X2\\3B13B23B3\\X0\\'", "\u03B1\u03B2\u03B3"],
];

test('OCCT string directive cases (bug28454)', () => {
  for (const [literal, expected] of OCCT_CASES) assert.equal(decode(literal), expected, literal);
});

test('basic strings and escapes', () => {
  assert.equal(decode("''"), '');
  assert.equal(decode("'plain text'"), 'plain text');
  assert.equal(decode("'it''s'"), "it's");
  assert.equal(decode("'a'',b'"), "a',b"); // a conformant string containing ', is not split
  assert.equal(decode("'back\\\\slash'"), 'back\\slash');
  assert.equal(decode("'\\X2\\00E9\\X0\\t\\X2\\D83DDE00\\X0\\'"), '\u00e9t\u{1F600}'); // surrogate pair via X2
  assert.equal(decode("'\\PB\\\\S\\9'"), '\u0161'); // ISO 8859-2 0xB9: LATIN SMALL LETTER S WITH CARON
});

test('tolerances', () => {
  assert.equal(decode("'Bob's part'"), "Bob's part"); // lone apostrophe
  assert.equal(decode("'C:\\temp\\new'"), 'C:\\temp\\new'); // unescaped backslashes stay literal
  assert.equal(decode("'wrapped\r\n line'"), 'wrapped line'); // line breaks dropped
  assert.equal(decode("'tab\\T\\and\\N\\newline'"), 'tab\tand\nnewline');
  assert.equal(decodeString(enc.encode("'caf\u00e9')"), 0)?.value, 'caf\u00e9'); // raw UTF-8
  // raw latin1
  assert.equal(decodeString(new Uint8Array([0x27, 0x63, 0x61, 0x66, 0xe9, 0x27, 0x29]), 0)?.value, 'caf\u00e9');
});

test('string end detection', () => {
  const b = bytesOf("'a' , 'b'");
  assert.equal(stringEnd(b, 0), 3);
  assert.equal(stringEnd(bytesOf("'x' /* c */ )"), 0), 3);
  // No lone quote is followed by a delimiter: the strict rule applies.
  assert.equal(stringEnd(bytesOf("'x'y;"), 0), 3);
  assert.equal(stringEnd(bytesOf("'never closed"), 0), -1);
});
