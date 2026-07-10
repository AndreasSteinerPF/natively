import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const nativelyInterfaceSourcePath = path.resolve(repoRoot, 'src/components/NativelyInterface.tsx');

test('NativelyInterface renders newest messages at the top without reversing stored message history', async () => {
  const source = await fs.readFile(nativelyInterfaceSourcePath, 'utf8');

  assert.match(source, /const displayMessagesNewestFirst = useMemo/);
  assert.match(source, /return \[\.\.\.displayMessages\]\.reverse\(\);/);
  assert.match(source, /displayMessagesNewestFirst\.map\(\(msg: Message\) =>/);
  assert.doesNotMatch(source, /setMessages\(\(prev\)\s*=>\s*\[\s*[^,\]]+,\s*\.\.\.prev/s);
});
