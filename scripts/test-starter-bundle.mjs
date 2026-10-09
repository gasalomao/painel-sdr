import esbuild from 'esbuild';
import { getCleanStarterFiles, getStarterFiles } from './src/lib/sites/starter.ts';

async function testBundle(files) {
  const plugin = {
    name: 'virtual',
    setup(b) {
      b.onResolve({ filter: /.*/ }, a => {
        if (['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'lucide-react'].includes(a.path)) {
          return { path: a.path, external: true };
        }
        let p = a.path.replace(/^\.\//, '');
        if (a.importer) {
          const dir = a.importer.replace(/\/[^/]+$/, '');
          p = (dir ? dir + '/' : '') + a.path.replace(/^\.\//, '');
        }
        if (!files[p]) {
          for (const ext of ['.tsx', '.ts', '.css', '.json']) {
            if (files[p + ext]) { p += ext; break; }
          }
        }
        return { path: p, namespace: 'v' };
      });
      b.onLoad({ filter: /.*/, namespace: 'v' }, a => {
        const c = files[a.path];
        if (c === undefined) return { errors: [{ text: 'not found: ' + a.path }] };
        const loader = a.path.endsWith('.css') ? 'css' : a.path.endsWith('.json') ? 'json' : a.path.endsWith('.tsx') ? 'tsx' : a.path.endsWith('.ts') ? 'ts' : 'js';
        return { contents: c, loader };
      });
    }
  };

  const res = await esbuild.build({
    entryPoints: ['src/main.tsx'],
    bundle: true,
    format: 'esm',
    outfile: 'bundle.js',
    plugins: [plugin],
    write: false
  });

  console.log('Bundle success! Output files count:', res.outputFiles.length);
  for (const f of res.outputFiles) {
    console.log(` - ${f.path.split(/[\\/]/).pop()}: ${f.text.length} chars`);
  }
}

console.log('Testing CleanStarterFiles...');
await testBundle(getCleanStarterFiles({ name: 'Casa do Agricultor' }));

console.log('\nTesting StarterFiles...');
await testBundle(getStarterFiles({ name: 'Casa do Agricultor', cta: { type: 'whatsapp', value: '11999999999' } }));
