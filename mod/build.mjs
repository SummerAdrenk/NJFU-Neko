#!/usr/bin/env node
// 编译“NJFU智慧猫娘 面板”模组。不需要 Gradle：26.x 的游戏本体不再混淆，直接用游戏自带的库和 Fabric API 编译。
//
// 用法：node mod/build.mjs --game "<.minecraft>/versions/<版本名>" [--jdk "<JDK 目录>"]
//   --game  装了 Fabric 的游戏版本目录（里面有 <版本名>.json、<版本名>.jar 和 mods/fabric-api-*.jar）
//   --jdk   JDK 25 以上的目录（默认用 PATH 里的 javac）
// 产物：mod/dist/njfu-neko-panel-<版本>.jar，放进游戏的 mods 文件夹即可。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const game = opt('game') ?? process.env.NEKO_GAME_DIR;
if (!game) {
  console.error('请用 --game 指定游戏版本目录，例如：node mod/build.mjs --game "D:/Game/.minecraft/versions/26.2-Fabric 0.19.5"');
  process.exit(1);
}
const jdk = opt('jdk') ?? process.env.NEKO_JDK;
const tool = (name) => (jdk ? path.join(jdk, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name);

const versionDir = path.resolve(game);
const versionName = path.basename(versionDir);
const mcRoot = path.resolve(versionDir, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(versionDir, `${versionName}.json`), 'utf8'));

function libraryPath(lib) {
  if (lib.downloads?.artifact?.path) return lib.downloads.artifact.path;
  const [group, artifact, version, classifier] = lib.name.split(':');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
}
const classpath = [path.join(versionDir, `${versionName}.jar`)];
for (const lib of manifest.libraries ?? []) {
  const p = path.join(mcRoot, 'libraries', libraryPath(lib));
  if (fs.existsSync(p) && !classpath.includes(p)) classpath.push(p);
}

// Fabric API 是“套娃” jar：把里面的各个模块解出来参与编译
const modDirs = [path.join(versionDir, 'mods'), path.join(mcRoot, 'mods')];
const apiJar = modDirs.filter((d) => fs.existsSync(d)).flatMap((d) => fs.readdirSync(d).filter((f) => /^fabric-api-.*\.jar$/.test(f)).map((f) => path.join(d, f)))[0];
if (!apiJar) {
  console.error('没找到 fabric-api-*.jar，请先给这个游戏版本装上 Fabric API');
  process.exit(1);
}
fs.rmSync(BUILD, { recursive: true, force: true });
const deps = path.join(BUILD, 'deps');
fs.mkdirSync(deps, { recursive: true });
execFileSync(tool('jar'), ['xf', apiJar, 'META-INF/jars'], { cwd: deps });
const nested = path.join(deps, 'META-INF', 'jars');
for (const f of fs.readdirSync(nested)) classpath.push(path.join(nested, f));

const sources = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.java')) sources.push(p);
  }
};
walk(path.join(HERE, 'src'));

const classes = path.join(BUILD, 'classes');
fs.mkdirSync(classes, { recursive: true });
const q = (s) => `"${s.replace(/\\/g, '/')}"`;
const argfile = path.join(BUILD, 'javac.args');
fs.writeFileSync(argfile, [
  '--release', '25', '-encoding', 'UTF-8', '-proc:none', '-nowarn', '-d', q(classes),
  '-cp', q(classpath.join(path.delimiter)), ...sources.map(q),
].join('\n'));
console.log(`编译 ${sources.length} 个源文件（依赖 ${classpath.length} 个 jar）…`);
execFileSync(tool('javac'), [`@${argfile}`], { stdio: 'inherit' });

fs.cpSync(path.join(HERE, 'resources'), classes, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(HERE, 'resources', 'fabric.mod.json'), 'utf8'));
const dist = path.join(HERE, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `njfu-neko-panel-${meta.version}.jar`);
fs.rmSync(out, { force: true });
execFileSync(tool('jar'), ['--create', '--file', out, '-C', classes, '.'], { stdio: 'inherit' });
console.log(`✓ ${out}`);
