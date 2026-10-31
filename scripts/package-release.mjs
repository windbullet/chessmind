// Collects the build output into release/ as the files we upload to GitHub.
//
// Two artefacts are published side by side, because users want different
// things:
//   * ChessMind-<version>-win-x64-setup.exe — the NSIS installer (default)
//   * ChessMind-<version>-win-x64.zip       — portable, extract and run
//
// Both contain the same executable. The portable zip is assembled here; the
// installer comes out of `tauri build`. Next to each artefact we drop a
// .sha256 file so users can verify what they downloaded.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const base = `ChessMind-${version}-win-x64`;

// The two version numbers must agree or the release is labelled wrongly.
const tauriConf = JSON.parse(
  await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
);
if (tauriConf.version !== version) {
  console.error(
    `版本号不一致：package.json 为 ${version}，src-tauri/tauri.conf.json 为 ${tauriConf.version}`,
  );
  process.exit(1);
}

const targetRelease = join(root, 'src-tauri', 'target', 'release');
const exe = join(targetRelease, 'chessmind.exe');
const nsisDir = join(targetRelease, 'bundle', 'nsis');
const outDir = join(root, 'release');
const stage = join(outDir, base);
const zipPath = join(outDir, `${base}.zip`);
const setupPath = join(outDir, `${base}-setup.exe`);

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
    .toUpperCase();
}

async function writeHash(file) {
  const hash = await sha256(file);
  await writeFile(`${file}.sha256`, `${hash}  ${basename(file)}\n`);
  return hash;
}

// ---------------------------------------------------------------- portable zip
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await rm(zipPath, { force: true });

// 1. The executable.
await writeFile(join(stage, 'ChessMind.exe'), await readFile(exe));

// 2. Files the user (and the licence) need next to it.
for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md', 'README.en.md']) {
  await writeFile(join(stage, file), await readFile(join(root, file)));
}

// 3. A short readme the user actually sees first.
await writeFile(
  join(stage, '使用说明.txt'),
  [
    `ChessMind ${version}（免安装版）`,
    '',
    '1. 双击 ChessMind.exe 运行，无需安装。',
    '2. 首次运行请在右侧「设置」里填写接口地址、API Key 和模型名。',
    '3. 删除本文件夹即可完全卸载（配置保存在 %APPDATA%\\com.chessmind.app）。',
    '',
    '系统要求：Windows 10 1803+ / Windows 11（需要 WebView2 运行时，系统一般已内置）。',
    '',
    '如果 Windows 提示"已保护你的电脑"，这是因为本程序未购买代码签名证书：',
    '点击「更多信息」→「仍要运行」。请用 SHA256 校验本压缩包来源可信。',
    '',
    '本程序以 MIT 许可证发布，完整许可证见 LICENSE；第三方组件许可见 THIRD-PARTY-NOTICES.md。',
    '',
  ].join('\r\n'),
);

// 4. Zip it.
//
// .NET's ZipFile is the primary path: it is always available, writes the
// folder contents at the archive root, and sets the UTF-8 flag on non-ASCII
// names (so 使用说明.txt survives extraction). Compress-Archive needs a module
// that is missing on some trimmed systems, and bsdtar writes names in the ANSI
// code page, which turns them into mojibake — both are only fallbacks.
const psScript = [
  'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
  `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stage}', '${zipPath}',`,
  "  [System.IO.Compression.CompressionLevel]::Optimal, $false)",
].join('\n');

let zipped = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
  stdio: 'inherit',
});
if (zipped.status !== 0) {
  console.warn('ZipFile 打包失败，改用 Compress-Archive…');
  zipped = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  );
}
if (zipped.status !== 0) {
  console.warn('Compress-Archive 失败，改用 tar…');
  zipped = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', stage, '.'], {
    stdio: 'inherit',
  });
}
if (zipped.status !== 0) {
  console.error('打包失败：请确认 PowerShell 或 tar 可用。');
  process.exit(1);
}
const zipHash = await writeHash(zipPath);

// ------------------------------------------------------------------- installer
await rm(setupPath, { force: true });
let setupHash = null;
try {
  const candidates = (await readdir(nsisDir)).filter((f) => f.toLowerCase().endsWith('.exe'));
  // The bundle directory keeps installers from previous versions, so pick ours
  // by version instead of trusting "there is exactly one file here".
  const wanted = `ChessMind_${version}_x64-setup.exe`.toLowerCase();
  const match = candidates.find((f) => f.toLowerCase() === wanted);
  if (!match) {
    throw new Error(
      `expected ${wanted} in ${nsisDir}, found ${
        candidates.length ? candidates.join(', ') : 'nothing'
      }`,
    );
  }
  await copyFile(join(nsisDir, match), setupPath);
  setupHash = await writeHash(setupPath);
} catch (err) {
  console.error(`未找到安装包（${err.message}）。`);
  console.error('请先运行 `npm run tauri build` 生成 NSIS 安装包，再重新打包。');
  process.exit(1);
}

console.log('');
console.log(`已生成 ${zipPath}`);
console.log(`  SHA256 ${zipHash}`);
console.log(`已生成 ${setupPath}`);
console.log(`  SHA256 ${setupHash}`);
console.log('');
console.log('把 release/ 下这四个文件上传到 GitHub Release 即可。');
