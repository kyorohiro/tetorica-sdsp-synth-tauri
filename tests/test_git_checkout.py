"""Git's Windows newline conversion must not modify the pinned Web release."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('checkout_importer', ROOT / 'scripts/import_release.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class GitCheckoutTests(unittest.TestCase):
    def test_windows_checkout_preserves_original_dist_bytes(self):
        # Use the project's actual attributes, rather than duplicating its rule
        # in the fixture. Removing/changing that rule must fail this regression.
        attributes = (ROOT / '.gitattributes').read_bytes()
        files = {
            'index.html': b'<!doctype html>\n<title>SNES SPC</title>\n',
            'sources/original-crlf.txt': b'Keep the archive\'s CRLF bytes.\r\nSecond line.\r\n',
            'generated/core.wasm': bytes(range(256)),
            'sources/音色🎵.md': '音色 🎵 — e\u0301 / 界 / \u2028\n原本のバイトを保持する\n'.encode('utf-8'),
        }
        expected = {'version': 'checkout-test', 'files': {
            name: importer.digest(data) for name, data in files.items()
        }}
        with tempfile.TemporaryDirectory(prefix='sdsp-git-checkout-') as temporary:
            source = Path(temporary) / 'source'
            checkout = Path(temporary) / 'checkout'
            source.mkdir()
            checkout.mkdir()
            (source / '.gitattributes').write_bytes(attributes)
            for name, data in files.items():
                target = source / 'dist' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            (source / 'release.lock.json').write_bytes(json.dumps(expected).encode('utf-8') + b'\n')
            (source / 'outside-dist.txt').write_bytes(b'ordinary source\nsecond line\n')

            def git(*arguments):
                return subprocess.run(['git', *arguments], cwd=source, check=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            # Populate only a disposable index. No user repository, commit,
            # global Git settings or working-tree files are changed.
            git('init', '--quiet')
            git('config', 'user.name', 'Checkout test fixture')
            git('config', 'user.email', 'checkout-test@example.invalid')
            git('config', 'commit.gpgsign', 'false')
            hooks = source / '.git' / 'disabled-test-hooks'
            hooks.mkdir()
            git('config', 'core.hooksPath', str(hooks))
            git('config', 'core.autocrlf', 'false')
            git('add', '.')
            git('config', 'core.autocrlf', 'true')
            git('checkout-index', '--all', '--force', '--prefix=' + checkout.as_posix() + '/')

            # This control proves newline conversion was actually enabled; a
            # test that checked only binary files could pass without the fix.
            self.assertEqual((checkout / 'outside-dist.txt').read_bytes(),
                             b'ordinary source\r\nsecond line\r\n')
            for name, original in files.items():
                with self.subTest(path=name):
                    self.assertEqual((checkout / 'dist' / name).read_bytes(), original)
            self.assertEqual(importer.check(checkout), expected)


if __name__ == '__main__':
    unittest.main()
