export function parseTraceJson(text: string, maxDepth = 64, maxNodes = 200000): unknown {
  let position = 0,
    nodes = 0;
  function whitespace() {
    while (/[ \t\r\n]/.test(text[position] ?? '') && position < text.length) position++;
  }
  function string(): string {
    const start = position++;
    for (; position < text.length; position++) {
      if (text[position] === '\\') {
        position++;
        continue;
      }
      if (text[position] === '"') {
        const decoded = JSON.parse(text.slice(start, ++position)) as string;
        for (let index = 0; index < decoded.length; index++) {
          const code = decoded.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const low = decoded.charCodeAt(++index);
            if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error('invalid_json');
          } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('invalid_json');
        }
        return decoded;
      }
    }
    throw new Error('invalid_json');
  }
  function value(depth: number): unknown {
    if (depth > maxDepth || ++nodes > maxNodes) throw new Error('invalid_json');
    whitespace();
    const character = text[position];
    if (character === '"') return string();
    if (character === '{' || character === '[') {
      const object = character === '{';
      position++;
      whitespace();
      const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const array: unknown[] = [];
      const end = object ? '}' : ']';
      if (text[position] === end) {
        position++;
        return object ? entries : array;
      }
      for (;;) {
        whitespace();
        let key = '';
        if (object) {
          if (text[position] !== '"') throw new Error('invalid_json');
          key = string();
          whitespace();
          if (Object.hasOwn(entries, key) || text[position++] !== ':')
            throw new Error('invalid_json');
        }
        const item = value(depth + 1);
        if (object) Object.defineProperty(entries, key, { value: item, enumerable: true });
        else array.push(item);
        whitespace();
        const separator = text[position++];
        if (separator === end) return object ? entries : array;
        if (separator !== ',') throw new Error('invalid_json');
      }
    }
    const matched = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(position),
    );
    if (!matched) throw new Error('invalid_json');
    position += matched[0].length;
    return JSON.parse(matched[0]);
  }
  const result = value(0);
  whitespace();
  if (position !== text.length) throw new Error('invalid_json');
  return result;
}
