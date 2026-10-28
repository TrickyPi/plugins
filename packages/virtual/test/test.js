const path = require('path');

const virtual = require('..');

test('loads a bare module ID from memory', () => {
  const plugin = virtual({
    foo: 'export default 42'
  });

  const resolved = plugin.resolveId('foo');

  expect(resolved).toBe('\0virtual:foo');
  expect(plugin.load(resolved)).toBe('export default 42');
});

test('loads an absolute path from memory', () => {
  const plugin = virtual({
    'src/foo.js': 'export default 42'
  });

  const resolved = plugin.resolveId('./foo.js', 'src/main.js');

  expect(resolved).toBe(`\0virtual:${path.resolve('src/foo.js')}`);
  expect(plugin.load(resolved)).toBe('export default 42');
});

test('loads a module imported with import attributes from memory', () => {
  const plugin = virtual({
    foo: 'export default 42'
  });

  const rawId = plugin.resolveId('foo');
  const id = `${rawId}?attributes=${encodeURIComponent(JSON.stringify({ foo: 'bar' }))}`;

  expect(plugin.load(id, { rawId })).toBe('export default 42');
});
