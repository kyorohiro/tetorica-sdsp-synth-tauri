"""Import an unmodified Synth release; pin archive and extracted file hashes."""
import argparse
import hashlib
import io
import json
import posixpath
import re
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    'index.html', 'synth-snes/index.html', 'synth-snes/synth.js',
    'synth-snes/processor.js', 'synth-snes/synth.css',
    'generated/spc_wasm.js', 'generated/spc_wasm.wasm',
    'sources/SNES-SPC.json', 'sources/SNES-SPC.md',
    'sources/sdsp-synth-browser.json', 'sources/sdsp-synth-browser-inputs.zip',
    'tetorica_sdsp_synth.webp', 'LICENSE',
    'licenses/snes-spc/LICENSE', 'licenses/snes-spc/README.md',
}
NATIVE_INPUTS = {
    'sources/SNES-SPC.md', 'sources/scripts/build_spc_wasm.sh',
    'sources/third_party/snes-spc/LICENSE',
    'sources/third_party/snes-spc/README.md',
    'sources/third_party/snes-spc/README.upstream.md',
    'sources/third_party/snes-spc/changes.txt',
    'sources/third_party/snes-spc/license.txt',
    'sources/third_party/snes-spc/readme.txt',
    'sources/third_party/snes-spc/snes_spc.txt',
    *('sources/third_party/snes-spc/snes_spc/' + name for name in [
        'SNES_SPC.cpp', 'SNES_SPC.h', 'SNES_SPC_misc.cpp', 'SNES_SPC_state.cpp',
        'SPC_CPU.h', 'SPC_DSP.cpp', 'SPC_DSP.h', 'SPC_Filter.cpp', 'SPC_Filter.h',
        'blargg_common.h', 'blargg_config.h', 'blargg_endian.h', 'blargg_source.h',
        'dsp.cpp', 'dsp.h', 'spc.cpp', 'spc.h',
    ]),
    'sources/wasm/spc_wasm.cpp',
}
BROWSER_ENTRIES = {'synth-snes/synth.js', 'synth-snes/processor.js', 'synth-snes/synth.css'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_release(destination, hashes):
    missing = REQUIRED - hashes.keys()
    if missing:
        raise ValueError('Expected S-DSP Synth ZIP; missing: ' + ', '.join(sorted(missing)))

    def verify(record, name):
        if not isinstance(record, dict):
            raise ValueError('Expected a source receipt record')
        safe_name(name)
        if name not in hashes:
            raise ValueError(f'Missing recorded release file: {name}')
        data = (destination / name).read_bytes()
        if record.get('bytes') != len(data) or record.get('sha256') != hashes[name]:
            raise ValueError(f'Release source receipt mismatch: {name}')

    def records(value, label):
        if not isinstance(value, list) or not value:
            raise ValueError(f'Expected {label} source records')
        result = {}
        for record in value:
            if not isinstance(record, dict):
                raise ValueError(f'Expected a {label} source record')
            name = safe_name(record.get('path'))
            if name in result:
                raise ValueError(f'Duplicate {label} source record: {name}')
            result[name] = record
        return result

    browser = json.loads((destination / 'sources/sdsp-synth-browser.json').read_text())
    native = json.loads((destination / 'sources/SNES-SPC.json').read_text())
    if (not isinstance(browser, dict) or not isinstance(native, dict)
            or browser.get('schemaVersion') != 1 or native.get('schemaVersion') != 1
            or browser.get('productId') != 'tetorica-sdsp-synth' or native.get('component') != 'spc'):
        raise ValueError('Expected S-DSP Synth / SNES SPC source receipts')
    builder = browser.get('builder')
    if (not isinstance(builder, dict) or builder.get('name') != 'source-copy'
            or builder.get('minify') is not False or builder.get('bundle') is not False):
        raise ValueError('Expected readable source-copy browser modules without minification or bundling')
    entries = records(browser.get('bundles'), 'browser entry')
    if entries.keys() != BROWSER_ENTRIES:
        raise ValueError('Expected complete S-DSP Synth entry receipts')
    modules = records(browser.get('modules'), 'readable browser module')
    if not BROWSER_ENTRIES <= modules.keys():
        raise ValueError('Expected all browser entries in the readable module receipts')
    original = records(browser.get('originalInputs'), 'original browser input')
    for name, record in modules.items():
        verify(record, name)
        source = original.get(safe_name(record.get('sourcePath')))
        if not source or any(record.get(key) != source.get(key) for key in ['bytes', 'sha256']):
            raise ValueError(f'Browser module differs from its original source receipt: {name}')
        imports = record.get('localImports', [])
        if not isinstance(imports, list):
            raise ValueError(f'Expected local module imports: {name}')
        for dependency in imports:
            if not isinstance(dependency, str) or not dependency.startswith(('./', '../')):
                raise ValueError(f'Expected a relative local module import: {name}')
            target = safe_name(posixpath.normpath(posixpath.join(posixpath.dirname(name), re.split(r'[?#]', dependency, maxsplit=1)[0])))
            if target not in modules and target not in {'generated/spc_wasm.js'}:
                raise ValueError(f'Missing recorded browser module dependency: {name} -> {target}')
    for name, record in entries.items():
        verify(record, name)
        if any(record.get(key) != modules[name].get(key) for key in ['bytes', 'sha256']):
            raise ValueError(f'Browser entry differs from its module receipt: {name}')
    source = browser.get('sourceArchive', {})
    if not isinstance(source, dict) or source.get('path') != 'sources/sdsp-synth-browser-inputs.zip':
        raise ValueError('Expected browser source archive receipt')
    verify(source, source['path'])
    # Check the enclosed original sources without extracting or rewriting the
    # archive. The shipped archive and its comments remain the upstream bytes.
    with zipfile.ZipFile(io.BytesIO((destination / source['path']).read_bytes())) as archive:
        archived = {}
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = safe_name(entry.filename)
            if stat.S_ISLNK(entry.external_attr >> 16) or name in archived:
                raise ValueError('Unsafe or duplicate browser source archive entry')
            data = archive.read(entry)
            archived[name] = {'bytes': len(data), 'sha256': digest(data)}
        if archived.keys() != original.keys():
            raise ValueError('Browser source archive differs from its original input list')
        for name, record in original.items():
            if any(archived[name][key] != record.get(key) for key in ['bytes', 'sha256']):
                raise ValueError(f'Browser source archive mismatch: {name}')
    generated = native.get('generated')
    if not isinstance(generated, dict):
        raise ValueError('Expected generated SNES SPC source records')
    for name in ['spc_wasm.js', 'spc_wasm.wasm']:
        verify(generated.get(name), 'generated/' + name)
    inputs = records(native.get('inputs'), 'SNES SPC native input')
    if not NATIVE_INPUTS <= inputs.keys():
        raise ValueError('Expected SNES SPC core, wrapper and build recipe source inputs')
    for name, record in inputs.items():
        verify(record, name)
    for name in ['LICENSE', 'README.md']:
        notice = destination / 'licenses/snes-spc' / name
        original_notice = destination / 'sources/third_party/snes-spc' / name
        if notice.read_bytes() != original_notice.read_bytes():
            raise ValueError(f'SNES SPC license notice differs from its native source copy: {name}')

def unpack(archive, destination):
    hashes = {}
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        for entry in entries:
            safe_name(entry.filename.rstrip('/') if entry.is_dir() else entry.filename)
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError(f'Unsafe ZIP entry: {entry.filename}')
        for entry in entries:
            if entry.is_dir():
                continue
            name = str(PurePosixPath(entry.filename))
            if name in hashes:
                raise ValueError(f'Duplicate ZIP entry: {name}')
            data = source.read(entry)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            hashes[name] = digest(data)
    validate_release(destination, hashes)
    return hashes


LOCAL_REQUIRED = {'index.html', 'synth-snes/synth.js'}
LOCAL_MANIFEST = 'local-changes.json'


def safe_name(name):
    if not isinstance(name, str) or not name or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError('Expected a safe relative release file path')
    path = PurePosixPath(name)
    if (path.is_absolute() or name != path.as_posix() or '..' in path.parts
            or name == '.' or '\\' in name or ':' in name):
        raise ValueError(f'Unsafe local change path: {name}')
    return name


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def snapshot_dist(root):
    directory = root / 'dist'
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Expected a real dist directory')
    hashes = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlinks are not release files: {path.relative_to(directory)}')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f'Expected a regular release file: {path.relative_to(directory)}')
        name = safe_name(path.relative_to(directory).as_posix())
        hashes[name] = digest(path.read_bytes())
    return hashes


def baseline_files(lock):
    files = lock.get('files') if isinstance(lock, dict) else None
    if not isinstance(files, dict) or not valid_hash(lock.get('sha256')):
        raise ValueError('Expected a pinned release SHA-256 and file hashes')
    for name, sha in files.items():
        safe_name(name)
        if not valid_hash(sha):
            raise ValueError(f'Invalid imported file SHA-256: {name}')
    return files


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate local manifest property: {key}')
        result[key] = value
    return result


def local_changes(root, lock):
    path = root / LOCAL_MANIFEST
    if path.is_symlink():
        raise ValueError('Local change manifest must not be a symlink')
    if not path.exists():
        return None
    baseline = baseline_files(lock)
    manifest = json.loads(path.read_text(), object_pairs_hook=unique_object)
    if (not isinstance(manifest, dict) or set(manifest) != {'schemaVersion', 'baseSha256', 'files'}
            or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1
            or not isinstance(manifest['files'], dict)):
        raise ValueError('Invalid local change manifest schema')
    if manifest['baseSha256'] != lock['sha256']:
        raise ValueError('Local changes belong to a different imported release; import and reapply edits')
    for name, sha in manifest['files'].items():
        safe_name(name)
        if sha is None:
            if name not in baseline:
                raise ValueError(f'Cannot delete an unknown imported file: {name}')
        elif not valid_hash(sha):
            raise ValueError(f'Invalid local file SHA-256: {name}')
    return manifest


def require_entries(files):
    missing = LOCAL_REQUIRED - files.keys()
    if missing:
        raise ValueError('Local edits must keep application entry files: ' + ', '.join(sorted(missing)))


def record_local_changes(root):
    lock = json.loads((root / 'release.lock.json').read_text())
    baseline = baseline_files(lock)
    local_changes(root, lock)  # Reject stale or malformed records before replacing them.
    actual = snapshot_dist(root)
    require_entries(actual)
    changes = {name: actual.get(name) for name in sorted(baseline.keys() | actual.keys())
               if actual.get(name) != baseline.get(name)}
    manifest = {'schemaVersion': 1, 'baseSha256': lock['sha256'], 'files': changes}
    destination = root / LOCAL_MANIFEST
    if changes:
        with tempfile.TemporaryDirectory(prefix='.local-edits-', dir=root) as temporary:
            staging = Path(temporary) / LOCAL_MANIFEST
            staging.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
            staging.replace(destination)
        print(f"Recorded {len(changes)} local changes over Synth {lock['version']}; imported release hashes kept")
    else:
        destination.unlink(missing_ok=True)
        print(f"Restored imported Synth {lock['version']}; no local changes")
    return manifest


def check(root):
    lock = json.loads((root / 'release.lock.json').read_text())
    actual = snapshot_dist(root)
    manifest = local_changes(root, lock)
    expected = dict(lock['files'])
    if manifest is not None:
        for name, sha in manifest['files'].items():
            if sha is None:
                expected.pop(name)
            else:
                expected[name] = sha
        require_entries(actual)
    if actual != expected:
        raise ValueError('dist has unrecorded changes; run npm run record:edits or import the pinned ZIP again')
    return lock


def import_release(root, archive):
    if not archive.is_file():
        raise FileNotFoundError(f'Synth release ZIP not found: {archive}')
    sha = digest(archive.read_bytes())
    previous = root / 'release.lock.json'
    old_lock = json.loads(previous.read_text()) if previous.exists() else {}
    version = old_lock.get('version') if old_lock.get('sha256') == sha else f'sha256-{sha[:12]}'
    with tempfile.TemporaryDirectory(prefix='.import-', dir=root) as temporary:
        staging = Path(temporary) / 'dist'
        staging.mkdir()
        hashes = unpack(archive, staging)
        if old_lock.get('sha256') != sha:
            browser = json.loads((staging / 'sources/sdsp-synth-browser.json').read_text())
            released_version = browser.get('version')
            if isinstance(released_version, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,79}', released_version):
                version = released_version
        lock = {'version': version, 'archive': archive.name, 'sha256': sha, 'files': hashes}
        destination = root / 'dist'
        if destination.exists():
            destination.rename(Path(temporary) / 'previous-dist')
        staging.rename(destination)
        previous.write_text(json.dumps(lock, indent=2, sort_keys=True) + '\n')
        (root / LOCAL_MANIFEST).unlink(missing_ok=True)
    print(f'Imported {version}: {len(hashes)} files, SHA256 {sha}')
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('zip', nargs='?', type=Path, help='Path to the Synth release ZIP')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--check', action='store_true')
    actions.add_argument('--record-local-changes', action='store_true')
    args = parser.parse_args()
    if (args.check or args.record_local_changes) and args.zip is not None:
        parser.error('choose a ZIP import, --check, or --record-local-changes')
    if not args.check and not args.record_local_changes and args.zip is None:
        parser.error('provide the ZIP path: npm run import:release -- ./xxx.zip')
    try:
        if args.check:
            lock = check(ROOT)
            manifest = local_changes(ROOT, lock)
            if manifest is None:
                print(f"Verified Synth {lock['version']}: {len(lock['files'])} files")
            else:
                print(f"Verified locally edited Synth {lock['version']}: {len(manifest['files'])} recorded local changes over SHA256 {lock['sha256']}")
        elif args.record_local_changes:
            record_local_changes(ROOT)
        else:
            import_release(ROOT, args.zip)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
