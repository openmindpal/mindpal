const fs = require('fs');

function findDuplicateKeys(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split('\n');
  const keys = new Map();
  const dups = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*"([^"]+)"\s*:/);
    if (m) {
      const k = m[1];
      if (keys.has(k)) {
        dups.push({ key: k, first: keys.get(k), second: i + 1 });
      } else {
        keys.set(k, i + 1);
      }
    }
  });
  return dups;
}

console.log('=== zh-CN.json ===');
const zhDups = findDuplicateKeys('src/locales/zh-CN.json');
if (zhDups.length === 0) {
  console.log('No duplicates found');
} else {
  zhDups.forEach(d => console.log(`DUPLICATE: "${d.key}" at lines ${d.first} and ${d.second}`));
}

console.log('\n=== en-US.json ===');
const enDups = findDuplicateKeys('src/locales/en-US.json');
if (enDups.length === 0) {
  console.log('No duplicates found');
} else {
  enDups.forEach(d => console.log(`DUPLICATE: "${d.key}" at lines ${d.first} and ${d.second}`));
}

console.log(`\nTotal: zh-CN has ${zhDups.length} duplicates, en-US has ${enDups.length} duplicates`);
