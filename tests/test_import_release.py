import importlib.util
import io
from pathlib import Path
import tempfile
import json
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('importer', Path(__file__).resolve().parents[1] / 'scripts/import_release.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def release_files(text=b'<html>test</html>'):
    files = {name: ('source fixture ' + name).encode()
             for name in importer.REQUIRED | importer.NATIVE_INPUTS}
    files.update({
        'index.html': text, 'synth-snes/index.html': text,
        'synth-snes/synth.js': b'// readable app', 'synth-snes/processor.js': b'// processor',
        'synth-snes/synth.css': b'body {}', 'js/spc.js': b'// readable wrapper',
        'generated/spc_wasm.js': b'// generated factory',
        'generated/spc_wasm.wasm': b'\x00asm\x01\x00\x00\x00',
    })
    for name in ['LICENSE', 'README.md']:
        files['licenses/snes-spc/' + name] = files['sources/third_party/snes-spc/' + name]
    def record(name):
        return {'path': name, 'bytes': len(files[name]), 'sha256': importer.digest(files[name])}
    entries = ['synth-snes/synth.js', 'synth-snes/processor.js', 'synth-snes/synth.css']
    modules = [{**record(name), 'sourcePath': 'docs/' + name, 'localImports':
                ['../generated/spc_wasm.js', '../js/spc.js'] if name.endswith('/processor.js') else []}
               for name in [*entries, 'js/spc.js']]
    original = {item['sourcePath']: files[item['path']] for item in modules}
    enclosed = io.BytesIO()
    with zipfile.ZipFile(enclosed, 'w') as archive:
        for name, data in original.items():
            archive.writestr(zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)), data)
    files['sources/sdsp-synth-browser-inputs.zip'] = enclosed.getvalue()
    files['sources/sdsp-synth-browser.json'] = json.dumps({
        'schemaVersion': 1, 'productId': 'tetorica-sdsp-synth',
        'builder': {'name': 'source-copy', 'minify': False, 'bundle': False},
        'bundles': [record(name) for name in entries], 'modules': modules,
        'originalInputs': [{'path': item['sourcePath'], 'bytes': item['bytes'], 'sha256': item['sha256']} for item in modules],
        'sourceArchive': record('sources/sdsp-synth-browser-inputs.zip'),
    }).encode()
    files['sources/SNES-SPC.json'] = json.dumps({
        'schemaVersion': 1, 'component': 'spc', 'inputs': [record(name) for name in sorted(importer.NATIVE_INPUTS)],
        # Generated records carry byte hashes without a redundant path field.
        'generated': {name: {key: value for key, value in record('generated/' + name).items() if key != 'path'}
                      for name in ['spc_wasm.js', 'spc_wasm.wasm']},
    }).encode()
    return files

def write_archive(path, files):
    with zipfile.ZipFile(path, 'w') as output:
        for name, data in files.items():
            output.writestr(name, data)


class ImportTests(unittest.TestCase):
    def test_new_zip_updates_without_version_and_preserves_label_for_same_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'any-name.zip'
            write_archive(archive, release_files(b'first'))
            first = importer.import_release(root, archive)
            first['version'] = 'named-release'
            (root / 'release.lock.json').write_text(json.dumps(first))
            self.assertEqual(importer.import_release(root, archive)['version'], 'named-release')
            write_archive(archive, release_files(b'second'))
            changed = importer.import_release(root, archive)
            self.assertNotEqual(changed['sha256'], first['sha256'])
            self.assertEqual(changed['version'], 'sha256-' + changed['sha256'][:12])
            self.assertEqual((root / 'dist/index.html').read_text(), 'second')
            self.assertEqual(importer.check(root), changed)

    def test_validated_browser_version_is_used_without_relying_on_archive_name(self):
        files = release_files()
        receipt = json.loads(files['sources/sdsp-synth-browser.json'])
        receipt['version'] = '0.0.7'
        files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); archive = root / 'unrelated-name.zip'
            write_archive(archive, files)
            self.assertEqual(importer.import_release(root, archive)['version'], '0.0.7')

    def test_invalid_replacement_preserves_dist_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'release.zip'
            write_archive(archive, release_files(b'valid'))
            first = importer.import_release(root, archive)
            write_archive(archive, {'index.html': b'wrong app'})
            with self.assertRaises(ValueError):
                importer.import_release(root, archive)
            self.assertEqual(importer.check(root), first)
            self.assertEqual((root / 'dist/index.html').read_text(), 'valid')

    def unpack(self, files):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'release.zip'
            write_archive(archive, files)
            return importer.unpack(archive, root / 'out')

    def test_preserves_all_original_bytes(self):
        files = release_files()
        self.assertEqual(self.unpack(files), {name: importer.digest(data) for name, data in files.items()})

    def test_check_detects_modified_or_extra_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'dist').mkdir()
            target = root / 'dist/index.html'
            target.write_bytes(b'original')
            (root / 'release.lock.json').write_text(json.dumps({'version': 'test', 'files': {'index.html': importer.digest(b'original')}}))
            self.assertEqual(importer.check(root)['version'], 'test')
            target.write_bytes(b'changed')
            with self.assertRaises(ValueError): importer.check(root)
            target.write_bytes(b'original')
            (root / 'dist/extra.js').write_bytes(b'extra')
            with self.assertRaises(ValueError): importer.check(root)

    def test_rejects_traversal(self):
        for name in ['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'C:/escape',
                     './index.html', 'a//b', 'a/./b', 'a\nb']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.unpack({name: b'bad'})

    def test_rejects_wrong_release_or_missing_wasm_and_sources(self):
        with self.assertRaises(ValueError): self.unpack({'index.html': b'wrong app'})
        for name in ['generated/spc_wasm.js', 'generated/spc_wasm.wasm',
                     'sources/SNES-SPC.json', 'sources/sdsp-synth-browser-inputs.zip']:
            files = release_files(); del files[name]
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)

    def test_rejects_mismatched_receipts_and_changed_native_or_browser_bytes(self):
        for name in ['generated/spc_wasm.wasm', 'synth-snes/synth.js',
                     'js/spc.js', 'sources/third_party/snes-spc/snes_spc/SPC_DSP.cpp',
                     'sources/sdsp-synth-browser-inputs.zip']:
            files = release_files(); files[name] = b'changed'
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/sdsp-synth-browser.json'])
        receipt['productId'] = 'tetorica-spu-synth'
        files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaises(ValueError): self.unpack(files)

    def test_every_readable_module_matches_its_live_bytes_and_original_input_record(self):
        files = release_files()
        receipt = json.loads(files['sources/sdsp-synth-browser.json'])
        receipt['modules'][-1]['sha256'] = '0' * 64
        files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'receipt mismatch'): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/sdsp-synth-browser.json'])
        receipt['originalInputs'][-1]['sha256'] = '0' * 64
        files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'original source'): self.unpack(files)

    def test_readable_module_graph_cannot_omit_a_dependency_or_an_entry(self):
        for omitted in ['js/spc.js', 'synth-snes/synth.js']:
            files = release_files()
            receipt = json.loads(files['sources/sdsp-synth-browser.json'])
            receipt['modules'] = [item for item in receipt['modules'] if item['path'] != omitted]
            files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
            with self.subTest(omitted=omitted), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        del files['js/spc.js']
        with self.assertRaisesRegex(ValueError, 'Missing recorded'): self.unpack(files)

    def test_sdsp_requires_lgpl_notices_and_complete_rebuild_sources(self):
        for name in ['licenses/snes-spc/LICENSE', 'licenses/snes-spc/README.md',
                     'sources/third_party/snes-spc/LICENSE',
                     'sources/scripts/build_spc_wasm.sh',
                     'sources/third_party/snes-spc/snes_spc/SNES_SPC.cpp']:
            files = release_files(); del files[name]
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/SNES-SPC.json'])
        receipt['inputs'] = [item for item in receipt['inputs'] if not item['path'].endswith('SPC_DSP.h')]
        files['sources/SNES-SPC.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'core, wrapper'): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/SNES-SPC.json']); receipt['component'] = 'gameboy_apu'
        files['sources/SNES-SPC.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'SNES SPC'): self.unpack(files)

    def test_readable_builder_and_matching_lgpl_license_copies_are_required(self):
        for builder in [None, {'name': 'esbuild', 'minify': False, 'bundle': False},
                        {'name': 'source-copy', 'minify': True, 'bundle': False},
                        {'name': 'source-copy', 'minify': False, 'bundle': True}]:
            files = release_files()
            receipt = json.loads(files['sources/sdsp-synth-browser.json']); receipt['builder'] = builder
            files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
            with self.subTest(builder=builder), self.assertRaisesRegex(ValueError, 'source-copy'):
                self.unpack(files)
        for name in ['LICENSE', 'README.md']:
            files = release_files(); files['licenses/snes-spc/' + name] = b'changed notice'
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'license notice'):
                self.unpack(files)

    def test_enclosed_browser_sources_match_every_original_input_record(self):
        for mode in ['changed', 'missing', 'extra', 'unsafe', 'duplicate']:
            files = release_files()
            receipt = json.loads(files['sources/sdsp-synth-browser.json'])
            original = {item['sourcePath']: files[item['path']] for item in receipt['modules']}
            if mode == 'changed': original['docs/synth-snes/synth.js'] = b'other original code'
            if mode == 'missing': original.pop('docs/synth-snes/synth.js')
            if mode == 'extra': original['extra.js'] = b'not recorded'
            if mode == 'unsafe': original['../escape.js'] = b'unsafe path'
            enclosed = io.BytesIO()
            with zipfile.ZipFile(enclosed, 'w') as archive:
                for name, data in original.items(): archive.writestr(name, data)
                if mode == 'duplicate':
                    with self.assertWarns(UserWarning): archive.writestr('docs/synth-snes/synth.js', b'duplicate')
            data = enclosed.getvalue(); files['sources/sdsp-synth-browser-inputs.zip'] = data
            receipt['sourceArchive'].update(bytes=len(data), sha256=importer.digest(data))
            files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
            with self.subTest(mode=mode), self.assertRaises(ValueError): self.unpack(files)

    def test_malformed_or_unsafe_module_records_are_rejected(self):
        for replacement in [[], [None], [{'path': '../escape'}]]:
            files = release_files()
            receipt = json.loads(files['sources/sdsp-synth-browser.json']); receipt['modules'] = replacement
            files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
            with self.subTest(replacement=replacement), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/sdsp-synth-browser.json'])
        receipt['modules'][0]['localImports'] = ['../../escape.js']
        files['sources/sdsp-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'Unsafe'): self.unpack(files)

    def test_rejects_duplicate_names_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); archive = root / 'release.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('index.html', b'a')
                with self.assertWarns(UserWarning): output.writestr('index.html', b'b')
            with self.assertRaisesRegex(ValueError, 'Duplicate'): importer.unpack(archive, root / 'out')
            with zipfile.ZipFile(archive, 'w') as output:
                info = zipfile.ZipInfo('link'); info.create_system = 3
                info.external_attr = 0o120777 << 16
                output.writestr(info, '../../escape')
            with self.assertRaisesRegex(ValueError, 'Unsafe'): importer.unpack(archive, root / 'out2')


if __name__ == '__main__':
    unittest.main()
