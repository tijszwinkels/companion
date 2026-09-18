// markdown-it 15.0.2 (MIT), bundled for Qt. See markdown-it.LICENSE and README.md.
// Decode the browser bundle's static base64 entity tables as binary strings.
// Qt.atob(string) decodes UTF-8 instead, which corrupts bytes above 127.
function atob(source) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let buffer = 0;
  let bits = 0;
  let result = '';
  for (const character of source) {
    const value = alphabet.indexOf(character);
    if (value < 0) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return result;
}
