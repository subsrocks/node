/**
 * Builds the ffmpeg the macOS program brings: ffmpeg and ffprobe for the Mac it runs on, from the
 * sources Debian 13 builds the image's ffmpeg from (its source packages' original tarballs, at the
 * versions the image has, each checked by SHA-256), so a render made on a Mac draws its subtitles
 * as one made in the image or by subs.rocks: libass picking fonts with fontconfig, from the render's
 * fonts alone, where Homebrew's libass asks macOS's font system. With VideoToolbox, Apple's video
 * encoders and decoders, and the CPU encoders a render uses. Static, but for macOS's own libraries
 * and frameworks, so it runs on any Mac from macOS 13 on.
 *
 *   node scripts/ffmpeg.ts <dir>              ffmpeg and ffprobe in <dir>/bin, with their licenses
 *   node scripts/ffmpeg.ts --sources <dir>    the sources alone, as a release attaches them
 *
 * Needs Xcode's command line tools, CMake, Meson, Ninja and pkg-config, and NASM on an Intel Mac
 * (`brew install cmake meson ninja pkgconf nasm`). WORK_DIR keeps the downloads and the build.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Source = { name: string; version: string; file: string; sha256: string; urls: string[] };

/** A Debian source package's original tarball: from Debian, else from its archive's snapshot. */
function debian(path: string): string[] {
  return [
    `https://deb.debian.org/debian/pool/main/${path}`,
    `https://snapshot.debian.org/archive/debian/20261001T000000Z/pool/main/${path}`,
  ];
}

/** What it's built from: Debian 13's versions (libunibreak from its own release, which configures). */
export const SOURCES: readonly Source[] = [
  {
    name: 'brotli',
    version: '1.1.0',
    file: 'brotli_1.1.0.orig.tar.gz',
    sha256: '10973f4b4199eafa1d5735ef661ddb2ec2f97319ee9fd1824d4aabe08cff5265',
    urls: debian('b/brotli/brotli_1.1.0.orig.tar.gz'),
  },
  {
    name: 'expat',
    version: '2.7.1',
    file: 'expat_2.7.1.orig.tar.gz',
    sha256: '85372797ff0673a8fc4a6be16466bb5a0ca28c0dcf3c6f7ac1686b4a3ba2aabb',
    urls: debian('e/expat/expat_2.7.1.orig.tar.gz'),
  },
  {
    name: 'freetype',
    version: '2.13.3',
    file: 'freetype_2.13.3+dfsg.orig.tar.xz',
    sha256: '686ec73cbf6783b245dd068a09ce807b729ac0f8a46dd70f7867923c32fdf4de',
    urls: debian('f/freetype/freetype_2.13.3+dfsg.orig.tar.xz'),
  },
  {
    name: 'harfbuzz',
    version: '10.2.0',
    file: 'harfbuzz_10.2.0.orig.tar.xz',
    sha256: '620e3468faec2ea8685d32c46a58469b850ef63040b3565cde05959825b48227',
    urls: debian('h/harfbuzz/harfbuzz_10.2.0.orig.tar.xz'),
  },
  {
    name: 'fribidi',
    version: '1.0.16',
    file: 'fribidi_1.0.16.orig.tar.xz',
    sha256: '1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c',
    urls: debian('f/fribidi/fribidi_1.0.16.orig.tar.xz'),
  },
  {
    name: 'libunibreak',
    version: '6.1',
    file: 'libunibreak-6.1.tar.gz',
    sha256: 'cc4de0099cf7ff05005ceabff4afed4c582a736abc38033e70fdac86335ce93f',
    urls: [
      'https://github.com/adah1972/libunibreak/releases/download/libunibreak_6_1/libunibreak-6.1.tar.gz',
    ],
  },
  {
    name: 'fontconfig',
    version: '2.15.0',
    file: 'fontconfig_2.15.0.orig.tar.xz',
    sha256: '63a0658d0e06e0fa886106452b58ef04f21f58202ea02a94c39de0d3335d7c0e',
    urls: debian('f/fontconfig/fontconfig_2.15.0.orig.tar.xz'),
  },
  {
    name: 'libass',
    version: '0.17.3',
    file: 'libass_0.17.3.orig.tar.xz',
    sha256: 'eae425da50f0015c21f7b3a9c7262a910f0218af469e22e2931462fed3c50959',
    urls: debian('liba/libass/libass_0.17.3.orig.tar.xz'),
  },
  {
    name: 'x264',
    version: '0.164.3108',
    file: 'x264_0.164.3108+git31e19f9.orig.tar.gz',
    sha256: '41606cb8e788a7f8c4514290646d4ba5c7bc68d9e1ccd1a73f446a90546913eb',
    urls: debian('x/x264/x264_0.164.3108+git31e19f9.orig.tar.gz'),
  },
  {
    name: 'x265',
    version: '4.1',
    file: 'x265_4.1.orig.tar.xz',
    sha256: '85abb8a850000bf693947459c42a666a3ecd6de10a2ac6b3c6647554b14d3270',
    urls: debian('x/x265/x265_4.1.orig.tar.xz'),
  },
  {
    name: 'svt-av1',
    version: '2.3.0',
    file: 'svt-av1_2.3.0+dfsg.orig.tar.xz',
    sha256: '815e88cc539c41b8ebd1a6f362f82ab510147635fc6c3edfa35edcfbed302cd8',
    urls: debian('s/svt-av1/svt-av1_2.3.0+dfsg.orig.tar.xz'),
  },
  {
    name: 'dav1d',
    version: '1.5.1',
    file: 'dav1d_1.5.1.orig.tar.xz',
    sha256: '401813f1f89fa8fd4295805aa5284d9aed9bc7fc1fdbe554af4292f64cbabe21',
    urls: debian('d/dav1d/dav1d_1.5.1.orig.tar.xz'),
  },
  {
    name: 'ffmpeg',
    version: '7.1.5',
    file: 'ffmpeg_7.1.5.orig.tar.xz',
    sha256: 'de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f',
    urls: debian('f/ffmpeg/ffmpeg_7.1.5.orig.tar.xz'),
  },
];

const args = process.argv.slice(2);
const sourcesOnly = args[0] === '--sources';
const target = resolve(sourcesOnly ? (args[1] ?? '') : (args[0] ?? ''));
if ((sourcesOnly ? args[1] : args[0]) === undefined) {
  console.error('usage: node scripts/ffmpeg.ts <dir> | --sources <dir>');
  process.exit(2);
}
const work = resolve(process.env['WORK_DIR'] ?? join(tmpdir(), 'subs-node-ffmpeg'));
const downloads = join(work, 'downloads');
mkdirSync(downloads, { recursive: true });

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A source's tarball, downloaded once and checked. */
function fetch(source: Source): string {
  const path = join(downloads, source.file);
  if (existsSync(path) && sha256(path) === source.sha256) return path;
  for (const url of source.urls) {
    try {
      execFileSync('curl', ['-fsSL', '--retry', '3', '-o', path, url], { stdio: 'inherit' });
    } catch {
      continue;
    }
    if (sha256(path) === source.sha256) return path;
    console.error(`${url} isn't the ${source.name} it should be (its SHA-256 differs)`);
  }
  throw new Error(`couldn't download ${source.name} ${source.version}`);
}

if (sourcesOnly) {
  mkdirSync(target, { recursive: true });
  for (const source of SOURCES) cpSync(fetch(source), join(target, source.file));
  cpSync(import.meta.filename, join(target, 'ffmpeg.ts'));
  console.log(`sources in ${target}`);
  process.exit(0);
}

if (process.platform !== 'darwin')
  throw new Error('this builds the macOS program’s ffmpeg, on a Mac');
const intel = process.arch === 'x64';
const prefix = join(work, `prefix-${process.arch}`);
const builds = join(work, `build-${process.arch}`);
rmSync(prefix, { recursive: true, force: true });
rmSync(builds, { recursive: true, force: true });
mkdirSync(builds, { recursive: true });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  MACOSX_DEPLOYMENT_TARGET: '13.0',
  // Its own libraries only: none of Homebrew's, which a runner or a Mac may have.
  PKG_CONFIG_LIBDIR: join(prefix, 'lib/pkgconfig'),
  PKG_CONFIG_PATH: '',
  CFLAGS: `-O2 -I${join(prefix, 'include')}`,
  CXXFLAGS: `-O2 -I${join(prefix, 'include')}`,
  LDFLAGS: `-L${join(prefix, 'lib')}`,
};
const jobs = String(Number(execFileSync('sysctl', ['-n', 'hw.ncpu'], { encoding: 'utf8' })) || 4);

function sh(cwd: string, command: string, ...rest: string[]): void {
  execFileSync(command, rest, { cwd, env, stdio: 'inherit' });
}

/** A source unpacked into its own folder, returned. */
function unpack(name: string): string {
  const source = SOURCES.find((s) => s.name === name);
  if (!source) throw new Error(`no source ${name}`);
  const dir = join(builds, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'tar', '-xf', fetch(source), '--strip-components=1');
  console.log(`\n▸ ${source.name} ${source.version}`);
  return dir;
}

function meson(dir: string, ...options: string[]): void {
  sh(
    dir,
    'meson',
    'setup',
    'build',
    `--prefix=${prefix}`,
    '--libdir=lib',
    '--buildtype=release',
    '--default-library=static',
    '-Db_ndebug=true',
    ...options,
  );
  sh(dir, 'meson', 'compile', '-C', 'build');
  sh(dir, 'meson', 'install', '-C', 'build');
}

function cmake(dir: string, source: string, ...options: string[]): void {
  sh(
    dir,
    'cmake',
    '-S',
    source,
    '-B',
    'build',
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    '-DCMAKE_INSTALL_LIBDIR=lib',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    ...options,
  );
  sh(dir, 'cmake', '--build', 'build');
  sh(dir, 'cmake', '--install', 'build');
}

function configure(dir: string, ...options: string[]): void {
  sh(dir, './configure', `--prefix=${prefix}`, ...options);
  sh(dir, 'make', `-j${jobs}`);
  sh(dir, 'make', 'install');
}

// Fonts and text: FreeType (WOFF2 needs Brotli), HarfBuzz on it, FriBidi, fontconfig, libass.
cmake(unpack('brotli'), '.', '-DBROTLI_DISABLE_TESTS=ON');
cmake(
  unpack('expat'),
  'expat',
  '-DEXPAT_BUILD_TOOLS=OFF',
  '-DEXPAT_BUILD_EXAMPLES=OFF',
  '-DEXPAT_BUILD_TESTS=OFF',
  '-DEXPAT_BUILD_DOCS=OFF',
  '-DEXPAT_SHARED_LIBS=OFF',
);
meson(
  unpack('freetype'),
  '-Dbrotli=enabled',
  '-Dzlib=system',
  '-Dpng=disabled',
  '-Dbzip2=disabled',
  '-Dharfbuzz=disabled',
  '-Dtests=disabled',
);
meson(
  unpack('harfbuzz'),
  '-Dfreetype=enabled',
  '-Dglib=disabled',
  '-Dgobject=disabled',
  '-Dcairo=disabled',
  '-Dchafa=disabled',
  '-Dicu=disabled',
  '-Dtests=disabled',
  '-Dintrospection=disabled',
  '-Ddocs=disabled',
  '-Dutilities=disabled',
);
meson(unpack('fribidi'), '-Ddocs=false', '-Dbin=false', '-Dtests=false');
configure(unpack('libunibreak'), '--disable-shared', '--enable-static');
meson(
  unpack('fontconfig'),
  '-Ddoc=disabled',
  '-Dnls=disabled',
  '-Dtests=disabled',
  '-Dtools=disabled',
  '-Dcache-build=disabled',
);
meson(
  unpack('libass'),
  '-Dfontconfig=enabled',
  '-Dcoretext=disabled',
  '-Ddirectwrite=disabled',
  '-Dlibunibreak=enabled',
  '-Drequire-system-font-provider=true',
  intel ? '-Dasm=enabled' : '-Dasm=auto',
);

// The encoders and AV1's decoder.
configure(
  unpack('x264'),
  '--enable-static',
  '--disable-cli',
  '--enable-pic',
  '--disable-opencl',
  '--bit-depth=all',
);
{
  // x265 at 8 and 10 bits in one library, as Debian's and Homebrew's are. CMake 4 refuses the
  // old behaviour 4.1 asks of two policies, and names Apple's Clang `AppleClang`, not `Clang`.
  const dir = unpack('x265');
  const lists = join(dir, 'source/CMakeLists.txt');
  writeFileSync(
    lists,
    readFileSync(lists, 'utf8')
      .replace(/cmake_policy\(SET CMP0025 OLD\)/, '')
      .replace(/cmake_policy\(SET CMP0054 OLD\)/, '')
      .replace(/(\$\{CMAKE_CXX_COMPILER_ID\}) STREQUAL "Clang"/, '$1 MATCHES "Clang"'),
  );
  const common = ['-DENABLE_SHARED=OFF', '-DENABLE_CLI=OFF'];
  sh(
    dir,
    'cmake',
    '-S',
    'source',
    '-B',
    '10bit',
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    '-DHIGH_BIT_DEPTH=ON',
    '-DEXPORT_C_API=OFF',
    ...common,
  );
  sh(dir, 'cmake', '--build', '10bit');
  mkdirSync(join(dir, '8bit'), { recursive: true });
  cpSync(join(dir, '10bit/libx265.a'), join(dir, '8bit/libx265_main10.a'));
  sh(
    dir,
    'cmake',
    '-S',
    'source',
    '-B',
    '8bit',
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    '-DCMAKE_INSTALL_LIBDIR=lib',
    '-DLINKED_10BIT=ON',
    '-DEXTRA_LINK_FLAGS=-L.',
    '-DEXTRA_LIB=x265_main10.a',
    ...common,
  );
  sh(dir, 'cmake', '--build', '8bit');
  const eight = join(dir, '8bit');
  cpSync(join(eight, 'libx265.a'), join(eight, 'libx265_main.a'));
  sh(eight, 'libtool', '-static', '-o', 'libx265.a', 'libx265_main.a', 'libx265_main10.a');
  sh(dir, 'cmake', '--install', '8bit');
}
cmake(
  unpack('svt-av1'),
  '.',
  '-DBUILD_APPS=OFF',
  '-DBUILD_DEC=OFF',
  '-DBUILD_TESTING=OFF',
  '-DSVT_AV1_LTO=OFF',
);
meson(unpack('dav1d'), '-Denable_tools=false', '-Denable_tests=false', '-Denable_examples=false');

// ffmpeg: what a render reads, draws and encodes, and nothing it doesn't need.
const ffmpeg = unpack('ffmpeg');
configure(
  ffmpeg,
  '--pkg-config-flags=--static',
  `--extra-cflags=-I${join(prefix, 'include')}`,
  `--extra-ldflags=-L${join(prefix, 'lib')}`,
  '--enable-gpl',
  '--enable-static',
  '--disable-shared',
  '--disable-debug',
  '--disable-doc',
  '--disable-ffplay',
  '--disable-autodetect',
  '--enable-videotoolbox',
  '--enable-audiotoolbox',
  '--enable-securetransport',
  '--enable-zlib',
  '--enable-bzlib',
  '--enable-iconv',
  '--enable-libass',
  '--enable-libfreetype',
  '--enable-libfribidi',
  '--enable-libharfbuzz',
  '--enable-libfontconfig',
  '--enable-libx264',
  '--enable-libx265',
  '--enable-libsvtav1',
  '--enable-libdav1d',
);

// Out: the two tools, stripped, their licenses, and what they were built from.
const bin = join(target, 'bin');
rmSync(target, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });
for (const tool of ['ffmpeg', 'ffprobe']) {
  cpSync(join(prefix, 'bin', tool), join(bin, tool));
  sh(bin, 'strip', tool);
  // Stripping undoes the linker's ad hoc signature, without which Apple silicon won't run it.
  sh(bin, 'codesign', '--sign', '-', '--force', tool);
  // Linked against macOS's own libraries alone, so it runs on any Mac.
  const linked = execFileSync('otool', ['-L', join(bin, tool)], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0] ?? '')
    .filter(Boolean);
  const foreign = linked.filter((lib) => !/^\/(usr\/lib|System\/Library)\//.test(lib));
  if (foreign.length > 0) throw new Error(`${tool} links ${foreign.join(', ')}`);
}
cpSync(join(ffmpeg, 'COPYING.GPLv2'), join(target, 'COPYING.GPLv2'));
writeFileSync(
  join(target, 'SOURCES'),
  [
    'ffmpeg and ffprobe, built by subsrocks/node (scripts/ffmpeg.ts) from these sources, which each',
    'release of it attaches (ffmpeg-sources.tar). GPL-2.0-or-later, as x264 and x265 make it.',
    '',
    ...SOURCES.map((s) => `${s.name} ${s.version}  ${s.file}  sha256:${s.sha256}`),
    '',
  ].join('\n'),
);
console.log(`\nffmpeg for macOS ${process.arch} in ${target}`);
