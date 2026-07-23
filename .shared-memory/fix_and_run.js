const fs = require('fs');
const path = require('path');

const scriptPath = 'C:\\Users\\Salomao\\.gemini\\antigravity-ide\\brain\\1281d198-f7ea-4836-94e6-dcc96281cf3c\\scratch\\apply_refactor.js';

let content = fs.readFileSync(scriptPath, 'utf8');

// Replace {`{URL}`} with {"{URL}"}
// Replace {`{instance}`} with {"{instance}"}
content = content.replace(/\{`\{URL\}`\}/g, '{"{URL}"}');
content = content.replace(/\{`\{instance\}`\}/g, '{"{instance}"}');

// Replace raw backticks in line 936
content = content.replace(/ligado\{pxStatus\.accounts\.length \? ` · \\\$\{pxStatus\.accounts\.length\} conta\(s\) logada\(s\)` : ""\}/g, 'ligado{pxStatus.accounts.length ? " · " + pxStatus.accounts.length + " conta(s) logada(s)" : ""}');

fs.writeFileSync(scriptPath, content, 'utf8');
console.log('Fixed apply_refactor.js. Attempting to run it...');

try {
  require(scriptPath);
  console.log('apply_refactor.js executed successfully!');
} catch (err) {
  console.error('Error executing apply_refactor.js:', err);
}
