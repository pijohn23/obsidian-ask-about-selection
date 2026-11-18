// Builds the plugin into dist/ (main.js, manifest.json, styles.css) and the test modules into .test-build/.
const fs=require('node:fs'), path=require('node:path'), esbuild=require('esbuild');
const root=path.resolve(__dirname,'..');
(async()=>{
 await esbuild.build({entryPoints:[path.join(root,'src/main.ts')],bundle:true,platform:'node',format:'cjs',target:'es2022',external:['obsidian','electron','@codemirror/*'],outfile:path.join(root,'dist/main.js')});
 for(const n of ['manifest.json','styles.css'])fs.copyFileSync(path.join(root,n),path.join(root,'dist',n));
 for(const n of ['core','backend','composer','selection-ui'])await esbuild.build({entryPoints:[path.join(root,`src/${n}.ts`)],bundle:true,platform:'node',format:'cjs',target:'es2022',outfile:path.join(root,`.test-build/${n}.cjs`)});
 console.log('Build completed: dist and four test modules.');
})().catch(e=>{console.error(e);process.exitCode=1;});
