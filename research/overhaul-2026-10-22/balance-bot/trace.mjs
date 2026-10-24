/* 1ゲームの経過を表示：node trace.mjs <level> <seed> [--html path] [--patch file] [--overrides json] [--max-turns 60] */
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module"; import { pathToFileURL, fileURLToPath } from "node:url";
const HERE=path.dirname(fileURLToPath(import.meta.url));
const {chromium}=(()=>{try{return createRequire(path.join(HERE,"../../../mcp/package.json"))("playwright")}catch{return createRequire(import.meta.url)("playwright")}})();
const argv=process.argv.slice(2); const opt=(k,d)=>{const i=argv.indexOf(`--${k}`);return i>=0?argv[i+1]:d};
const HTML=path.resolve(opt("html",path.join(HERE,"../../../game/frontier-war.html"))), APIJS=path.resolve(opt("api",[path.join(path.dirname(HTML),"../mcp-src/game-api.js"),path.join(path.dirname(HTML),"../mcp/game-api.js")].find(p=>fs.existsSync(p))));
const run=fs.readFileSync(path.join(HERE,"run.mjs"),"utf8"); const seedjs=run.match(/const SEEDJS = \(\) => \{([\s\S]*?)\n\};/)[1];
let PLAY=HTML;
if(opt("tune")){let src=fs.readFileSync(HTML,"utf8");for(const tf of opt("tune").split(",")){for(const e of JSON.parse(fs.readFileSync(tf,"utf8")).edits){if(src.split(e.find).length!==2)throw new Error("tune mismatch "+e.find.slice(0,60));src=src.replace(e.find,()=>e.replace)}}
  const dir=path.join(HERE,"tuned","_trace");fs.mkdirSync(dir,{recursive:true});for(const d of["art","audio"]){const l=path.join(dir,d);if(!fs.existsSync(l))fs.symlinkSync(path.join(path.dirname(HTML),d),l)}PLAY=path.join(dir,"frontier-war.html");fs.writeFileSync(PLAY,src)}
const browser=await chromium.launch({headless:true}); const page=await browser.newPage();
page.on("pageerror",e=>console.log("PAGEERR",e.message));
await page.addInitScript("(()=>{"+seedjs+"})()");
await page.goto(pathToFileURL(PLAY).href+"?seed="+(argv[1]||1000));
await page.addScriptTag({content:fs.readFileSync(APIJS,"utf8").replace("const sleep=ms=>new Promise(r=>setTimeout(r,ms));","const sleep=ms=>new Promise(r=>setTimeout(r,window.__BOTFAST?0:ms));")});
await page.addScriptTag({content:fs.readFileSync(path.join(HERE,"bot.js"),"utf8")});
if(opt("patch"))await page.addScriptTag({content:fs.readFileSync(opt("patch"),"utf8")});
const rec=await page.evaluate(o=>BOT.play(o),{level:argv[0]||"normal",seed:Number(argv[1]||1000),maxTurns:Number(opt("max-turns",60)),trace:true,overrides:JSON.parse(opt("overrides","{}"))});
console.log(rec.trace.join("\n"));
console.log("RESULT",rec.result,rec.endTurn,"errors",rec.errors);
for(const b of rec.battles)console.log(`T${b.t} ${b.kind} ${b.foe}${b.doc?"("+b.doc+")":""} ${b.attack?"攻":"守"} ${b.form} → ${b.result} ${b.rounds}R 自${b.myHp0}->${b.myHp1} 敵${b.foeHp0}->${b.foeHp1}${b.coreHp0!=null?` 中枢${b.coreHp0}->${b.coreHp1}`:""}`);
await browser.close();
